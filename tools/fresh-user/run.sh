#!/bin/sh
# A new user on a clean Linux machine: installs the release, clones a repository, and runs every check.
# docker run --rm -v <dist>:/dist:ro -v <tools>:/tools:ro -v <a clone>:/src/repo:ro node:24-slim sh /tools/fresh-user/run.sh "<page url>" "<remote url>"
set -e
PAGE="$1"; REMOTE="$2"
apt-get update -qq >/dev/null && apt-get install -y -qq python3 git >/dev/null 2>&1
useradd -m fresh
cat > /home/fresh/steps.sh <<STEPS
set -e
echo "== a fresh clone (remote branches only, no Maven repository, no DataWeave CLI)"
mkdir -p ~/repos && git -c safe.directory='*' clone -q /src/repo ~/repos/project
git -C ~/repos/project remote set-url origin "$REMOTE"
echo "== install from the release"
cp -r /dist/mule-flow-viewer ~/mfv && python3 ~/mfv/helper/install.py
test -f ~/.config/google-chrome/NativeMessagingHosts/mule_flow_viewer.helper.json && echo "host manifest in place"
echo "== the launcher Chrome starts, with a bare PATH"
python3 - <<'PY'
import json, os, struct, subprocess
msg = json.dumps({"type": "ping"}).encode()
out = subprocess.run([os.path.expanduser("~/.mule-flow-viewer/mfv_helper.sh")], input=struct.pack("<I", len(msg)) + msg,
                     capture_output=True, env={"HOME": os.path.expanduser("~"), "PATH": "/usr/bin:/bin"}).stdout
print("launcher:", json.loads(out[4:]))
PY
echo "== helper protocol"
python3 /tools/test_helper_protocol.py ~/repos "$PAGE" ~/mfv/helper
echo "== every feature against the helper's server"
mkdir -p ~/mfv/extension/tools && cp /tools/e2e_core.mjs ~/mfv/extension/tools/
python3 - "$PAGE" > /tmp/server.json <<'PY'
import json, os, struct, subprocess, sys
msg = json.dumps({"type": "open", "url": sys.argv[1], "roots": [os.path.expanduser("~/repos")]}).encode()
out = subprocess.run([os.path.expanduser("~/.mule-flow-viewer/mfv_helper.sh")], input=struct.pack("<I", len(msg)) + msg,
                     capture_output=True, env={"HOME": os.path.expanduser("~"), "PATH": "/usr/bin:/bin"}).stdout
print(out[4:].decode())
PY
BASE=\$(python3 -c "import json;print(json.load(open('/tmp/server.json'))['base'])")
TOKEN=\$(python3 -c "import json;print(json.load(open('/tmp/server.json'))['token'])")
node ~/mfv/extension/tools/e2e_core.mjs "\$BASE" "\$TOKEN" "$PAGE"
STEPS
su fresh -s /bin/sh /home/fresh/steps.sh
