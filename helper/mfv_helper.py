#!/usr/bin/env python3
"""Mule Flow Viewer's local helper: the native messaging host Chrome starts for the extension.

It finds the local clone of the repository a page shows (by matching the page's URL against each clone's remotes,
no rules per code host), starts tools/serve.py for the Mule project in it on 127.0.0.1 with a random token, and
answers {base, token}. The server runs on this machine's CPU and memory, outlives this process, and stops itself
after 30 idle minutes. Messages (JSON, framed as Chrome's native messaging: 4-byte length, little endian):

  {"type": "ping"}                                  -> {ok, version, python, git, dw}
  {"type": "open", "url", "title"?, "text"?, "roots"?: []}   -> {ok, base, token, project, repo} | {ok: false, error, message}
  {"type": "clone", "url", "into"}                  -> {ok, repo} | {ok: false, error, message}
  {"type": "dw"}                                    -> {ok, base, token}: a server for running DataWeave only (pages the
                                                       viewer reads from the code host itself)

roots: folders to look for clones in (default: the home folder). With no clone there, the helper makes its own copy
in ~/.mule-flow-viewer/copies from the repository's remote and serves that ("copy": true). Nothing here reads credentials: cloning and
fetching use git as the user has set it up.
"""
import json
import os
import re
import secrets
import shutil
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request

VERSION = "0.1.0"
HERE = os.path.dirname(os.path.abspath(__file__))
SERVE = next((p for p in (os.path.join(HERE, "serve.py"), os.path.join(HERE, "..", "tools", "serve.py")) if os.path.isfile(p)), None)
STATE = os.path.join(os.path.expanduser("~"), ".mule-flow-viewer")
SKIP = {"node_modules", "target", "Library", "AppData", "Applications", "Pictures", "Music", "Movies", "venv", ".venv",
        "__pycache__", "dist", "build"}
SCAN_DEPTH = 5
IDLE_EXIT = 1800
CACHE_AGE = 24 * 3600
FETCH_AGE = 300       # fetch the clone when its last fetch by the helper is older than this


# ------------------------------------------------------------------ native messaging

def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    return json.loads(sys.stdin.buffer.read(struct.unpack("<I", raw)[0]).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


# ------------------------------------------------------------------ environment

def setup_path():
    """Chrome starts hosts with a bare PATH (no Homebrew, no user bins): add the PATH the installer saw, and the usual places."""
    saved = load_json(os.path.join(STATE, "config.json")).get("path", "")
    extra = [saved, "/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.local/bin"), os.path.expanduser("~/bin")]
    os.environ["PATH"] = os.pathsep.join([p for p in extra if p] + [os.environ.get("PATH", "")])


def tool_version(cmd, pattern):
    exe = shutil.which(cmd)
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(pattern, out)
    return m.group(1) if m else "unknown"


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def git(cwd, *args, timeout=30):
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}   # never wait for a password prompt nobody can see
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")   # nor for an SSH passphrase (an ssh-agent still works)
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    return (r.stdout if r.returncode == 0 else None), r.stderr.strip()


# ------------------------------------------------------------------ finding the clone

def url_tokens(url):
    """host labels and path segments of a web or remote URL, lower case: https://h/a/b.git, git@h:a/b, ssh://u@h:22/a/b"""
    u = urllib.parse.unquote(url.strip()).lower()
    u = re.sub(r"^[a-z+]+://", "", u)
    u = re.sub(r"^[^/@]+@", "", u)            # user@ (git@, org@ in some hosts' ssh URLs)
    u = u.split("?", 1)[0].split("#", 1)[0]
    host, _, path = re.split(r"([/:])", u, 1) if re.search(r"[/:]", u) else (u, "", "")
    host = re.sub(r":\d+$", "", host)
    segs = [s[:-4] if s.endswith(".git") else s for s in re.split(r"[/:]", path) if s and not s.isdigit()]
    labels = [l for l in host.split(".") if l not in ("www", "com", "org", "net", "io")]
    return labels, segs


def match_score(remote, page):
    """How well a clone's remote fits a page: its repository name must be a segment of the page's path, then every
    other part of the remote (owner, group, project; host labels count too) found on the page adds to the score."""
    r_labels, r_segs = url_tokens(remote)
    p_labels, p_segs = url_tokens(page)
    if not r_segs or r_segs[-1] not in p_segs:
        return 0
    page_all = set(p_labels) | set(p_segs)
    owners = [t for t in r_segs[:-1] if len(t) > 2]          # owner, group, project: what tells same-named repos apart
    owner_hits = sum(1 for t in owners if t in page_all)
    if owners and not owner_hits:
        return 0       # same repository name, different owner: someone else's repository
    host_hits = sum(1 for t in r_labels if len(t) > 2 and t in page_all)
    return 10 + 3 * owner_hits + host_hits


def remotes_of(repo):
    """Remote URLs, read from .git/config without starting git (worktrees: their git dir's config)."""
    git_path = os.path.join(repo, ".git")
    config = os.path.join(git_path, "config")
    if os.path.isfile(git_path):
        with open(git_path, encoding="utf-8", errors="replace") as f:
            m = re.match(r"gitdir:\s*(.+)", f.read().strip())
        if m:
            gitdir = os.path.normpath(os.path.join(repo, m.group(1)))
            common = os.path.join(gitdir, "commondir")
            if os.path.isfile(common):
                with open(common, encoding="utf-8") as f:
                    gitdir = os.path.normpath(os.path.join(gitdir, f.read().strip()))
            config = os.path.join(gitdir, "config")
    try:
        with open(config, encoding="utf-8", errors="replace") as f:
            # the whole value: Azure DevOps remotes may hold a literal space ("CCP Development")
            return [u.strip().strip('"') for u in re.findall(r"^\s*url\s*=\s*(.+?)\s*$", f.read(), re.M)]
    except OSError:
        return []


def git_dir(repo):
    path = os.path.join(repo, ".git")
    if os.path.isfile(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            m = re.match(r"gitdir:\s*(.+)", f.read().strip())
        return os.path.normpath(os.path.join(repo, m.group(1))) if m else path
    return path


def last_used(repo):
    """When the clone was last worked in: its index changes on checkout, commit, add and pull."""
    try:
        return os.path.getmtime(os.path.join(git_dir(repo), "index"))
    except OSError:
        return 0


def on_page_branch(repo, url):
    """Whether the clone has checked out the branch the page names (e.g. a pull request's or a file view's)."""
    try:
        with open(os.path.join(git_dir(repo), "HEAD"), encoding="utf-8") as f:
            head = f.read().strip()
    except OSError:
        return False
    branch = head[len("ref: refs/heads/"):] if head.startswith("ref: refs/heads/") else ""
    page = urllib.parse.unquote(url)
    return bool(branch) and re.search(rf"(^|[/=?&#:]|GB){re.escape(branch)}($|[/?&#])", page) is not None


def scan(roots):
    """Git repositories under the roots (not inside other repositories), with their remotes."""
    found = []
    for root in roots:
        root = os.path.expanduser(root)
        if not os.path.isdir(root):
            continue
        base_depth = root.rstrip(os.sep).count(os.sep)
        for dirpath, dirnames, _ in os.walk(root):
            if os.path.exists(os.path.join(dirpath, ".git")):
                found.append({"path": dirpath, "remotes": remotes_of(dirpath)})
                dirnames[:] = []
                continue
            if dirpath.count(os.sep) - base_depth >= SCAN_DEPTH:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP]
    return found


def best_match(repos, url):
    scored = [(max((match_score(r, url) for r in repo["remotes"]), default=0), repo) for repo in repos]
    scored = [s for s in scored if s[0] and os.path.isdir(s[1]["path"])]
    if not scored:
        return None
    top = max(s[0] for s in scored)
    # several clones of the same repository: the one on the page's branch, else the one used most recently
    return max((s[1] for s in scored if s[0] == top), key=lambda repo: (on_page_branch(repo["path"], url), last_used(repo["path"])))


def find_repo(url, roots):
    """The best-matching clone for a page, from the cache when it has one, else after a fresh scan."""
    cache_path = os.path.join(STATE, "repos.json")
    cache = load_json(cache_path)
    key = json.dumps(sorted(roots))

    if cache.get("roots") == key and time.time() - cache.get("time", 0) < CACHE_AGE:
        hit = best_match(cache["repos"], url)
        if hit:
            return hit
    repos = scan(roots)
    save_json(cache_path, {"roots": key, "time": time.time(), "repos": repos})
    return best_match(repos, url)


def mule_project(repo, url):
    """The Mule application in a repository: its own folder, or the one (of several) whose path the page names."""
    apps = []
    for dirpath, dirnames, filenames in os.walk(repo):
        rel = os.path.relpath(dirpath, repo)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if "pom.xml" in filenames and ("mule-artifact.json" in filenames or os.path.isdir(os.path.join(dirpath, "src", "main", "mule"))):
            apps.append("" if rel == "." else rel.replace(os.sep, "/"))
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP and depth < 3]
    if not apps:
        return None
    page = urllib.parse.unquote(url)
    named = [a for a in apps if a and f"/{a}/" in page]
    pick = max(named, key=len) if named else min(apps, key=len)
    return os.path.join(repo, pick) if pick else repo


# ------------------------------------------------------------------ servers

def alive(entry):
    try:
        req = urllib.request.Request(f"{entry['base']}/api/dw", headers={"X-MFV-Token": entry["token"]})
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status == 200
    except OSError:
        return False


def start_server(project):
    """A running server for the project (None: DataWeave only): the one started before if it still answers, else a new one."""
    reg_path = os.path.join(STATE, "servers.json")
    reg = load_json(reg_path)
    key = project or "(dataweave)"
    entry = reg.get(key)
    if entry and alive(entry):
        return entry
    token = secrets.token_urlsafe(24)
    os.makedirs(STATE, exist_ok=True)
    log = open(os.path.join(STATE, "server.log"), "ab")
    kwargs = {"start_new_session": True} if os.name != "nt" else \
        {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
    proc = subprocess.Popen(
        [sys.executable, SERVE, *([f"--project={project}"] if project else []), "--port", "0",
         # one argument each: a token can start with "-", which would read as an option
         f"--token={token}",
         "--idle-exit", str(IDLE_EXIT), "--ready-json"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log, **kwargs)
    line = proc.stdout.readline().decode("utf-8", "replace")
    try:
        ready = json.loads(line)
    except ValueError:
        raise RuntimeError(f"The server did not start; see {os.path.join(STATE, 'server.log')}")
    entry = {"base": f"http://127.0.0.1:{ready['port']}", "token": token, "pid": ready["pid"]}
    reg[key] = entry
    save_json(reg_path, reg)
    return entry


# ------------------------------------------------------------------ commands

def fetch(repo):
    """Remote branches as they are now (a pull request's branch may be new), at most every few minutes.
    Uses git as the user has set it up; offline or a sign-in prompt only means the last fetch's branches."""
    if os.environ.get("MFV_NO_FETCH"):
        return {"fetched": "off"}
    stamps_path = os.path.join(STATE, "fetched.json")
    stamps = load_json(stamps_path)
    if time.time() - stamps.get(repo, 0) < FETCH_AGE:
        return {"fetched": "recently"}
    out, err = git(repo, "fetch", "--all", "--quiet", timeout=45)
    if out is None:
        return {"fetched": False, "fetchError": (err or "")[-300:]}
    stamps[repo] = time.time()
    save_json(stamps_path, stamps)
    return {"fetched": True}


def handle(msg):
    kind = msg.get("type")
    if kind == "ping":
        return {"ok": True, "version": VERSION, "python": sys.version.split()[0],
                "git": tool_version("git", r"git version (\S+)"),
                "dw": tool_version("dw", r"Command Line\s*:\s*V?(\S+)") or tool_version("dw", r"(\d+\.\d+\.\d+)")}
    if kind == "open":
        url = msg.get("url") or ""
        roots = [r for r in (msg.get("roots") or []) if isinstance(r, str) and r.strip()] or [os.path.expanduser("~")]
        if not shutil.which("git"):
            return {"ok": False, "error": "no-git", "message": "git is not installed or not on PATH."}
        repo = find_repo(url, roots)
        own = None
        if not repo:
            own = own_copy(url)
            if not own.get("ok"):
                return {**own, "roots": roots}
            repo = {"path": own["repo"]}
        if own:
            fetched = {"fetched": True} if own.get("new") else fetch(repo["path"])
            follow_page(repo["path"], url, msg.get("text") or "")
        project = mule_project(repo["path"], url)
        if not project:
            return {"ok": False, "error": "no-mule", "repo": repo["path"],
                    "message": "The repository has no Mule application (a pom.xml with src/main/mule)."}
        if not own:
            fetched = fetch(repo["path"])
        entry = start_server(project)
        return {"ok": True, "base": entry["base"], "token": entry["token"], "project": project, "repo": repo["path"],
                "copy": bool(own), **fetched}
    if kind == "dw":
        entry = start_server(None)
        return {"ok": True, "base": entry["base"], "token": entry["token"]}
    if kind == "clone":
        return clone(msg.get("url") or "", msg.get("into") or "")
    return {"ok": False, "error": "unknown", "message": f"Unknown request {kind!r}"}


def sibling_remotes(url):
    """Clone addresses for the page's repository built from clones you already have of the same owner/project:
    their remote with the last segment swapped for a name from the page. Same protocol and sign-in as those
    (SSH, usually), so it works where an https clone would need a password. Returns [(remote, folder of the sibling)]."""
    repos = load_json(os.path.join(STATE, "repos.json")).get("repos", [])
    p_labels, p_segs = url_tokens(url)
    page_all = set(p_labels) | set(p_segs)
    raw = [s for s in re.split(r"[/?#&=]", urllib.parse.unquote(url.split("://", 1)[-1].split("?", 1)[0])) if s][1:]
    names = [s for s in raw if len(s) > 2 and not s.isdigit()]
    found = {}
    for repo in repos:
        used = last_used(repo["path"])
        for remote in repo["remotes"]:
            _, r_segs = url_tokens(remote)
            owners = [t for t in r_segs[:-1] if len(t) > 2]
            if not owners or not all(t in page_all for t in owners):
                continue
            last = re.split(r"[/:]", remote.rstrip("/"))[-1]
            for name in names:
                if name.lower() in owners or name.lower() == r_segs[-1]:
                    continue
                # the page's name most like the sibling's (orders-sapi next to orders-eapi) first
                alike = len(os.path.commonprefix([name.lower(), r_segs[-1]]))
                cand = remote[: len(remote) - len(last)] + name + (".git" if last.endswith(".git") else "")
                rank = (alike, used)
                if cand not in found or rank > found[cand][0]:
                    found[cand] = (rank, os.path.dirname(repo["path"]))
    ranked = sorted(found.items(), key=lambda kv: kv[1][0], reverse=True)
    return [(cand, near) for cand, (_, near) in ranked[:4]]


def find_remote(url):
    """The page's repository as git can reach it, without host rules: first an address built from your clones of the
    same owner/project (same protocol and sign-in), then the page URL cut back segment by segment (code hosts serve
    git at the repository's web address). Returns (remote, folder of the sibling clone or None, tried) or (None, None, tried)."""
    m = re.match(r"^(https?://[^/?#]+)(/[^?#]*)", url)
    if not m:
        return None, None, []
    host, path = m.groups()
    segs = [s for s in path.split("/") if s]
    candidates = sibling_remotes(url) + [(f"{host}/{'/'.join(segs[:n])}", None) for n in range(2, min(len(segs), 7) + 1)]
    tried = []
    for candidate, near in candidates:
        tried.append(candidate)
        out, _ = git(None, "ls-remote", "--heads", candidate, timeout=20)
        if out is not None:
            return candidate, near, tried
    return None, None, tried


def repo_name(remote):
    return urllib.parse.unquote(re.sub(r"\.git$", "", re.split(r"[/:]", remote.rstrip("/"))[-1]))


def git_clone(folder, remote, name):
    # a full clone: Mule repositories are small, and partial clones are refused by some hosts only after minutes
    return git(folder, "clone", "--no-checkout", remote, name, timeout=900)


NO_REMOTE = "git could not reach this repository with your sign-in (SSH key or credential helper). Clone it once yourself, then try again."


def clone(url, into):
    """Clone the page's repository where you can work in it: next to your clones of the same owner unless `into` says else."""
    remote, near, tried = find_remote(url)
    if not remote:
        return {"ok": False, "error": "no-remote", "tried": tried, "message": NO_REMOTE}
    folder = os.path.expanduser(into or near or os.path.join("~", "mule-flow-viewer-repos"))
    target = os.path.join(folder, repo_name(remote))
    if os.path.exists(target):
        return {"ok": False, "error": "exists", "message": f"{target} already exists."}
    os.makedirs(folder, exist_ok=True)
    done, err = git_clone(folder, remote, repo_name(remote))
    if done is None:
        return {"ok": False, "error": "clone-failed", "message": err[-400:]}
    git(target, "checkout", timeout=120)
    return {"ok": True, "repo": target, "remote": remote}


# ------------------------------------------------------------------ the helper's own copies

COPIES = os.path.join(STATE, "copies")
COPY_AGE = 30 * 24 * 3600     # copies not opened for this long are removed


def own_copy(url):
    """For a page whose repository you have no clone of: the helper's own copy of it, made from the remote the first
    time (with your git sign-in) and fetched after. Kept apart from your clones, never edited, so it can follow
    whatever branch a page shows."""
    stamps_path = os.path.join(STATE, "copies.json")
    stamps = load_json(stamps_path)
    for path, used in list(stamps.items()):
        if time.time() - used > COPY_AGE:
            shutil.rmtree(path, ignore_errors=True)
            stamps.pop(path)
    hit = best_match(scan([COPIES]), url) if os.path.isdir(COPIES) else None
    new = False
    if not hit:
        remote, _, tried = find_remote(url)
        if not remote:
            return {"ok": False, "error": "no-remote", "tried": tried, "message": NO_REMOTE}
        name = repo_name(remote)
        folder = os.path.join(COPIES, f"{re.sub(r'[^A-Za-z0-9._-]+', '-', name)}-{secrets.token_hex(3)}")
        os.makedirs(folder)
        done, err = git_clone(folder, remote, name)
        if done is None:
            shutil.rmtree(folder, ignore_errors=True)
            return {"ok": False, "error": "clone-failed", "message": err[-400:]}
        hit, new = {"path": os.path.join(folder, name)}, True
    stamps[hit["path"]] = time.time()
    save_json(stamps_path, stamps)
    return {"ok": True, "repo": hit["path"], "new": new}


def has_mule_app(repo, ref):
    out, _ = git(repo, "ls-tree", "-r", "--name-only", ref, timeout=30)
    files = (out or "").splitlines()
    return any(f == "pom.xml" or f.endswith("/pom.xml") for f in files) and any("src/main/mule/" in f for f in files)


def follow_page(repo, url, text=""):
    """Check out, in one of the helper's own copies, the branch the page shows: named in its URL (a file view), else
    in its text (a pull request's "feature/x into main", first named first), else the default branch; of those, the
    first that holds a Mule application, else the newest branch that does."""
    out, _ = git(repo, "for-each-ref", "refs/remotes/origin", "--sort=-committerdate", "--format=%(refname:lstrip=3)")
    names = [n for n in (out or "").split() if n != "HEAD"]
    page = urllib.parse.unquote(url)
    word = lambda n: rf"(^|[\s/=?&#:'\"(\[]|GB){re.escape(n)}($|[\s/?&#'\")\],.:])"
    in_url = sorted((n for n in names if re.search(word(n), page)), key=len, reverse=True)
    at = {n: m.start() for n in names if (m := re.search(word(n), text or ""))}
    in_text = sorted(at, key=lambda n: (at[n], -len(n)))
    head, _ = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    default = [(head or "").strip()[len("origin/"):]]
    order = list(dict.fromkeys([n for n in in_url + in_text + default + names if n]))
    branch = next((n for n in order if has_mule_app(repo, f"origin/{n}")), order[0] if order else "")
    if branch:
        git(repo, "checkout", "--force", "-B", branch, f"origin/{branch}", timeout=120)
    return branch


def main():
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    setup_path()
    while True:
        msg = read_message()
        if msg is None:
            return
        try:
            send_message(handle(msg))
        except Exception as e:          # an answer beats a silent hang in the extension
            send_message({"ok": False, "error": "helper", "message": str(e)})


if __name__ == "__main__":
    main()
