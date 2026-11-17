"""Upgrade the existing private console and collector; preserve account, config and database."""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request


def sha(data):
    return hashlib.sha256(data).hexdigest()


def switch(current, target):
    temporary = current.with_name("current.traffic-next")
    temporary.symlink_to(target)
    os.replace(temporary, current)


def run(*args):
    subprocess.run(args, check=True)


def main(bundle_path):
    os.umask(0o077)
    if os.geteuid() != 0:
        raise ValueError("root required")
    bundle = json.loads(gzip.decompress(Path(bundle_path).read_bytes()))
    if bundle["release"] != "20261017-traffic-v3":
        raise ValueError("release")
    base = Path("/opt/zcxzz-statistics")
    current = base / "current"
    previous = current.resolve(strict=True)
    if previous.parent != base / "releases":
        raise ValueError("current path")
    compiled = (previous / "main.mjs").read_bytes()
    if sha(compiled) != bundle["baseHash"]:
        raise ValueError("base code differs")
    boundary = len(compiled)
    for edit in sorted(bundle["edits"], key=lambda e:e["start"], reverse=True):
        start, end = edit["start"], edit["end"]
        if not 0 <= start <= end <= boundary:
            raise ValueError("overlapping patch")
        compiled = compiled[:start] + base64.b64decode(edit["data"]) + compiled[end:]
        boundary = start
    if sha(compiled) != bundle["targetHash"]:
        raise ValueError("target digest")
    expected = {"public/app.js", "public/app.css", "public/index.html", "traffic.py"}
    if set(bundle["files"]) != expected:
        raise ValueError("file set")
    files = {key:base64.b64decode(value["data"]) for key,value in bundle["files"].items()}
    if any(sha(data) != bundle["files"][key]["sha256"] for key,data in files.items()):
        raise ValueError("asset digest")
    config_path = Path("/etc/zcxzz/statistics.json")
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    target = base / "releases" / bundle["release"]
    if target.exists():
        raise ValueError("release exists")
    run("systemctl", "start", "zcxzz-statistics-backup.service")
    shutil.copytree(previous, target)
    target.chmod(0o755)
    for path in target.rglob("*"):
        if path.is_dir():
            path.chmod(0o755)
    for key,data in {"main.mjs":compiled, **files}.items():
        path = target / key
        temporary = path.with_name(path.name + ".traffic-next")
        with temporary.open("xb") as stream:
            stream.write(data)
        temporary.chmod(0o644)
        os.replace(temporary,path)
    run("/opt/node-v24.22.0-linux-x64/bin/node", "--check", str(target / "main.mjs"))
    # Verify the collector without reading production access logs before switching.
    run("python3", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", str(target / "traffic.py"))
    try:
        switch(current,target)
        run("systemctl", "restart", "zcxzz-statistics")
        for attempt in range(20):
            try:
                with urllib.request.urlopen("http://127.0.0.1:8790/admin-statistics/api/session",timeout=2) as response:
                    if json.load(response).get("setupRequired") is not False:
                        raise ValueError("administrator missing")
                break
            except Exception:
                if attempt == 19:
                    raise
                time.sleep(0.5)
        run("systemctl", "start", "zcxzz-statistics-collector.service")
        report = json.loads(Path(config["trafficPath"]).read_bytes())
        if report.get("schemaVersion") != 2:
            raise ValueError("collector not updated")
        total = sum(d["pages"] for d in report["days"].values())
        for rows,key in [(report["pages"],"count"),(report["products"],"pages"),(report["hours"],"pages")]:
            if sum(row[key] for row in rows) != total:
                raise ValueError("inconsistent page grouping")
        for d in report["days"].values():
            if d["pages"] != d["automatedPages"]+d["unmarkedPages"]+d["unknownPages"]:
                raise ValueError("inconsistent classification")
        if config_path.read_bytes() != config_bytes:
            raise ValueError("configuration changed")
        print("TRAFFIC_V3_READY; ACCOUNT_CONFIG_DATABASE_PRESERVED")
        print("PAGE_PRODUCT_HOUR_AND_AUTOMATION_TOTALS_MATCH")
        print("COLLECTOR_UPDATED:",report["generatedAt"])
        print("MAIN_SHA256:",sha(compiled))
    except Exception:
        switch(current,previous)
        run("systemctl", "restart", "zcxzz-statistics")
        run("systemctl", "start", "zcxzz-statistics-collector.service")
        raise


if __name__ == "__main__":
    main(sys.argv[1])
