#!/usr/bin/env python3
"""A stand-in for the part of Azure DevOps' REST API (7.1) that src/adapters/azure-devops.js calls, answered from
local clones, for tests of the browser-only reader with real Mule projects:

  python3 tools/mock_azure.py --port 0 --org ORG --project PROJECT [--pr ID=source:target] repo-path [repo-path ...]

Prints {"port"} when ready. The repository name is the folder name; branches are the clone's remote branches (and
its local ones). Shapes follow what dev.azure.com answers (checked against a public project).
"""
import argparse
import http.server
import json
import os
import re
import subprocess
import urllib.parse


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, "-c", "core.quotePath=false", *args], capture_output=True, timeout=60)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


def branches(repo):
    out = git(repo, "for-each-ref", "refs/remotes/origin", "refs/heads", "--format=%(objectname) %(refname)") or ""
    found = {}
    for line in out.splitlines():
        sha, ref = line.split(" ", 1)
        name = re.sub(r"^refs/(remotes/origin|heads)/", "", ref)
        if name != "HEAD" and name not in found:
            found[name] = sha
    return found


def default_branch(repo, names):
    head = (git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD") or "").strip()
    head = head[len("origin/"):] if head.startswith("origin/") else head
    return head if head in names else next((n for n in ("main", "master", "develop") if n in names), sorted(names)[0])


def rev_of(repo, version, kind):
    if kind == "commit":
        return version
    return branches(repo).get(version) or version


def commit_json(repo, sha, change_count=0):
    out = git(repo, "show", "-s", "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%cn%x1f%cI%x1f%B", sha)
    if not out:
        return None
    h, parents, an, ad, cn, cd, body = out.split("\x1f", 6)
    c = {"commitId": h, "parents": parents.split(), "author": {"name": an, "date": ad}, "committer": {"name": cn, "date": cd},
         "comment": body.strip()}
    if change_count:
        args = ["diff-tree", "-r", "--raw", "--no-abbrev", "--no-renames"]
        args += [parents.split()[0], h] if parents else ["--root", h]
        changes = []
        for line in (git(repo, *args) or "").splitlines():
            if not line.startswith(":"):
                continue
            meta, path = line.split("\t", 1)
            _, _, before, after, status = meta[1:].split()
            kind = {"A": "add", "D": "delete"}.get(status[0], "edit")
            item = {"objectId": after if kind != "delete" else before, "gitObjectType": "blob", "path": "/" + path}
            if kind == "edit":
                item["originalObjectId"] = before
            changes.append({"item": item, "changeType": kind})
        c["changes"] = changes[:change_count]
    return c


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, status, body, ctype="application/json; charset=utf-8"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def json(self, obj):
        self.send(200, json.dumps(obj))

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        path = urllib.parse.unquote(url.path)
        opts = self.server.opts
        prefix = f"/{opts.org}/"
        if not path.startswith(prefix):
            return self.send(404, "{}")
        rest = path[len(prefix):]
        if rest == "_apis/git/repositories":
            return self.json({"value": [{"name": n, "project": {"name": opts.project}, "isDisabled": False,
                                         "defaultBranch": "refs/heads/" + default_branch(r, branches(r)),
                                         "webUrl": f"https://dev.azure.com/{opts.org}/{urllib.parse.quote(opts.project)}/_git/{n}"}
                                        for n, r in self.server.repos.items()]})
        m = re.match(r"^([^/]+)/_apis/git/repositories/([^/]+)(/.*)?$", rest)
        if not m or m.group(1) != opts.project or m.group(2) not in self.server.repos:
            return self.send(404, "{}")
        name, sub = m.group(2), m.group(3) or ""
        repo = self.server.repos[name]
        names = branches(repo)
        if sub == "":
            return self.json({"id": name, "name": name, "defaultBranch": "refs/heads/" + default_branch(repo, names),
                              "project": {"name": opts.project}})
        if sub == "/refs":
            if q.get("filter") == "heads/":
                return self.json({"value": [{"name": "refs/heads/" + n, "objectId": s} for n, s in names.items()]})
            out = git(repo, "for-each-ref", "refs/tags", "--format=%(objectname) %(*objectname) %(refname)") or ""
            tags = []
            for line in out.splitlines():
                parts = line.split(" ")
                tag = {"name": parts[-1], "objectId": parts[0]}
                if len(parts) == 3 and parts[1]:
                    tag["peeledObjectId"] = parts[1]
                tags.append(tag)
            return self.json({"value": tags})
        if sub == "/stats/branches":
            default = default_branch(repo, names)
            value = []
            for n, s in names.items():
                c = commit_json(repo, s)
                ahead = int((git(repo, "rev-list", "--count", f"{names[default]}..{s}") or "0").strip() or 0)
                value.append({"name": n, "aheadCount": ahead, "commit": {"commitId": s, "committer": c["committer"], "author": c["author"]}})
            return self.json({"value": value})
        if sub == "/items":
            rev = rev_of(repo, q.get("versionDescriptor.version", ""), q.get("versionDescriptor.versionType", "branch"))
            if "path" in q:
                p = q["path"].lstrip("/")
                kind = (git(repo, "cat-file", "-t", f"{rev}:{p}") or "").strip()
                if not kind:
                    return self.send(404, "{}")
                oid = git(repo, "rev-parse", f"{rev}:{p}").strip()
                return self.json({"objectId": oid, "gitObjectType": kind, "path": "/" + p, "isFolder": kind == "tree"})
            scope = q.get("scopePath", "/").strip("/")
            out = git(repo, "ls-tree", "-r", rev, *(["--", scope] if scope else []))
            if out is None:
                return self.send(404, "{}")
            value = [{"objectId": "x", "gitObjectType": "tree", "path": "/" + scope, "isFolder": True}]
            for line in out.splitlines():
                meta, p = line.split("\t", 1)
                _, kind, oid = meta.split()
                value.append({"objectId": oid, "gitObjectType": kind, "path": "/" + p})
            return self.json({"count": len(value), "value": value})
        m2 = re.match(r"^/blobs/([0-9a-f]{40})$", sub)
        if m2:
            data = subprocess.run(["git", "-C", repo, "cat-file", "blob", m2.group(1)], capture_output=True).stdout
            return self.send(200, data, "application/octet-stream")
        if sub == "/commits":
            rev = rev_of(repo, q.get("searchCriteria.itemVersion.version", ""), q.get("searchCriteria.itemVersion.versionType", "branch"))
            top = q.get("searchCriteria.$top", "100")
            p = q.get("searchCriteria.itemPath", "").lstrip("/")
            out = git(repo, "log", "-n", top, "--format=%H", rev, *(["--", p] if p else [])) or ""
            return self.json({"value": [commit_json(repo, s) for s in out.split()]})
        m3 = re.match(r"^/commits/([0-9a-f]{40})/mergebases$", sub)
        if m3:
            mb = (git(repo, "merge-base", m3.group(1), q.get("otherCommitId", "")) or "").strip()
            return self.json({"value": [{"commitId": mb}] if mb else []})
        m4 = re.match(r"^/commits/([0-9a-f]{40})$", sub)
        if m4:
            c = commit_json(repo, m4.group(1), int(q.get("changeCount", "0") or 0))
            return self.json(c) if c else self.send(404, "{}")
        m5 = re.match(r"^/pullRequests/(\d+)$", sub)
        if m5 and m5.group(1) in self.server.prs:
            source, target = self.server.prs[m5.group(1)]
            return self.json({"pullRequestId": int(m5.group(1)), "sourceRefName": "refs/heads/" + source, "targetRefName": "refs/heads/" + target})
        return self.send(404, "{}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--org", required=True)
    ap.add_argument("--project", required=True)
    ap.add_argument("--pr", action="append", default=[])
    ap.add_argument("repos", nargs="+")
    opts = ap.parse_args()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", opts.port), Handler)
    server.opts = opts
    server.repos = {os.path.basename(os.path.normpath(r)): r for r in opts.repos}
    server.prs = {k: tuple(v.split(":", 1)) for k, v in (p.split("=", 1) for p in opts.pr)}
    print(json.dumps({"port": server.server_address[1]}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
