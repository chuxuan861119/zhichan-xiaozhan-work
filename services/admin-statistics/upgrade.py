"""Versioned upgrade for the existing Tencent host. No credentials in the bundle."""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import time
import urllib.request


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data, mode=0o644, owner=None):
    next_path = path.with_name(path.name + ".v2-next")
    with next_path.open("xb") as stream:
        stream.write(data)
    next_path.chmod(mode)
    if owner:
        os.chown(next_path, owner.st_uid, owner.st_gid)
    os.replace(next_path, path)


def switch(link, target):
    next_link = link.with_name(link.name + ".v2-next")
    next_link.symlink_to(target)
    os.replace(next_link, link)


def run(*args):
    subprocess.run(args, check=True)


def main(bundle_path):
    os.umask(0o077)
    if os.geteuid() != 0:
        raise ValueError("root required")
    bundle = json.loads(gzip.decompress(Path(bundle_path).read_bytes()))
    release = bundle["release"]
    if not re.fullmatch(r"[0-9a-z-]{8,100}", release):
        raise ValueError("release id")
    base = Path("/opt/zcxzz-statistics")
    current = base / "current"
    previous = current.resolve(strict=True)
    if previous.parent != base / "releases":
        raise ValueError("unexpected current release")
    original = (previous / "main.mjs").read_bytes()
    if sha(original) != bundle["baseHash"]:
        raise ValueError("current code differs; nothing changed")
    compiled = original
    boundary = len(original)
    for edit in sorted(bundle["edits"], key=lambda e: e["start"], reverse=True):
        start, end = edit["start"], edit["end"]
        if not 0 <= start <= end <= boundary:
            raise ValueError("overlapping patch")
        boundary = start
        compiled = compiled[:start] + base64.b64decode(edit["data"]) + compiled[end:]
    if sha(compiled) != bundle["targetHash"]:
        raise ValueError("compiled digest mismatch")
    expected = {"public/app.js", "public/app.css", "public/index.html", "backup.py"}
    if set(bundle["files"]) != expected:
        raise ValueError("unexpected file set")
    files = {key: base64.b64decode(value["data"]) for key, value in bundle["files"].items()}
    for key, data in files.items():
        if sha(data) != bundle["files"][key]["sha256"]:
            raise ValueError("asset digest mismatch")
    config_path = Path("/etc/zcxzz/statistics.json")
    config_bytes, config_stat = config_path.read_bytes(), config_path.stat()
    config = json.loads(config_bytes)
    if config["clientReleaseActive"] or config["publicVersionGroups"] or config.get("releases"):
        raise ValueError("unexpected active client release")
    private = Path(config["privateDirectory"])
    if not (private / "administrator.json").is_file():
        raise ValueError("administrator missing")
    target = base / "releases" / release
    if target.exists():
        raise ValueError("release already exists")
    shutil.copytree(previous, target)
    target.chmod(0o755)
    for directory in target.rglob("*"):
        if directory.is_dir():
            directory.chmod(0o755)
    atomic(target / "main.mjs", compiled)
    for key, data in files.items():
        atomic(target / key, data)
    runpy.run_path(str(target / "backup.py"))["backup"](
        config["databasePath"], "/var/backups/zcxzz-statistics", private / "backup-status.json"
    )
    run("/opt/node-v24.22.0-linux-x64/bin/node", "--check", str(target / "main.mjs"))
    atomic(config_path.with_name("statistics-before-" + release + ".json"), config_bytes, 0o600)
    config["releases"] = []
    config["snapshotView"] = "releases"
    switched = False
    try:
        atomic(config_path, (json.dumps(config, indent=2) + "\n").encode(), config_stat.st_mode & 0o777, config_stat)
        switch(current, target)
        switched = True
        run("systemctl", "restart", "zcxzz-statistics")
        for attempt in range(20):
            try:
                with urllib.request.urlopen("http://127.0.0.1:8790/admin-statistics/api/session", timeout=2) as response:
                    session = json.load(response)
                if session.get("setupRequired") is not False:
                    raise ValueError("administrator preservation check")
                break
            except Exception:
                if attempt == 19:
                    raise
                time.sleep(0.5)
        print("APPLICATION_V2_READY; ADMINISTRATOR_PRESERVED; RELEASES_CLOSED")
    except Exception:
        if switched:
            switch(current, previous)
        atomic(config_path, config_bytes, config_stat.st_mode & 0o777, config_stat)
        run("systemctl", "restart", "zcxzz-statistics")
        raise

    service = """[Unit]
Description=Consistent private statistics backup
After=zcxzz-statistics.service
[Service]
Type=oneshot
User=root
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/zcxzz-admin /var/backups/zcxzz-statistics
ExecStart=/usr/bin/python3 /opt/zcxzz-statistics/current/backup.py /var/lib/zcxzz-admin/usage.sqlite /var/backups/zcxzz-statistics /var/lib/zcxzz-admin/backup-status.json
"""
    timer = """[Unit]
Description=Daily private statistics backup
[Timer]
OnCalendar=daily
Persistent=true
AccuracySec=5min
[Install]
WantedBy=timers.target
"""
    for name, text in [("zcxzz-statistics-backup.service", service), ("zcxzz-statistics-backup.timer", timer)]:
        path = Path("/etc/systemd/system") / name
        if path.exists():
            if path.read_text() != text:
                raise ValueError("existing backup unit differs")
        else:
            atomic(path, text.encode())
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "--now", "zcxzz-statistics-backup.timer")
    run("systemctl", "start", "zcxzz-statistics-backup.service")
    print("DAILY_CONSISTENT_BACKUP_READY")

    site = Path("/www/wwwroot/zcxzz")
    site_current = site / "current"
    previous_site = site_current.resolve(strict=True)
    if previous_site.parent != site / "releases" or set(bundle["privacy"]) != {"privacy.html", "privacy/index.html"}:
        raise ValueError("site or privacy paths")
    site_target = site / "releases" / release
    if site_target.exists():
        raise ValueError("site release already exists")
    shutil.copytree(previous_site, site_target, copy_function=os.link, symlinks=True)
    for key, value in bundle["privacy"].items():
        data = base64.b64decode(value["data"])
        if sha(data) != value["sha256"]:
            raise ValueError("privacy digest")
        atomic(site_target / key, data)
    switch(site_current, site_target)
    print("PRIVACY_UPDATED; OTHER_SITE_FILES_PRESERVED")
    print("STATISTICS_V2_UPGRADE_COMPLETE")


if __name__ == "__main__":
    main(sys.argv[1])
