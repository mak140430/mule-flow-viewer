"""Builds what other users install: dist/mule-flow-viewer/ with

  extension/   load it in Chrome (chrome://extensions, Developer mode, Load unpacked)
  helper/      run `python3 install.py` in it once (registers the local helper for this user)

and dist/mule-flow-viewer-<version>.zip with both. For publishing:

  dist/store/mule-flow-viewer-<version>-chrome-web-store.zip   upload this to the Chrome Web Store (or Edge Add-ons):
      the extension without the manifest "key" (stores assign their own id) and without remote fonts
  dist/store/mule-flow-viewer-helper-<version>.zip             what store users download for the helper

  python3 tools/build_extension.py [--helper-url URL]   URL: where the helper zip is published (the setup guide links it)

The viewer, core and icon packs are copied as they are: the same code the dev server serves.
"""
import argparse
import json
import os
import re
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dist", "mule-flow-viewer")

EXTENSION = [("extension", ""), ("viewer", "viewer"), ("src", "src"), ("icon-packs", "icon-packs"), ("catalog", "catalog")]
HELPER = [("helper/mfv_helper.py", "mfv_helper.py"), ("helper/install.py", "install.py"),
          ("tools/serve.py", "serve.py"), ("tools/dw_runner.py", "dw_runner.py")]
SKIP = shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc")

README = """Mule Flow Viewer

1. Chrome: open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick the extension folder.
2. Helper (once): install Python 3.8+ and git, then in the helper folder run
     python3 install.py        (Windows: py install.py)
   It registers the helper for your user only (no admin rights). The DataWeave CLI is optional (running scripts).
3. Open a repository page of a Mule project (GitHub, GitLab, Bitbucket, Azure DevOps, ...) and click the
   extension's button (or Alt+Shift+M). Your local clone is used; if there is none, the setup page offers to clone it.

Moved this folder? Run install.py again. Remove: python3 install.py --uninstall
"""


def zip_dir(folder, archive, prefix=""):
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(folder):
            for name in files:
                full = os.path.join(dirpath, name)
                z.write(full, os.path.join(prefix, os.path.relpath(full, folder)))


def store(ext, helper, version, helper_url):
    """The Web Store package: no "key" (the store assigns the id), fonts from the system (no request to Google)."""
    out = os.path.join(ROOT, "dist", "store")
    if os.path.isdir(out):
        shutil.rmtree(out)
    staged = os.path.join(out, "extension")
    shutil.copytree(ext, staged)
    manifest = json.load(open(os.path.join(staged, "manifest.json")))
    manifest.pop("key", None)
    with open(os.path.join(staged, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    for page in ("viewer/index.html", "setup.html"):
        path = os.path.join(staged, page)
        text = open(path, encoding="utf-8").read()
        text = re.sub(r'\s*<link rel="(?:preconnect|stylesheet)" href="https://fonts\.(?:googleapis|gstatic)\.com[^>]*>', "", text)
        open(path, "w", encoding="utf-8").write(text)
    if helper_url:
        setup = os.path.join(staged, "setup.js")
        text = open(setup, encoding="utf-8").read().replace("const HELPER_DOWNLOAD = '';", f"const HELPER_DOWNLOAD = {json.dumps(helper_url)};")
        open(setup, "w", encoding="utf-8").write(text)
    zip_dir(staged, os.path.join(out, f"mule-flow-viewer-{version}-chrome-web-store.zip"))
    zip_dir(helper, os.path.join(out, f"mule-flow-viewer-helper-{version}.zip"), "mule-flow-viewer-helper")
    shutil.rmtree(staged)
    return out


def build(helper_url=""):
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    ext = os.path.join(OUT, "extension")
    for src, dst in EXTENSION:
        target = os.path.join(ext, dst)
        shutil.copytree(os.path.join(ROOT, src), target, ignore=SKIP, dirs_exist_ok=True)
    helper = os.path.join(OUT, "helper")
    os.makedirs(helper)
    for src, dst in HELPER:
        shutil.copy2(os.path.join(ROOT, src), os.path.join(helper, dst))
    with open(os.path.join(OUT, "README.txt"), "w", encoding="utf-8") as f:
        f.write(README)
    version = json.load(open(os.path.join(ext, "manifest.json")))["version"]
    archive = os.path.join(ROOT, "dist", f"mule-flow-viewer-{version}.zip")
    zip_dir(OUT, archive, "mule-flow-viewer")
    out = store(ext, helper, version, helper_url)
    print(f"{OUT}\n{archive} ({os.path.getsize(archive) // 1024} KB)")
    for name in sorted(os.listdir(out)):
        print(f"{os.path.join(out, name)} ({os.path.getsize(os.path.join(out, name)) // 1024} KB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--helper-url", default="", help="where the helper zip is published, linked from the setup guide")
    build(ap.parse_args().helper_url)
