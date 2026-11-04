"""Drives the helper as Chrome does (framed JSON on stdin/stdout) in a throwaway home folder, then checks the server
it starts: the token is required, other Host names are refused, and pages are not served.

  python3 tools/test_helper_protocol.py <folder with clones> <page url> [helper dir]
"""
import json
import os
import signal
import struct
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

roots, page = sys.argv[1], sys.argv[2]
helper_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "helper")
home = tempfile.mkdtemp(prefix="mfv-home-")


def talk(*messages):
    data = b"".join(struct.pack("<I", len(m)) + m for m in (json.dumps(x).encode() for x in messages))
    env = {"HOME": home, "USERPROFILE": home, "PATH": "/usr/bin:/bin", "MFV_NO_FETCH": "1"}     # a bare PATH, as Chrome gives; no network
    out = subprocess.run([sys.executable, os.path.join(helper_dir, "mfv_helper.py")], input=data, capture_output=True,
                         env=env, timeout=120).stdout
    replies = []
    while out:
        n = struct.unpack("<I", out[:4])[0]
        replies.append(json.loads(out[4:4 + n]))
        out = out[4 + n:]
    return replies


def status(url, headers=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


checks = []
def check(name, ok, detail=""):
    checks.append(bool(ok))
    print(f"{'ok ' if ok else 'BAD'} {name}{f'  ({detail})' if detail else ''}")


ping, opened, again, missing = talk({"type": "ping"}, {"type": "open", "url": page, "roots": [roots]},
                                    {"type": "open", "url": page, "roots": [roots]},
                                    {"type": "open", "url": "https://github.com/nobody/nothing-here", "roots": [roots]})
check("ping answers", ping.get("ok") and ping.get("git"), f"python {ping.get('python')}, git {ping.get('git')}, dw {ping.get('dw')}")
check("open finds the clone and starts a server", opened.get("ok"), opened.get("project") or opened.get("message"))
check("a second open reuses the server", again.get("base") == opened.get("base"))
check("a repository git cannot reach says so", missing.get("error") == "no-remote", missing.get("message"))
if opened.get("ok"):
    base, token = opened["base"], opened["token"]
    port = base.rsplit(":", 1)[1]
    check("API with the token", status(f"{base}/api/project", {"X-MFV-Token": token}) == 200)
    check("API without the token is refused", status(f"{base}/api/project") == 403)
    check("a wrong token is refused", status(f"{base}/api/project", {"X-MFV-Token": "x" + token}) == 403)
    check("another Host name is refused (DNS rebinding)", status(f"{base}/api/project", {"X-MFV-Token": token, "Host": f"evil.example:{port}"}) == 403)
    check("pages are not served", status(f"{base}/viewer/index.html", {"X-MFV-Token": token}) == 404)
    check("token in the query (download links)", status(f"{base}/api/dw?token={token}") == 200)
    pid = json.load(open(os.path.join(home, ".mule-flow-viewer", "servers.json")))[opened["project"]]["pid"]
    os.kill(pid, signal.SIGTERM)
print(f"{sum(checks)}/{len(checks)} passed")
sys.exit(0 if all(checks) else 1)
