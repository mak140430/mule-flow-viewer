#!/usr/bin/env python3
"""Fetch the metadata of every published Mule 4 connector/module (latest version).

Where the list comes from:
  * MuleSoft Nexus "public"  (search API, anonymous)
  * Anypoint Exchange        (all extensions of the MuleSoft organization, anonymous)

Where the jars come from, in order: Nexus public, then the repositories in ~/.m2/settings.xml
(Exchange Maven, releases-ee) using the credentials configured there.

Jars are never downloaded whole: HTTP range requests read the zip index and only the entries the
extractor needs (mule-artifact.json, icon.svg, extension descriptions, schema, main class).
Each result is cached as a small jar in generated/remote-jars/, which extract_icon_pack.py scans.

Usage:  python3 tools/fetch_connectors.py [--workers 8] [--limit N] [--refresh]
"""
import argparse
import base64
import concurrent.futures
import http.client as http_client
import io
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "generated", "remote-jars")
NEXUS = "https://repository.mulesoft.org/nexus"
NEXUS_PUBLIC = f"{NEXUS}/content/repositories/public"
NEXUS_GROUPS = ["org.mule.connectors", "com.mulesoft.connectors", "org.mule.modules", "com.mulesoft.modules"]
EXCHANGE = "https://anypoint.mulesoft.com/exchange/api/v2/assets"
MULESOFT_ORG = "68ef9520-24e9-4cf2-b2f5-620025690913"
# MuleSoft publishes SDK test fixtures and accelerator samples alongside real connectors.
NOT_CONNECTORS = re.compile(r"^(extension-with-|extension-stress-|smart-connector-|basic-connector$|mule-test-module$|"
                            r"mule-connection-test-module$|mule-plugin-with-no-extension-model$)")
NOT_CONNECTOR_GROUPS = {"org.mule.examples"}
KNOWN_REPOS = {"mulesoft-releases-ee": "https://repository.mulesoft.org/nexus-ee/content/repositories/releases-ee"}


# --------------------------------------------------------------------------- repositories

def settings_repositories(path=os.path.expanduser("~/.m2/settings.xml")):
    """[(id, url, auth_header|None)] from settings.xml. Credentials stay in this process."""
    if not os.path.exists(path):
        return []
    root = ET.parse(path).getroot()
    ns = {"m": root.tag[1:].split("}")[0]} if root.tag.startswith("{") else {}
    q = (lambda t: f"m:{t}") if ns else (lambda t: t)
    auth = {}
    for s in root.iterfind(f".//{q('servers')}/{q('server')}", ns):
        sid, user, pw = (s.findtext(q(t), default="", namespaces=ns).strip() for t in ("id", "username", "password"))
        if sid and user:
            auth[sid] = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
    repos = {}
    for r in root.iterfind(f".//{q('repository')}", ns):
        rid, url = r.findtext(q("id"), "", ns).strip(), r.findtext(q("url"), "", ns).strip()
        if rid and url:
            repos[rid] = url.rstrip("/")
    for rid, url in KNOWN_REPOS.items():
        if rid in auth:
            repos.setdefault(rid, url)
    return [(rid, url, auth.get(rid)) for rid, url in repos.items()]


class HttpError(Exception):
    pass


def http(url, auth=None, rng=None, timeout=60, attempts=4):
    """GET with retries on transient failures (dropped connections, timeouts, 5xx)."""
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": "mule-flow-viewer"})
        if auth:
            # not forwarded on redirect: Exchange redirects to pre-signed storage URLs
            req.add_unredirected_header("Authorization", auth)
        if rng:
            req.add_header("Range", rng)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == attempts - 1:
                raise HttpError(f"{e.code}") from None
        except (urllib.error.URLError, http_client.HTTPException, TimeoutError, ConnectionError) as e:
            if attempt == attempts - 1:
                raise HttpError(type(e).__name__) from None
        time.sleep(1.5 * (attempt + 1))


class RemoteZip:
    """Reads selected entries of a remote zip with range requests."""

    def __init__(self, url, auth=None):
        self.url, self.auth, self.whole = url, auth, None
        try:
            status, tail = http(url, auth, "bytes=-65557")
        except HttpError as e:
            if str(e) != "416":  # some servers refuse suffix ranges longer than the file
                raise
            status, tail = http(url, auth)
        if status == 200:  # small file or no range support: the whole jar came back
            self.whole = zipfile.ZipFile(io.BytesIO(tail))
            self.entries = {n: None for n in self.whole.namelist()}
            return
        eocd = tail.rfind(b"PK\x05\x06")
        if eocd < 0:
            raise HttpError("not a zip")
        cd_size, cd_offset = struct.unpack_from("<II", tail, eocd + 12)
        _, cd = http(url, auth, f"bytes={cd_offset}-{cd_offset + cd_size - 1}")
        self.entries = {}
        p = 0
        while p + 46 <= len(cd) and cd[p:p + 4] == b"PK\x01\x02":
            method, = struct.unpack_from("<H", cd, p + 10)
            csize, usize = struct.unpack_from("<II", cd, p + 20)
            nlen, elen, clen = struct.unpack_from("<HHH", cd, p + 28)
            offset, = struct.unpack_from("<I", cd, p + 42)
            name = cd[p + 46:p + 46 + nlen].decode("utf-8", "replace")
            self.entries[name] = (method, csize, offset)
            p += 46 + nlen + elen + clen

    def namelist(self):
        return list(self.entries)

    def read(self, name):
        if self.whole:
            return self.whole.read(name)
        method, csize, offset = self.entries[name]
        _, data = http(self.url, self.auth, f"bytes={offset}-{offset + 30 + 1024 + csize}")
        nlen, elen = struct.unpack_from("<HH", data, 26)
        body = data[30 + nlen + elen:30 + nlen + elen + csize]
        return zlib.decompress(body, -15) if method == 8 else body


def wanted(names):
    out = [n for n in names if n in ("META-INF/mule-artifact/mule-artifact.json", "META-INF/mule-artifact/icon.svg")
           or (n.startswith("META-INF/") and n.endswith("-extension-descriptions.xml"))
           or re.fullmatch(r"META-INF/mule-[^/]+\.xsd", n)]
    return out


# --------------------------------------------------------------------------- listing

def version_key(v):
    stable = re.fullmatch(r"\d+(\.\d+)*", v) is not None
    return (stable, [int(x) if x.isdigit() else -1 for x in re.split(r"[.-]", v)])


def list_nexus():
    """{(group, artifact): version} plus {(group, artifact, version): jar download URL}.
    The URL matters for snapshot builds, whose file names carry a timestamp."""
    found = {}
    for g in NEXUS_GROUPS:
        token = None
        while True:
            q = {"repository": "public", "group": g, "maven.classifier": "mule-plugin"}
            if token:
                q["continuationToken"] = token
            _, body = http(f"{NEXUS}/service/rest/v1/search?{urllib.parse.urlencode(q)}")
            d = json.loads(body)
            for i in d["items"]:
                key = (i["group"], i["name"])
                jar = next((x["downloadUrl"] for x in i.get("assets", []) if x["path"].endswith("-mule-plugin.jar")), None)
                if jar:
                    URLS[(i["group"], i["name"], i["version"])] = jar
                if key not in found or version_key(i["version"]) > version_key(found[key]):
                    found[key] = i["version"]
            token = d.get("continuationToken")
            if not token:
                break
    return found


URLS = {}


def list_exchange():
    assets, offset = [], 0
    while True:
        q = {"types": "extension", "organizationId": MULESOFT_ORG, "limit": 100, "offset": offset}
        _, body = http(f"{EXCHANGE}?{urllib.parse.urlencode(q)}")
        page = json.loads(body)
        assets += page
        offset += 100
        if len(page) < 100:
            return {(a["groupId"], a["assetId"]): a for a in assets}


# --------------------------------------------------------------------------- fetching

def jar_path(repo_url, g, a, v):
    return f"{repo_url}/{g.replace('.', '/')}/{a}/{v}/{a}-{v}-mule-plugin.jar"


def fetch_one(g, a, v, repos, exchange_icon):
    out = os.path.join(CACHE, g, f"{a}-{v}-mule-plugin.jar")
    if os.path.exists(out):
        return "cached", None
    errors = []
    candidates = [("nexus-public", URLS.get((g, a, v)) or jar_path(NEXUS_PUBLIC, g, a, v), None)]
    candidates += [(rid, jar_path(url, g, a, v), auth) for rid, url, auth in repos]
    for rid, jar_url, auth in candidates:
        try:
            z = RemoteZip(jar_url, auth)
        except (HttpError, OSError, struct.error) as e:
            errors.append(f"{rid}:{e}")
            continue
        names = wanted(z.namelist())
        files = {n: z.read(n) for n in names}
        art = files.get("META-INF/mule-artifact/mule-artifact.json")
        main = (json.loads(art).get("extensionModelLoaderDescriptor") or {}).get("attributes", {}).get("type") if art else None
        member = main.replace(".", "/") + ".class" if main else None
        if member in z.entries:
            files[member] = z.read(member)
        if "META-INF/mule-artifact/icon.svg" not in files and exchange_icon:
            try:
                _, icon = http(exchange_icon)
                files["META-INF/mule-artifact/icon.svg" if icon.lstrip()[:5] in (b"<?xml", b"<svg ") else "META-INF/mule-artifact/icon.png"] = icon
            except (HttpError, OSError):
                pass
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with zipfile.ZipFile(out + ".tmp", "w", zipfile.ZIP_DEFLATED) as zf:
            for n, data in files.items():
                zf.writestr(n, data)
        os.replace(out + ".tmp", out)
        return rid, None
    return None, "; ".join(errors)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--refresh", action="store_true", help="re-fetch cached artifacts")
    args = ap.parse_args()

    t0 = time.time()
    nexus, exchange = list_nexus(), list_exchange()
    targets = dict(nexus)
    for key, asset in exchange.items():
        if key not in targets or version_key(asset["version"]) > version_key(targets[key]):
            targets[key] = asset["version"]
    targets = {(g, a): v for (g, a), v in targets.items() if g not in NOT_CONNECTOR_GROUPS and not NOT_CONNECTORS.match(a)}
    print(f"listed {len(targets)} artifacts (nexus {len(nexus)}, exchange {len(exchange)}) in {time.time() - t0:.0f}s", flush=True)

    if args.refresh:
        import shutil
        shutil.rmtree(CACHE, ignore_errors=True)
    repos = settings_repositories()
    print("authenticated repositories:", ", ".join(rid for rid, _, auth in repos if auth) or "none", flush=True)

    items = sorted(targets.items())[: args.limit]
    stats, failures = {}, []
    with concurrent.futures.ThreadPoolExecutor(args.workers) as pool:
        futures = {pool.submit(fetch_one, g, a, v, repos, (exchange.get((g, a)) or {}).get("icon")): (g, a, v)
                   for (g, a), v in items}
        for i, f in enumerate(concurrent.futures.as_completed(futures), 1):
            g, a, v = futures[f]
            try:
                source, error = f.result()
            except Exception as e:  # keep going; one bad artifact must not stop the run
                source, error = None, repr(e)
            stats[source or "failed"] = stats.get(source or "failed", 0) + 1
            if error:
                failures.append(f"{g}:{a}:{v}  {error}")
            if i % 25 == 0:
                print(f"  {i}/{len(items)} {stats}", flush=True)

    print(f"done in {time.time() - t0:.0f}s: {stats}")
    if failures:
        with open(os.path.join(ROOT, "generated", "fetch-failures.txt"), "w") as fh:
            fh.write("\n".join(sorted(failures)) + "\n")
        print(f"{len(failures)} not fetched -> generated/fetch-failures.txt")


if __name__ == "__main__":
    sys.exit(main())
