"""Runs DataWeave scripts with the local DataWeave CLI (`dw`), on this machine's CPU and memory.

The browser sends the script, the project modules it imports and the property values it reads;
large inputs are uploaded once as files and referenced by id, and output is written to disk so
only a preview travels back. Mule-only functions get stubs: p() / Mule::p() read the sent
properties, lookup() explains that it needs a running Mule app.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

EXT = {"application/json": "json", "application/xml": "xml", "application/csv": "csv",
       "text/plain": "txt", "application/yaml": "yaml", "application/x-www-form-urlencoded": "urlencoded",
       "application/dw": "dwl"}
MODULE = re.compile(r"^(?!/)(?!.*\.\.)[A-Za-z0-9_\-./]+\.dwl$")
VAR_INPUT = re.compile(r"^vars\.[\w\-]{1,80}$")
FILE_ID = re.compile(r"^[0-9a-f]{32}\.[a-z]{2,10}$")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
PREVIEW = 1 << 20
KEEP_RUNS = 20

MULE_STUB = """%dw 2.0
import fail from dw::Runtime
var props = {props}
fun p(key: String) = props[key] default fail("Property '$(key)' is not set for this environment")
fun lookup(flowName: String, value: Any = null, timeoutMillis: Number = 0) =
  fail("lookup('$(flowName)') calls a Mule flow, which only runs inside a Mule app")
"""


class Runner:
    def __init__(self, heap=None, timeout=120):
        self.dw = shutil.which("dw")
        self.heap = heap
        self.timeout = timeout
        self.root = tempfile.mkdtemp(prefix="mule-flow-viewer-dw-")
        self.lock = threading.Lock()
        self.version = None
        self.cli = 0
        if self.dw:
            out = subprocess.run([self.dw, "--version"], capture_output=True, text=True, timeout=30).stdout
            m = re.search(r"Runtime\s*:\s*V?([\w.\-]+)", out)
            self.version = m.group(1) if m else None
            m = re.search(r"Command Line\s*:\s*V?(\d+)", out)
            self.cli = int(m.group(1)) if m else 0

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def info(self):
        return {"available": bool(self.dw), "version": self.version}

    # ------------------------------------------------------------ inputs and outputs on disk

    def save_upload(self, stream, length, ext):
        ext = ext if re.match(r"^[a-z]{2,10}$", ext or "") else "txt"
        name = f"{uuid.uuid4().hex}.{ext}"
        with open(os.path.join(self.root, name), "wb") as f:
            left = length
            while left > 0:
                chunk = stream.read(min(left, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        return name

    def file(self, file_id):
        path = os.path.join(self.root, file_id)
        return path if FILE_ID.match(file_id or "") and os.path.isfile(path) else None

    # ------------------------------------------------------------ run

    def run(self, req):
        if not self.dw:
            return {"ok": False, "error": "The DataWeave CLI (dw) is not installed. See https://github.com/mulesoft/data-weave-cli"}
        work = tempfile.mkdtemp(dir=self.root, prefix="run-")
        src = os.path.join(work, "spell", "src")
        os.makedirs(src)
        try:
            for path, code in (req.get("modules") or {}).items():
                if MODULE.match(path) and path != "Mule.dwl":
                    full = os.path.join(src, path)
                    os.makedirs(os.path.dirname(full), exist_ok=True)
                    with open(full, "w", encoding="utf-8") as f:
                        f.write(code)
            with open(os.path.join(src, "Mule.dwl"), "w", encoding="utf-8") as f:
                # "$" starts interpolation in DataWeave strings, and values like "${project.groupId}" are common
                f.write(MULE_STUB.replace("{props}", json.dumps(req.get("properties") or {}).replace("$", "\\$")))
            # CLI 2.x: `dw run -i name=path --path dir -f file`; CLI 1.x: `dw -i name path --local-spell dir`
            v2 = self.cli >= 2
            args = [self.dw] + ([f"-Xmx{self.heap}"] if self.heap else []) + (["run"] if v2 else [])
            inputs = {k: v for k, v in (req.get("inputs") or {}).items() if v}
            # "vars.<key>": one variable in its own format (XML, CSV, ...), merged into vars by the script header
            var_files = [k for k in inputs if VAR_INPUT.match(k)]
            header = []
            if var_files:
                merged = ", ".join(f"{json.dumps(k[5:]).replace('$', chr(92) + '$')}: mfvVar{i}" for i, k in enumerate(var_files))
                header = [f"var vars = {'(mfvVars default {})' if 'vars' in inputs else '{}'} ++ {{{merged}}}"]
            for name, spec in inputs.items():
                # munitResources: test resource files that MUnit sample values read (see munit.js)
                if name not in ("payload", "vars", "attributes", "error", "munitResources") and name not in var_files:
                    continue
                if spec.get("file"):
                    path = self.file(spec["file"])
                    if not path:
                        return {"ok": False, "error": f"The uploaded {name} file is gone; choose it again."}
                else:
                    path = os.path.join(work, f"{uuid.uuid4().hex[:8]}.{EXT.get(spec.get('mime'), 'json')}")
                    with open(path, "w", encoding="utf-8") as f:
                        f.write(spec.get("text") or "")
                cli_name = f"mfvVar{var_files.index(name)}" if name in var_files else "mfvVars" if name == "vars" and var_files else name
                args += ["-i", f"{cli_name}={path}"] if v2 else ["-i", cli_name, path]
            script, inserted, note = prepare(req.get("script") or "", header)
            with open(os.path.join(src, "Main.dwl"), "w", encoding="utf-8") as f:
                f.write(script)
            out_id = f"{uuid.uuid4().hex}.out"
            out = os.path.join(self.root, out_id)
            if v2:
                args += ["-o", out, "--silent", "--untrusted", "--path", src, "-f", os.path.join(src, "Main.dwl")]
            else:
                args += ["-o", out, "--silent", "--untrusted-code", "--local-spell", os.path.join(work, "spell")]

            t0 = time.monotonic()
            try:
                r = subprocess.run(args, cwd=work, capture_output=True, timeout=self.timeout)
            except subprocess.TimeoutExpired:
                return {"ok": False, "error": f"Stopped after {self.timeout} s. Start serve.py with a larger --dw-timeout for big inputs."}
            ms = round((time.monotonic() - t0) * 1000)
            message = ANSI.sub("", (r.stderr + r.stdout).decode("utf-8", "replace")).strip()
            if r.returncode != 0 or not os.path.isfile(out):
                return {"ok": False, "ms": ms, "error": clean_error(message, inserted)}
            size = os.path.getsize(out)
            with open(out, "rb") as f:
                preview = f.read(PREVIEW).decode("utf-8", "replace")
            return {"ok": True, "ms": ms, "output": preview, "size": size, "truncated": size > PREVIEW,
                    "outputId": out_id, "note": note}
        finally:
            shutil.rmtree(work, ignore_errors=True)
            self._prune()

    def _prune(self):
        # runs finish on several server threads at once
        with self.lock:
            outs = sorted((e for e in os.scandir(self.root) if e.name.endswith(".out")), key=lambda e: e.stat().st_mtime)
            for e in outs[:-KEEP_RUNS]:
                os.remove(e.path)


def prepare(script, header=()):
    """Script as the CLI needs it, plus the line numbers we inserted (to map errors back) and a note.
    header: extra directives placed right after the %dw line."""
    lines = script.split("\n")
    has_header = any(l.strip() == "---" for l in lines) or any(l.lstrip().startswith("%dw") for l in lines)
    inserted = []
    note = None
    if not has_header:
        lines = ["%dw 2.0", "output application/json", "---"] + lines
        inserted = [1, 2, 3]
    needs_mule = re.search(r"(?<![\w:.$])(p|lookup)\s*\(", script) and not re.search(r"\bfrom\s+Mule\b", script)
    for line in (["import * from Mule"] if needs_mule else []) + list(header):
        at = next((i + 1 for i, l in enumerate(lines) if l.lstrip().startswith("%dw")), 0)
        lines.insert(at, line)
        inserted = [n + 1 if n > at else n for n in inserted] + [at + 1]
    for i, l in enumerate(lines):
        if re.match(r"^\s*output\s+application/java\b", l):
            lines[i] = re.sub(r"application/java", "application/dw", l)
            note = "application/java output is shown in DataWeave format"
    return "\n".join(lines), sorted(inserted), note


def clean_error(text, inserted):
    text = re.sub(r"^WARNING: .*\n?", "", text, flags=re.M)  # JVM notices from the native image
    text = re.sub(r"^\[(ERROR|WARN|INFO)\] ", "", text, flags=re.M)
    # some CLI versions print internal writer stack traces first; the script's error comes last
    marker = "Error while executing the script:"
    if marker in text:
        text = text[text.rindex(marker) + len(marker):].strip()
    text = re.sub(r"(\(line: \d+, column: \d+\)) at:$", r"\1", text, flags=re.M)
    head, _, trace = text.partition("\nTrace:")

    def orig(n):
        return n - sum(1 for i in inserted if i <= n)

    main_at = re.search(r"at Main::main \(line: (\d+), column: (\d+)\)", trace)
    if "system::fail" in head:
        # raised by fail() in a stub or the script: the message is the error, the stdlib snippet is noise
        where = f"\n\nscript line {orig(int(main_at.group(1)))}, column {main_at.group(2)}" if main_at else ""
        return head.strip().split("\n")[0] + where
    main_trace = [l.strip() for l in trace.split("\n") if "Main::" in l]
    text = head.strip() + ("\n\n" + "\n".join(main_trace) if main_trace else "")
    text = re.sub(r"(Main(?:::main)? \(line: )(\d+)", lambda m: m.group(1) + str(orig(int(m.group(2)))), text)
    if re.search(r"\bMain\b", text) and not re.search(r"\bMule \(line", text):
        text = re.sub(r"^(\s*)(\d+)\|", lambda m: f"{m.group(1)}{orig(int(m.group(2)))}|", text, flags=re.M)
    return text.replace("Location:\nMain", "Location:\nscript")
