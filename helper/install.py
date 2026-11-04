#!/usr/bin/env python3
"""Registers Mule Flow Viewer's helper with Chrome (and Chromium, Edge, Brave when present), for this user only.

  python3 install.py                 install, or repair after moving this folder
  python3 install.py --uninstall     remove the registration (the folder stays)
  python3 install.py --check         say what is installed and what the helper will find

No administrator rights: everything goes into this user's own browser folders (on Windows, HKEY_CURRENT_USER).
Python 3.8+ and git are needed; the DataWeave CLI (dw) is optional, for running scripts.
"""
import argparse
import json
import os
import shutil
import stat
import subprocess
import sys

NAME = "mule_flow_viewer.helper"
EXTENSION_IDS = ["gikmgdbiaplaeechloibkkgajcbbikom"]   # the key in the extension's manifest.json fixes this id
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(os.path.expanduser("~"), ".mule-flow-viewer")

# per browser: macOS and Linux folders for host manifests, Windows registry keys
BROWSERS = {
    "Google Chrome": ("Library/Application Support/Google/Chrome", ".config/google-chrome", r"Software\Google\Chrome"),
    "Chromium": ("Library/Application Support/Chromium", ".config/chromium", r"Software\Chromium"),
    "Microsoft Edge": ("Library/Application Support/Microsoft Edge", ".config/microsoft-edge", r"Software\Microsoft\Edge"),
    "Brave": ("Library/Application Support/BraveSoftware/Brave-Browser", ".config/BraveSoftware/Brave-Browser",
              r"Software\BraveSoftware\Brave-Browser"),
}


def launcher():
    """Chrome starts an executable, not a script with arguments: a small wrapper pinned to this Python."""
    os.makedirs(STATE, exist_ok=True)
    helper = os.path.join(HERE, "mfv_helper.py")
    if os.name == "nt":
        path = os.path.join(STATE, "mfv_helper.bat")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f'@echo off\r\n"{sys.executable}" -u "{helper}" %*\r\n')
    else:
        path = os.path.join(STATE, "mfv_helper.sh")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" -u "{helper}" "$@"\n')
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def manifest(path):
    return {
        "name": NAME,
        "description": "Mule Flow Viewer local helper",
        "path": path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{i}/" for i in EXTENSION_IDS],
    }


def browser_dirs():
    home = os.path.expanduser("~")
    for name, (mac, linux, _) in BROWSERS.items():
        base = os.path.join(home, mac if sys.platform == "darwin" else linux)
        # Chrome is always registered; the others only when they are installed
        if name == "Google Chrome" or os.path.isdir(base):
            yield name, os.path.join(base, "NativeMessagingHosts")


def install(args):
    if sys.version_info < (3, 8):
        sys.exit("Python 3.8 or newer is needed.")
    for f in ("mfv_helper.py", "serve.py", "dw_runner.py"):
        if not os.path.isfile(os.path.join(HERE, f)) and not os.path.isfile(os.path.join(HERE, "..", "tools", f)):
            sys.exit(f"{f} is missing next to install.py.")
    path = launcher()
    # the PATH of this shell: Chrome starts the helper without it, and git or dw may only be found through it
    config_path = os.path.join(STATE, "config.json")
    config = {}
    if os.path.isfile(config_path):
        with open(config_path, encoding="utf-8") as f:
            config = json.load(f)
    config["path"] = os.environ.get("PATH", "")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=1)

    body = json.dumps(manifest(path), indent=2)
    done = []
    if os.name == "nt":
        import winreg
        file = os.path.join(STATE, f"{NAME}.json")
        with open(file, "w", encoding="utf-8") as f:
            f.write(body)
        for name, (_, _, key) in BROWSERS.items():
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{key}\NativeMessagingHosts\{NAME}") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, file)
            done.append(name)
    else:
        for name, folder in browser_dirs():
            os.makedirs(folder, exist_ok=True)
            with open(os.path.join(folder, f"{NAME}.json"), "w", encoding="utf-8") as f:
                f.write(body)
            done.append(name)
    print(f"Registered for {', '.join(done)}.")
    check()


def uninstall(args):
    if os.name == "nt":
        import winreg
        for _, (_, _, key) in BROWSERS.items():
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"{key}\NativeMessagingHosts\{NAME}")
            except OSError:
                pass
    else:
        for _, folder in browser_dirs():
            path = os.path.join(folder, f"{NAME}.json")
            if os.path.isfile(path):
                os.remove(path)
    print("Unregistered. Servers it started stop on their own after 30 idle minutes.")


def check():
    git = shutil.which("git")
    dw = shutil.which("dw")
    print(f"Python {sys.version.split()[0]} at {sys.executable}")
    print(f"git: {subprocess.run([git, '--version'], capture_output=True, text=True).stdout.strip() if git else 'NOT FOUND (needed)'}")
    print(f"DataWeave CLI: {dw or 'not found (optional: only running scripts needs it)'}")
    m2 = os.path.expanduser(os.environ.get("MAVEN_REPO", "~/.m2/repository"))
    print(f"Maven repository: {m2 if os.path.isdir(m2) else 'none (optional: shared library flows are read from it)'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--extension-id", action="append", help="also allow this extension id (e.g. a Web Store build)")
    args = ap.parse_args()
    if args.extension_id:
        EXTENSION_IDS.extend(args.extension_id)
    if args.check:
        return check()
    (uninstall if args.uninstall else install)(args)


if __name__ == "__main__":
    main()
