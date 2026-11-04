#!/usr/bin/env python3
"""Serve the viewer, and optionally one Mule project read-only, on 127.0.0.1.

  python3 tools/serve.py [--project /path/to/mule-app] [--port 5178]
  python3 tools/serve.py --project P --port 0 --token T --idle-exit 1800 --ready-json    (how the extension's helper starts it)

Every /api/ request must name this server in Host (DNS rebinding) and, with --token, carry the token
(X-MFV-Token header, or ?token= for download links). With --token only the API is served: the extension has the pages.

GET /api/project[?rev=]           -> {"name", "files": [project-relative paths]}
GET /api/file?path=<rel>[&rev=]   -> file text (only paths inside the project)
GET /api/branches                 -> {"current", "default", "branches": [local and remote, most recent first], "tags": [newest first],
                                     "tips": {branch or tag: sha}}
GET /api/log?from=&to=            -> {"commits": [{sha, short, author, date, subject}]}: what to has that from does not
GET /api/search?q=                -> {"hits": [{path, line, text, refs: [branch names]}], "truncated"}: q on every branch tip
GET /api/libraries[?rev=]         -> {"libraries": [{groupId, artifactId, version, available}]}: mule-plugin dependencies in pom.xml
GET /api/library?g=&a=&v=         -> {"files": {path: text}}: the Mule XML and DataWeave inside that plugin's jar in ~/.m2
GET /api/library-versions?g=&a=   -> {"versions": [...]}: the versions of a plugin in ~/.m2, oldest first
GET /api/history[?ref=&path=...]  -> {"dirty", "head", "mergeBase", "defaultHead", "ahead", "commits": [{sha, short, author, date, parents, subject, files}]}
GET /api/versions?path=<rel>      -> every version of one file: {"head": {sha, blob}, "commits": [{..., onHead, source, before, after}],
                                     "branches": [{name, sha, blob, base: {sha, blob}}], "texts": {blob: text}}; blobs are null where
                                     the file is absent; base is where the branch and HEAD split
GET  /api/dw                      -> {"available", "version"} of the local DataWeave CLI
POST /api/dw/input?ext=json       -> {"id"}: a large input saved to disk (raw body)
POST /api/dw/run                  -> {ok, output, size, truncated, outputId, ms, error}: see dw_runner.py
GET  /api/dw/output?id=           -> the full output of a run
everything else                   -> static files of this repository

rev is a commit (sha, optionally ^ or ~N); without it the working tree is read.
"""
import argparse
import concurrent.futures
import hmac
import atexit
import http.server
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile

from dw_runner import Runner

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP = {".git", "target", "node_modules", ".mule", ".idea", ".vscode", ".settings"}


def list_files(project):
    out = []
    for dirpath, dirnames, filenames in os.walk(project):
        dirnames[:] = [d for d in dirnames if d not in SKIP]
        for f in filenames:
            out.append(os.path.relpath(os.path.join(dirpath, f), project).replace(os.sep, "/"))
    return sorted(out)


def git_version():
    try:
        out = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return (0,)
    m = re.search(r"(\d+)\.(\d+)", out)
    return tuple(int(x) for x in m.groups()) if m else (0,)


# merges as their first parent sees them; git before 2.31 has no --diff-merges: walk first parents only there
MERGES = ["--diff-merges=first-parent"] if git_version() >= (2, 31) else ["--first-parent", "-m"]

REV = re.compile(r"^(HEAD|[0-9a-fA-F]{4,40})(\^|~[0-9]{0,4})?$")
HISTORY_PATHS = ["src/main/mule", "src/main/resources", "pom.xml"]


def git(project, *args):
    """stdout of a git command run in the project folder, or None when it fails."""
    try:
        r = subprocess.run(["git", "-c", "core.quotePath=false", "-C", project, *args],
                           capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


class Blobs:
    """File contents at a commit through one long-lived `git cat-file --batch` (no process per file)."""

    def __init__(self, project):
        self.project = project
        self.prefix = (git(project, "rev-parse", "--show-prefix") or "").strip()
        self.proc = None
        self.lock = threading.Lock()

    def read(self, rev, rel):
        return None if "\n" in rel else self.read_object(f"{rev}:{self.prefix}{rel}")

    def read_object(self, spec):
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                self.proc = subprocess.Popen(["git", "-C", self.project, "cat-file", "--batch"],
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            self.proc.stdin.write(f"{spec}\n".encode("utf-8"))
            self.proc.stdin.flush()
            header = self.proc.stdout.readline().decode("utf-8", "replace").split()
            if len(header) != 3:
                return None
            data = self.proc.stdout.read(int(header[2]) + 1)[:-1]
            return data.decode("utf-8", "replace") if header[1] == "blob" else None

    def resolve(self, specs, kind="blob"):
        """Object ids of `kind` for `rev:path` / `rev^{commit}` specs (None where absent), in one `git cat-file --batch-check`."""
        r = subprocess.run(["git", "-C", self.project, "cat-file", "--batch-check=%(objectname) %(objecttype)"],
                           input="".join(f"{s}\n" for s in specs).encode("utf-8"), capture_output=True, timeout=30)
        lines = r.stdout.decode("utf-8", "replace").splitlines()
        return [l.split()[0] if l.endswith(f" {kind}") else None for l in lines] + [None] * (len(specs) - len(lines))


def branches(project):
    refs = [l.split(" ", 1) for l in (git(project, "for-each-ref", "refs/heads", "refs/remotes", "--sort=-committerdate",
                                          "--format=%(objectname) %(refname:short)") or "").splitlines() if " " in l]
    refs = [(sha, n) for sha, n in refs if not n.endswith("/HEAD") and n != "origin"]
    names = [n for _, n in refs]
    tags = [l.split(" ", 1) for l in (git(project, "for-each-ref", "refs/tags", "--sort=-creatordate",
                                          "--format=%(*objectname)%(objectname) %(refname:short)") or "").splitlines() if " " in l]
    current = (git(project, "branch", "--show-current") or "").strip()
    default = (git(project, "symbolic-ref", "--short", "refs/remotes/origin/HEAD") or "").strip()
    if default.startswith("origin/") and default[7:] in names:
        default = default[7:]
    if default not in names:
        default = next((n for n in ("main", "master", "develop", "origin/main", "origin/master") if n in names), current)
    tips = {n: sha[:40] for sha, n in tags}   # annotated tags: the commit they point at comes first
    tips.update({n: sha for sha, n in refs})
    return {"current": current, "default": default, "branches": names, "tags": [n for _, n in tags], "tips": tips}


def history(project, paths, ref=""):
    """Commits of `ref` (default: the checked-out branch) touching `paths`, newest first."""
    out = git(project, "log", "-n", "300", "--relative", *MERGES, "--name-status",
              "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%s", *([ref] if ref else []), "--", *(paths or HISTORY_PATHS))
    commits = []
    for record in (out or "").split("\x1e")[1:]:
        head, _, rest = record.partition("\n")
        sha, short, author, date, parents, subject = head.split("\x1f")
        files = []
        for line in rest.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                files.append({"status": parts[0][0], "path": parts[-1]})
        commits.append({"sha": sha, "short": short, "author": author, "date": date,
                        "parents": parents.split(), "subject": subject, "files": files})
    info = branches(project)
    on_current = not ref or ref == info["current"]
    dirty = on_current and bool((git(project, "status", "--porcelain", "--", *HISTORY_PATHS) or "").strip())
    head = (git(project, "rev-parse", ref or "HEAD") or "").strip()
    target = ref or info["current"]
    merge_base = (git(project, "merge-base", info["default"], head) or "").strip() \
        if target and target != info["default"] else ""
    ahead = int((git(project, "rev-list", "--count", f"{merge_base}..{head}") or "0").strip() or 0) if merge_base else 0
    return {"dirty": dirty, "head": head, "mergeBase": merge_base or None, "ahead": ahead, "commits": commits,
            "defaultHead": info["tips"].get(info["default"])}


MERGE_BASES = {}


def merge_bases(project, head, tips):
    """Where each tip split from head; commits never change, so pairs are cached for the server's lifetime."""
    todo = [t for t in set(tips) if (head, t) not in MERGE_BASES]
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        for t, out in zip(todo, pool.map(lambda t: git(project, "merge-base", head, t), todo)):
            MERGE_BASES[(head, t)] = (out or "").strip() or None
    return [MERGE_BASES[(head, t)] for t in tips]


ZERO = re.compile(r"^0+$")
MAX_VERSIONS = 400


def versions(project, blobs, rel):
    """Commits on any branch that changed `rel` (blob before and after), each branch's copy, and their texts."""
    out = git(project, "log", "--branches", "--remotes", "-n", "300", "--source", "--relative", "--raw", "--no-abbrev",
              *MERGES, "--format=%x1e%H%x1f%an%x1f%aI%x1f%P%x1f%S%x1f%s", "--", rel)
    on_head = set((git(project, "rev-list", "-n", "2000", "HEAD", "--", rel) or "").split())
    commits = []
    for record in (out or "").split("\x1e")[1:]:
        head, _, rest = record.partition("\n")
        sha, author, date, parents, source, subject = head.split("\x1f")
        raw = next((l for l in rest.splitlines() if l.startswith(":")), None)
        if not raw:
            continue
        before, after = raw.split()[2:4]
        commits.append({"sha": sha, "short": sha[:7], "author": author, "date": date, "parents": parents.split(),
                        "subject": subject, "onHead": sha in on_head, "source": re.sub(r"^refs/(heads|remotes)/", "", source),
                        "before": None if ZERO.match(before) else before, "after": None if ZERO.match(after) else after})
    info = branches(project)
    names = info["branches"]
    head = (git(project, "rev-parse", "HEAD") or "").strip()
    tips = [info["tips"][n] for n in names]
    bases = merge_bases(project, head, tips)
    files = blobs.resolve([f"{n}:{blobs.prefix}{rel}" for n in [head, *tips, *(b or head for b in bases)]])
    head_blob, files, base_files = files[0], files[1:len(tips) + 1], files[len(tips) + 1:]
    texts = {}
    for blob in [head_blob, *files, *base_files, *(b for c in commits for b in (c["before"], c["after"]))]:
        if blob and blob not in texts and len(texts) < MAX_VERSIONS:
            texts[blob] = blobs.read_object(blob)
    return {"head": {"sha": head, "blob": head_blob},
            "branches": [{"name": n, "sha": t, "blob": b, "base": {"sha": m, "blob": mb if m else None}}
                         for n, t, b, m, mb in zip(names, tips, files, bases, base_files)],
            "commits": commits, "texts": texts}


def log_between(project, a, b):
    out = git(project, "log", "-n", "500", "--format=%H%x1f%an%x1f%aI%x1f%s", f"{a}..{b}", "--", *HISTORY_PATHS)
    commits = []
    for line in (out or "").splitlines():
        sha, author, date, subject = line.split("\x1f", 3)
        commits.append({"sha": sha, "short": sha[:7], "author": author, "date": date, "subject": subject})
    return {"commits": commits}


SEARCH_PATHS = ["src/main", "src/test", "pom.xml"]
MAX_HITS = 500
TREES = {}      # tip sha -> [(blob, path)]; commits never change
TEXTS = {}      # blob -> text


def search(project, blobs, q):
    """Lines containing q (any case) on every branch tip. Each distinct version of a file is read and searched once,
    so 80 branches that share most files cost little more than one."""
    info = branches(project)
    files = {}      # (blob, path) -> [branch names]
    for name in info["branches"]:
        tip = info["tips"][name]
        if tip not in TREES:
            out = git(project, "ls-tree", "-r", tip, "--", *SEARCH_PATHS) or ""
            TREES[tip] = [(l.split()[2], l.split("\t", 1)[1]) for l in out.splitlines() if " blob " in l]
        for entry in TREES[tip]:
            files.setdefault(entry, []).append(name)
    needle = q.lower()
    hits = {}
    for (blob, path), refs in files.items():
        if blob not in TEXTS:
            TEXTS[blob] = blobs.read_object(blob) or ""
        text = TEXTS[blob]
        if needle not in text.lower():
            continue
        for n, line in enumerate(text.split("\n"), 1):
            if needle in line.lower():
                hit = hits.setdefault((path, line.strip()), {"path": path, "line": n, "text": line.strip()[:300], "refs": set()})
                hit["refs"].update(refs)
    order = sorted(hits.values(), key=lambda h: (h["path"], h["line"]))
    for h in order:
        h["refs"] = [b for b in info["branches"] if b in h["refs"]]
    return {"hits": order[:MAX_HITS], "truncated": len(order) > MAX_HITS}


M2 = os.path.expanduser(os.environ.get("MAVEN_REPO", "~/.m2/repository"))
MAVEN = "{http://maven.apache.org/POM/4.0.0}"


def libraries(text):
    """mule-plugin dependencies of a pom.xml, with ${...} resolved from its own properties."""
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    ns = MAVEN if root.tag.startswith(MAVEN) else ""
    find = lambda el, tag: (el.findtext(f"{ns}{tag}") or "").strip()
    props = {"project.groupId": find(root, "groupId"), "project.version": find(root, "version")}
    properties = root.find(f"{ns}properties")
    for el in list(properties) if properties is not None else []:
        props[el.tag.split("}")[-1]] = (el.text or "").strip()
    resolve = lambda v: re.sub(r"\$\{([^}]+)\}", lambda m: props.get(m.group(1), m.group(0)), v)
    out = []
    for dep in root.iter(f"{ns}dependency"):
        if find(dep, "classifier") != "mule-plugin":
            continue
        g, a, v = resolve(find(dep, "groupId")), resolve(find(dep, "artifactId")), resolve(find(dep, "version"))
        out.append({"groupId": g, "artifactId": a, "version": v, "available": bool(jar_path(g, a, v))})
    return out


SAFE = re.compile(r"^[\w.\-]{1,120}$")


def jar_path(g, a, v):
    if not (SAFE.match(g) and SAFE.match(a) and SAFE.match(v)):
        return None
    path = os.path.join(M2, *g.split("."), a, v, f"{a}-{v}-mule-plugin.jar")
    return path if os.path.isfile(path) else None


def version_key(v):
    return [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.split(r"[.\-]", v)]


def library_versions(g, a):
    if not (SAFE.match(g) and SAFE.match(a)):
        return []
    folder = os.path.join(M2, *g.split("."), a)
    found = [v for v in (os.listdir(folder) if os.path.isdir(folder) else []) if jar_path(g, a, v)]
    return sorted(found, key=version_key)


def library_files(g, a, v):
    path = jar_path(g, a, v)
    if not path:
        return None
    files = {}
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.startswith("META-INF/") or name == "log4j2.xml" or not name.endswith((".xml", ".dwl")):
                continue
            if z.getinfo(name).file_size < 2_000_000:
                files[name] = z.read(name).decode("utf-8", "replace")
    return {"files": files}


def make_handler(project, runner, state):
    """state: {"hosts": names this server answers to, set once it is bound; "token"; "last": time of the last request}"""
    blobs = Blobs(project) if project else None
    token = state.get("token")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            origin = self.headers.get("Origin") or ""
            if token and origin.startswith("chrome-extension://"):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Headers", "X-MFV-Token, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
            super().end_headers()

        def do_OPTIONS(self):
            self.send_response(204 if self.headers.get("Host") in state["hosts"] else 403)
            self.end_headers()

        def _send(self, status, body, ctype):
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _allowed(self, url):
            """Host must be this server (a rebound DNS name is not); with a token, the token; without, same origin."""
            state["last"] = time.monotonic()
            hosts = state["hosts"]
            if self.headers.get("Host") not in hosts:
                return False
            origin = self.headers.get("Origin")
            if token:
                given = self.headers.get("X-MFV-Token") or urllib.parse.parse_qs(url.query).get("token", [""])[0]
                return hmac.compare_digest(given.encode(), token.encode())
            return not origin or urllib.parse.urlparse(origin).netloc in hosts

        def do_POST(self):
            url = urllib.parse.urlparse(self.path)
            if not self._allowed(url):
                return self._send(403, "forbidden", "text/plain")
            length = int(self.headers.get("Content-Length") or 0)
            if url.path == "/api/dw/input" and self.headers.get("Content-Type") == "application/octet-stream":
                ext = urllib.parse.parse_qs(url.query).get("ext", ["txt"])[0]
                return self._send(200, json.dumps({"id": runner.save_upload(self.rfile, length, ext)}), "application/json")
            if url.path == "/api/dw/run" and self.headers.get("Content-Type", "").startswith("application/json"):
                try:
                    req = json.loads(self.rfile.read(length))
                except ValueError:
                    return self._send(400, "bad request", "text/plain")
                return self._send(200, json.dumps(runner.run(req)), "application/json")
            return self._send(404, "not found", "text/plain")

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            if not url.path.startswith("/api/"):
                if token or self.headers.get("Host") not in state["hosts"]:
                    return self._send(404, "not found", "text/plain")
                return super().do_GET()
            if not self._allowed(url):
                return self._send(403, "forbidden", "text/plain")
            if url.path == "/api/dw":
                return self._send(200, json.dumps(runner.info()), "application/json")
            if url.path == "/api/dw/output":
                path = runner.file(urllib.parse.parse_qs(url.query).get("id", [""])[0])
                if not path:
                    return self._send(404, "not found", "text/plain")
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(os.path.getsize(path)))
                self.send_header("Content-Disposition", 'attachment; filename="dataweave-output.txt"')
                self.end_headers()
                with open(path, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            query = urllib.parse.parse_qs(url.query)
            rev = query.get("rev", [""])[0]
            if not project or (rev and not REV.match(rev)):
                return self._send(404, "not found", "text/plain")
            if url.path == "/api/project":
                if rev:
                    listing = git(project, "ls-tree", "-r", "--name-only", "-z", rev)
                    files = sorted(f for f in (listing or "").split("\0") if f)
                else:
                    files = list_files(project)
                body = json.dumps({"name": os.path.basename(project.rstrip("/")), "files": files})
                return self._send(200, body, "application/json")
            if url.path == "/api/branches":
                return self._send(200, json.dumps(branches(project)), "application/json")
            if url.path == "/api/history":
                paths = [p for p in query.get("path", []) if p and not p.startswith(("-", "/")) and ".." not in p]
                ref = query.get("ref", [""])[0]
                if ref and ref not in branches(project)["branches"]:
                    return self._send(404, "unknown branch", "text/plain")
                return self._send(200, json.dumps(history(project, paths, ref)), "application/json")
            if url.path == "/api/log":
                a, b = query.get("from", [""])[0], query.get("to", [""])[0]
                if not (REV.match(a) and REV.match(b)):
                    return self._send(404, "not found", "text/plain")
                return self._send(200, json.dumps(log_between(project, a, b)), "application/json")
            if url.path == "/api/search":
                q = query.get("q", [""])[0]
                if not 2 <= len(q) <= 200 or "\n" in q:
                    return self._send(400, "bad query", "text/plain")
                return self._send(200, json.dumps(search(project, blobs, q)), "application/json")
            if url.path == "/api/libraries":
                text = blobs.read(rev, "pom.xml") if rev else open(os.path.join(project, "pom.xml"), encoding="utf-8").read() \
                    if os.path.isfile(os.path.join(project, "pom.xml")) else ""
                return self._send(200, json.dumps({"libraries": libraries(text or "")}), "application/json")
            if url.path == "/api/library-versions":
                found = library_versions(query.get("g", [""])[0], query.get("a", [""])[0])
                return self._send(200, json.dumps({"versions": found}), "application/json")
            if url.path == "/api/library":
                body = library_files(*(query.get(k, [""])[0] for k in ("g", "a", "v")))
                return self._send(200, json.dumps(body), "application/json") if body else self._send(404, "not found", "text/plain")
            if url.path == "/api/merge-base":
                a, b = query.get("a", [""])[0], query.get("b", [""])[0]
                if not (REV.match(a) and REV.match(b)):
                    return self._send(404, "not found", "text/plain")
                return self._send(200, json.dumps({"base": merge_bases(project, a, [b])[0]}), "application/json")
            if url.path == "/api/versions":
                rel = query.get("path", [""])[0]
                if not rel or rel.startswith(("-", "/")) or ".." in rel or "\n" in rel:
                    return self._send(404, "not found", "text/plain")
                return self._send(200, json.dumps(versions(project, blobs, rel)), "application/json")
            if url.path == "/api/file":
                rel = query.get("path", [""])[0]
                full = os.path.realpath(os.path.join(project, rel))
                if not full.startswith(os.path.realpath(project) + os.sep):
                    return self._send(404, "not found", "text/plain")
                if rev:
                    text = blobs.read(rev, os.path.relpath(full, os.path.realpath(project)).replace(os.sep, "/"))
                    return self._send(200, text, "text/plain; charset=utf-8") if text is not None \
                        else self._send(404, "not found", "text/plain")
                if not os.path.isfile(full):
                    return self._send(404, "not found", "text/plain")
                with open(full, encoding="utf-8", errors="replace") as f:
                    return self._send(200, f.read(), "text/plain; charset=utf-8")
            return self._send(404, "not found", "text/plain")

        def log_message(self, fmt, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=os.environ.get("MULE_PROJECT"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5178")))
    ap.add_argument("--dw-heap", help="max heap for DataWeave runs, e.g. 8g (default: the CLI's, sized from RAM)")
    ap.add_argument("--dw-timeout", type=int, default=120, help="seconds before a DataWeave run is stopped")
    ap.add_argument("--token", default=os.environ.get("MFV_TOKEN"), help="require this token on every API request")
    ap.add_argument("--idle-exit", type=int, default=0, help="stop after this many seconds without requests (0: never)")
    ap.add_argument("--ready-json", action="store_true", help='print {"port", "pid"} as the first line once listening')
    args = ap.parse_args()
    project = os.path.abspath(args.project) if args.project else None
    runner = Runner(args.dw_heap, args.dw_timeout)
    atexit.register(runner.close)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    state = {"hosts": set(), "token": args.token, "last": time.monotonic()}
    # a project's files are read all at once: room for that many waiting connections (the default is 5)
    http.server.ThreadingHTTPServer.request_queue_size = 128
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(project, runner, state))
    port = server.server_address[1]
    state["hosts"] = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if args.idle_exit:
        def watch():
            while time.monotonic() - state["last"] < args.idle_exit:
                time.sleep(15)
            runner.close()
            os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    if args.ready_json:
        print(json.dumps({"port": port, "pid": os.getpid()}), flush=True)
    else:
        print(f"http://127.0.0.1:{port}/viewer/" + (f"  (project: {project})" if project else ""), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
