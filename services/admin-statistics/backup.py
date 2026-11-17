"""Consistent, bounded latest SQLite backup; no raw website logs or credentials."""
import datetime as dt
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile


def backup(database, directory, status_path):
    source = Path(database)
    destination = Path(directory)
    status = Path(status_path)
    if not source.is_file() or source.is_symlink() or destination.is_symlink() or status.is_symlink():
        raise ValueError("unsafe backup path")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination, 0o700)
    target = destination / "usage-latest.sqlite"
    if target.is_symlink() or source.resolve() == target.resolve():
        raise ValueError("unsafe backup target")
    fd, temporary = tempfile.mkstemp(prefix="usage-next-", suffix=".sqlite", dir=destination)
    os.close(fd)
    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as original:
        with closing(sqlite3.connect(temporary)) as copied:
            original.backup(copied, pages=128, sleep=0.05)
            if copied.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise ValueError("invalid copied database")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
    completed = dt.datetime.now(dt.timezone.utc).isoformat()
    status.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, next_status = tempfile.mkstemp(prefix="backup-status-", dir=status.parent)
    with os.fdopen(fd, "w", encoding="utf8") as out:
        json.dump({"status": "ok", "generatedAt": completed, "strategy": "SQLite online backup; latest successful copy"}, out)
    owner = source.stat()
    if hasattr(os, "chown"):
        os.chown(next_status, owner.st_uid, owner.st_gid)
    os.chmod(next_status, 0o600)
    os.replace(next_status, status)
    return target


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise ValueError("arguments")
        backup(*sys.argv[1:])
        print("Consistent statistics backup completed.")
    except Exception:
        print("Statistics backup failed; previous successful copy is preserved.", file=sys.stderr)
        sys.exit(1)
