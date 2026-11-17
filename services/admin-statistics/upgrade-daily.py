"""Install the reviewed protocol-4 bundle; preserve accounts/data, QA in isolation and roll back failures."""
import base64
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

NODE = "/opt/node-v24.22.0-linux-x64/bin/node"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data, mode=0o600):
    temporary = path.with_name(path.name + ".daily-v4-next")
    with temporary.open("xb") as stream:
        stream.write(data)
    temporary.chmod(mode)
    if path.exists():
        stat = path.stat()
        os.chown(temporary, stat.st_uid, stat.st_gid)
    os.replace(temporary, path)


def switch(current, target):
    temporary = current.with_name("current.daily-v4-next")
    temporary.symlink_to(target)
    os.replace(temporary, current)


def wait_ready(port):
    for attempt in range(30):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/admin-statistics/api/session", timeout=2) as response:
                return json.load(response)
        except (OSError, ValueError):
            if attempt == 29:
                raise
            time.sleep(0.2)


def main(bundle_path):
    if os.geteuid() != 0:
        raise ValueError("root required")
    os.umask(0o077)
    bundle = json.loads(gzip.decompress(Path(bundle_path).read_bytes()))
    if bundle["release"] != "20261018-statistics-daily-v4":
        raise ValueError("release")
    base = Path("/opt/zcxzz-statistics")
    current = base / "current"
    previous = current.resolve(strict=True)
    if previous.parent != base / "releases" or sha((previous / "main.mjs").read_bytes()) != bundle["baseHash"]:
        raise ValueError("base differs; refusing to overwrite another deployment")
    files = {key: base64.b64decode(item["data"], validate=True) for key, item in bundle["files"].items()}
    if set(files) != {"main.mjs", "public/app.js", "public/app.css", "public/index.html"}:
        raise ValueError("server file set")
    if any(sha(data) != bundle["files"][key]["sha256"] for key, data in files.items()):
        raise ValueError("server digest")
    target = base / "releases" / bundle["release"]
    if target.exists():
        if any(not (target / key).exists() or sha((target / key).read_bytes()) != sha(data) for key, data in files.items()):
            raise ValueError("staged release differs")
    else:
        shutil.copytree(previous, target)
        for key, data in files.items():
            atomic(target / key, data, 0o644)
    subprocess.run([NODE, "--check", str(target / "main.mjs")], check=True)
    config_path = Path("/etc/zcxzz/statistics.json")
    original = config_path.read_bytes()
    config = json.loads(original)
    account = Path(config["privateDirectory"]) / "administrator.json"
    account_before = account.read_bytes()
    qa = Path(tempfile.mkdtemp(prefix="zcxzz-daily-v4-qa-", dir="/root"))
    qa.chmod(0o700)
    private = qa / "private"
    private.mkdir(mode=0o700)
    test_config = {**config, "privateDirectory": str(private), "databasePath": str(qa / "usage.sqlite"), "trafficPath": str(qa / "traffic.json"), "origin": "http://127.0.0.1:18790", "port": 18790, "usagePort": 18789, "assetsDirectory": str(target / "public")}
    (qa / "config.json").write_text(json.dumps(test_config))
    with (qa / "process.log").open("wb") as log:
        process = subprocess.Popen([NODE, str(target / "main.mjs"), str(qa / "config.json")], stdout=log, stderr=log)
        try:
            wait_ready(18790)
            day = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date()
            payload = {"schema_version": 3, "report_id": "8d05cc78-9110-4975-a3eb-240dff9a3000", "day": str(day - datetime.timedelta(days=7)), "platform": "windows", "app_version": "1.1.2", "release_channel": "preview", "active_installation_days": 1, "duration_buckets": {"lt_1m": 0, "m1_5": 1, "m5_15": 0, "m15_30": 0, "m30_60": 0, "ge_60m": 0}}
            def post(body):
                request = urllib.request.Request("http://127.0.0.1:18789/v1/usage/daily-aggregate", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(request, timeout=3) as response:
                        return response.status
                except urllib.error.HTTPError as error:
                    return error.code
            assert post(payload) == 204
            assert post(payload) == 204
            assert post({**payload, "report_id": payload["report_id"].upper()}) == 204
            assert post({**payload, "duration_buckets": {**payload["duration_buckets"], "m1_5": 2}}) == 409
            assert post({**payload, "day": str(day)}) == 400
            assert post({**payload, "day": str(day - datetime.timedelta(days=8))}) == 400
            assert post({**payload, "device_id": "forbidden"}) == 400
            old = {key: value for key, value in payload.items() if key != "report_id"}
            assert post({**old, "schema_version": 2}) == 400
            with sqlite3.connect(qa / "usage.sqlite") as db:
                assert db.execute("SELECT SUM(active_installation_days) FROM release_activity").fetchone()[0] == 1
                assert db.execute("SELECT COUNT(*) FROM usage_receipt").fetchone()[0] == 1
                assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            preview = {**payload, "schema_version": 4, "day": str(day - datetime.timedelta(days=1))}
            import uuid
            for index in range(12):
                item = {**preview, "report_id": str(uuid.uuid4())}
                assert post(item) == 204
                assert post(item) == 204
            with sqlite3.connect(qa / "usage.sqlite") as db:
                assert db.execute("SELECT SUM(active_installation_days) FROM preview_activity").fetchone()[0] == 12
                assert db.execute("SELECT SUM(active_installation_days) FROM release_activity").fetchone()[0] == 13
                assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            print("ISOLATED_V4_QA_PASSED: v4 preview aggregate 12, replay unchanged; legacy aggregate retained;")
            print("ISOLATED_V3_QA_PASSED: seven-day late report, idempotent replay, conflict and invalid payloads; one contribution; no production test contribution")
        finally:
            process.terminate()
            process.wait(timeout=10)
    subprocess.run(["systemctl", "start", "zcxzz-statistics-backup.service"], check=True)
    backup = config_path.with_name("statistics.before-daily-v4-20261018.json")
    if not backup.exists():
        with backup.open("xb") as stream:
            stream.write(original)
        backup.chmod(0o600)
    webroot = Path("/www/wwwroot/zcxzz/current").resolve(strict=True)
    website = {}
    allowed_pages = {"privacy.html", "privacy/index.html", "manual.html", "docs/work/index.html", "manual/user-guide.md"}
    for key, item in bundle.get("website", {}).items():
        if key not in allowed_pages and not re.fullmatch(r"assets/[A-Za-z0-9_./-]+\.(js|css)", key):
            raise ValueError("unexpected website file")
        if ".." in Path(key).parts:
            raise ValueError("website traversal")
        data = base64.b64decode(item["data"], validate=True)
        if sha(data) != item["sha256"]:
            raise ValueError("website digest")
        path = webroot / key
        if key.startswith("assets/") and path.exists() and path.read_bytes() != data:
            raise ValueError("existing fingerprinted asset differs")
        website[key] = data
    web_backup = qa / "website-before"
    web_backup.mkdir(mode=0o700)
    changed = []
    try:
        switch(current, target)
        subprocess.run(["systemctl", "restart", "zcxzz-statistics"], check=True)
        assert wait_ready(config["port"])["setupRequired"] is False
        assert account.read_bytes() == account_before
        assert config_path.read_bytes() == original
        assert Path("/www/wwwroot/zcxzz/current").resolve() == webroot
        for key, data in website.items():
            path = webroot / key
            if path.exists() and path.read_bytes() == data:
                continue
            old_path = web_backup / key
            if path.exists():
                old_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, old_path)
            missing = []
            parent = path.parent
            while not parent.exists():
                missing.append(parent)
                parent = parent.parent
            for directory in reversed(missing):
                directory.mkdir(mode=0o755)
                directory.chmod(0o755)
            atomic(path, data, 0o644)
            changed.append(key)
        assert Path("/www/wwwroot/zcxzz/current").resolve() == webroot
        print("DAILY_V4_LIVE; ACCOUNT_CONFIG_PRESERVED; WEBSITE_LAYOUT_AND_INSTALLER_UNCHANGED")
        print("CURRENT_RELEASE", target)
        print("MAIN_SHA256", sha(files["main.mjs"]))
        print("WEBSITE_POLICY_AND_MANUAL_UPDATED", len(changed))
        print("ROLLBACK_PREVIOUS", previous)
        print("PRIVATE_BACKUP", qa)
    except Exception:
        for key in changed:
            old = web_backup / key
            if old.exists():
                atomic(webroot / key, old.read_bytes(), 0o644)
        switch(current, previous)
        subprocess.run(["systemctl", "restart", "zcxzz-statistics"], check=True)
        raise


if __name__ == "__main__":
    main(sys.argv[1])
