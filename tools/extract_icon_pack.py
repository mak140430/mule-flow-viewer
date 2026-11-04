#!/usr/bin/env python3
"""Build the `mulesoft` icon pack and the connector catalog.

Sources (all optional, whatever is found is used):
  * Anypoint Studio        -> plugins/org.mule.tooling.images_*.jar  (core component icons)
  * Local Maven repository -> **/*-mule-plugin.jar                   (connector icon + operations/sources)
  * generated/remote-jars  -> every published connector, made by tools/fetch_connectors.py

Outputs:
  icon-packs/mulesoft/manifest.json + icons/
  catalog/connectors.json

Usage:
  python3 tools/fetch_connectors.py        # optional, all published connectors
  python3 tools/extract_icon_pack.py [--studio PATH] [--m2 PATH]
"""
import argparse
import glob
import json
import os
import re
import shutil
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK_DIR = os.path.join(ROOT, "icon-packs", "mulesoft")
CATALOG = os.path.join(ROOT, "catalog", "connectors.json")
REMOTE_JARS = os.path.join(ROOT, "generated", "remote-jars")
ICON_MEMBERS = {"META-INF/mule-artifact/icon.svg": "svg", "META-INF/mule-artifact/icon.png": "png"}

DEFAULT_STUDIO = [
    "/Applications/AnypointStudio-latest.app/Contents/Eclipse",
    "/Applications/AnypointStudio.app/Contents/Eclipse",
    os.path.expanduser("~/AnypointStudio"),
]

# XML element -> Studio image base name. Keys are "prefix:element"; "prefix:*" covers a whole namespace.
STUDIO_ICONS = {
    "core:flow": "flow",
    "core:sub-flow": "sub-flow",
    "core:flow-ref": "flow-reference",
    "core:choice": "choice",
    "core:scatter-gather": "scatter-gather",
    "core:foreach": "for-each",
    "core:parallel-foreach": "for-each",
    "core:try": "try",
    "core:until-successful": "until-successful",
    "core:first-successful": "first-successful",
    "core:round-robin": "round-robin",
    "core:async": "async-scope",
    "core:scheduler": "scheduler",
    "core:logger": "logger",
    "core:set-payload": "set-payload",
    "core:set-variable": "set-variable",
    "core:remove-variable": "set-variable",
    "core:raise-error": "raise-error",
    "core:error-handler": "error-handler",
    "core:on-error-continue": "on-error-continue",
    "core:on-error-propagate": "on-error-propagate",
    "core:idempotent-message-validator": "idempotent-message-validator",
    "core:parse-template": "transformer",
    "ee:transform": "transform",
    "ee:dynamic-evaluate": "transform",
    "ee:cache": "cache",
    "ee:invalidate-cache": "cache-invalidate",
    "ee:invalidate-key": "cache-invalidate-key",
    "batch:job": "batch-scope",
    "batch:step": "batch-step",
    "batch:aggregator": "batch-commit",
    "http:listener": "http-listener",
    "http:request": "http-request",
    "apikit:router": "apikit",
    "apikit:console": "apikit-console",
    "validation:*": "validation",
    "db:*": "database",
    "salesforce:*": "salesforce",
    "sap:*": "sap",
    "servicenow:*": "servicenow",
    "netsuite:*": "netsuite",
    "workday:*": "workday",
    "jira:*": "jira",
    "java:*": "java",
    "scripting:*": "script",
}
GENERIC = "generic"


# --------------------------------------------------------------------------- Studio

def find_studio(explicit):
    for path in ([explicit] if explicit else DEFAULT_STUDIO):
        if path and glob.glob(os.path.join(path, "plugins", "org.mule.tooling.images_*.jar")):
            return path
    return None


def studio_images(studio):
    """Return {base_name: (jar, member)} preferring canvas@2x > canvas > palette@2x > palette."""
    jar = sorted(glob.glob(os.path.join(studio, "plugins", "org.mule.tooling.images_*.jar")))[-1]
    with zipfile.ZipFile(jar) as z:
        members = set(z.namelist())
    found = {}
    names = {re.sub(r"(@2x)?\.png$", "", os.path.basename(m)) for m in members
             if m.startswith(("images/canvas/", "images/palette/")) and m.endswith(".png")}
    for name in names:
        for candidate in (f"images/canvas/{name}@2x.png", f"images/canvas/{name}.png",
                          f"images/palette/{name}@2x.png", f"images/palette/{name}.png"):
            if candidate in members:
                found[name] = (jar, candidate)
                break
    return found, os.path.basename(jar)


# --------------------------------------------------------------------------- class file reading

def _class_annotations(data):
    """Parse a .class file and return its class-level RuntimeVisibleAnnotations as
    {annotation_descriptor: {element_name: str_value}} (only string/const values are kept)."""
    pos = 8
    (count,) = struct.unpack_from(">H", data, pos)
    pos += 2
    utf8, consts = {}, {}
    i = 1
    while i < count:
        tag = data[pos]
        pos += 1
        if tag == 1:
            (ln,) = struct.unpack_from(">H", data, pos)
            utf8[i] = data[pos + 2:pos + 2 + ln].decode("utf-8", "replace")
            pos += 2 + ln
        elif tag in (3, 4):
            pos += 4
        elif tag in (5, 6):
            pos += 8
            i += 1
        elif tag in (7, 8, 16, 19, 20):
            pos += 2
        elif tag in (9, 10, 11, 12, 17, 18):
            pos += 4
        elif tag == 15:
            pos += 3
        else:
            raise ValueError(f"unknown constant tag {tag}")
        i += 1
    pos += 6  # access, this, super
    (n,) = struct.unpack_from(">H", data, pos)
    pos += 2 + 2 * n

    def skip_members(p):
        (cnt,) = struct.unpack_from(">H", data, p)
        p += 2
        for _ in range(cnt):
            p += 6
            (ac,) = struct.unpack_from(">H", data, p)
            p += 2
            for _ in range(ac):
                (ln,) = struct.unpack_from(">I", data, p + 2)
                p += 6 + ln
        return p

    pos = skip_members(pos)  # fields
    pos = skip_members(pos)  # methods

    def element_value(p):
        tag = chr(data[p])
        p += 1
        if tag in "BCDFIJSZs":
            (idx,) = struct.unpack_from(">H", data, p)
            return p + 2, utf8.get(idx)
        if tag == "e":
            return p + 4, None
        if tag == "c":
            return p + 2, None
        if tag == "@":
            p, _ = annotation(p)
            return p, None
        if tag == "[":
            (num,) = struct.unpack_from(">H", data, p)
            p += 2
            for _ in range(num):
                p, _ = element_value(p)
            return p, None
        raise ValueError(f"bad element_value tag {tag}")

    def annotation(p):
        type_idx, pairs = struct.unpack_from(">HH", data, p)
        p += 4
        values = {}
        for _ in range(pairs):
            (name_idx,) = struct.unpack_from(">H", data, p)
            p, value = element_value(p + 2)
            if value is not None:
                values[utf8.get(name_idx)] = value
        return p, (utf8.get(type_idx), values)

    result = {}
    (ac,) = struct.unpack_from(">H", data, pos)
    pos += 2
    for _ in range(ac):
        name_idx, ln = struct.unpack_from(">HI", data, pos)
        body = pos + 6
        if utf8.get(name_idx) == "RuntimeVisibleAnnotations":
            (num,) = struct.unpack_from(">H", data, body)
            p = body + 2
            for _ in range(num):
                p, (desc, values) = annotation(p)
                result[desc] = values
        pos = body + ln
    return result


def hyphenize(name):
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", name).replace(" ", "-").lower()


# --------------------------------------------------------------------------- connectors

def read_connector(jar_path):
    with zipfile.ZipFile(jar_path) as z:
        names = set(z.namelist())
        if "META-INF/mule-artifact/mule-artifact.json" not in names:
            return None
        artifact = json.loads(z.read("META-INF/mule-artifact/mule-artifact.json"))
        loader = artifact.get("extensionModelLoaderDescriptor") or {}
        main_class = (loader.get("attributes") or {}).get("type")
        if not loader:
            return None  # plain library, not an extension

        prefix = namespace = ext_name = None
        operations, sources, configs = set(), set(), set()
        # Non-Java extensions (APIkit, Spring, ...) ship their schema: prefix and elements come from it.
        xsd_member = next((n for n in names if re.fullmatch(r"META-INF/mule-[^/]+\.xsd", n)), None)
        if xsd_member:
            schema = ET.fromstring(z.read(xsd_member))
            namespace = schema.get("targetNamespace")
            # ".../schema/mule/mule-apikit" is conventionally written with the "apikit" prefix
            prefix = re.sub(r"^mule-", "", namespace.rstrip("/").rsplit("/", 1)[-1]) if namespace else None
            for el in schema.findall("{http://www.w3.org/2001/XMLSchema}element"):
                group = el.get("substitutionGroup") or ""
                if not el.get("name") or el.get("abstract") == "true":
                    continue
                if "message-source" in group:
                    sources.add(el.get("name"))
                elif "operator" in group or "message-processor" in group:
                    operations.add(el.get("name"))
                elif "extension" in group or "global" in group:
                    configs.add(el.get("name"))

        member = main_class.replace(".", "/") + ".class" if main_class else None
        if member in names:
            try:
                ann = _class_annotations(z.read(member))
            except (ValueError, struct.error):
                ann = {}
            for desc, values in ann.items():
                if desc.endswith("/dsl/xml/Xml;"):
                    prefix = values.get("prefix") or prefix
                    namespace = values.get("namespace") or namespace
                elif desc.endswith("/annotation/Extension;"):
                    ext_name = values.get("name") or ext_name
        ext_name = ext_name or artifact.get("name")
        prefix = prefix or hyphenize(ext_name or "")
        if not prefix:
            return None

        desc_member = next((n for n in names if n.startswith("META-INF/") and n.endswith("-extension-descriptions.xml")), None)
        if desc_member:
            doc = ET.fromstring(z.read(desc_member))
            operations |= {hyphenize(e.get("name")) for e in doc.iter("operation") if e.get("name")}
            sources |= {hyphenize(e.get("name")) for e in doc.iter("source") if e.get("name")}
            configs |= {hyphenize(e.get("name")) for e in doc.iter("config") if e.get("name")}
        icon_member = next((m for m in ICON_MEMBERS if m in names), None)
        icon = (z.read(icon_member), ICON_MEMBERS[icon_member]) if icon_member else None

    version = (loader.get("attributes") or {}).get("version")
    if not version:
        m = re.search(r"-(\d+\.\d+[^-]*)-mule-plugin\.jar$", jar_path)
        version = m.group(1) if m else None
    return {
        "prefix": prefix,
        "namespace": namespace or f"http://www.mulesoft.org/schema/mule/{prefix}",
        "name": artifact.get("name") or ext_name,
        "version": version,
        "artifact": os.path.basename(jar_path),
        "operations": operations,
        "sources": sources,
        "configs": configs,
        "_icon": icon,
    }


def version_key(connector):
    return [int(p) if p.isdigit() else 0 for p in re.split(r"[.-]", connector.get("version") or "0")]


def scan_connectors(dirs):
    """Newest version wins for name/icon; element lists are merged across versions
    (some releases ship without the descriptions file)."""
    best = {}
    jars = [j for d in dirs if os.path.isdir(d) for j in glob.glob(os.path.join(d, "**", "*-mule-plugin.jar"), recursive=True)]
    for jar in jars:
        try:
            c = read_connector(jar)
        except (zipfile.BadZipFile, KeyError, ET.ParseError, json.JSONDecodeError, OSError, ValueError):
            continue
        if not c:
            continue
        prev = best.get(c["prefix"])
        if prev:
            newer, older = (c, prev) if version_key(c) > version_key(prev) else (prev, c)
            for key in ("operations", "sources", "configs"):
                newer[key] |= older[key]
            newer["_icon"] = newer["_icon"] or older["_icon"]
            c = newer
        best[c["prefix"]] = c
    for c in best.values():
        for key in ("operations", "sources", "configs"):
            c[key] = sorted(c[key])
    return best


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--studio", help="Anypoint Studio Eclipse dir (contains plugins/)")
    ap.add_argument("--m2", default=os.path.expanduser("~/.m2/repository"))
    args = ap.parse_args()

    shutil.rmtree(PACK_DIR, ignore_errors=True)
    os.makedirs(os.path.join(PACK_DIR, "icons"))
    os.makedirs(os.path.dirname(CATALOG), exist_ok=True)
    icons, sources_info = {}, {}

    studio = find_studio(args.studio)
    if studio:
        images, jar_name = studio_images(studio)
        sources_info["studio"] = jar_name
        used = {GENERIC} | set(STUDIO_ICONS.values())
        for name in sorted(used & images.keys()):
            jar, member = images[name]
            with zipfile.ZipFile(jar) as z:
                with open(os.path.join(PACK_DIR, "icons", f"{name}.png"), "wb") as f:
                    f.write(z.read(member))
        for key, name in STUDIO_ICONS.items():
            if name in images:
                icons[key] = f"icons/{name}.png"
        missing = sorted(set(STUDIO_ICONS.values()) - images.keys())
        if missing:
            print(f"studio: no image for {', '.join(missing)}", file=sys.stderr)
    else:
        print("studio: not found, core icons skipped", file=sys.stderr)

    connectors = scan_connectors([args.m2, REMOTE_JARS])
    for prefix, c in connectors.items():
        icon = c.pop("_icon")
        if icon:
            data, ext = icon
            path = f"icons/connector-{prefix}.{ext}"
            with open(os.path.join(PACK_DIR, path), "wb") as f:
                f.write(data)
            icons[f"{prefix}:*"] = path  # connector's own icon beats Studio's raster namespace icon
    sources_info["connectors"] = len(connectors)

    manifest = {
        "name": "MuleSoft (Studio + connectors)",
        "sources": sources_info,
        "icons": dict(sorted(icons.items())),
        "fallback": "icons/generic.png" if os.path.exists(os.path.join(PACK_DIR, "icons", "generic.png")) else None,
    }
    with open(os.path.join(PACK_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    with open(CATALOG, "w") as f:
        json.dump({"connectors": dict(sorted(connectors.items()))}, f, indent=2)

    print(f"icon pack: {len(icons)} mappings -> {os.path.relpath(PACK_DIR, ROOT)}")
    no_icon = sorted(p for p in connectors if f"{p}:*" not in icons)
    print(f"catalog:   {len(connectors)} connectors -> {os.path.relpath(CATALOG, ROOT)}")
    if no_icon:
        print(f"no icon:   {', '.join(no_icon)}")


if __name__ == "__main__":
    main()
