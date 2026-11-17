import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("statistics_backup", Path(__file__).with_name("backup.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTest(unittest.TestCase):
    def test_wal_restore_and_failed_source_preserves_successful_copy(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "usage.sqlite"
            live = sqlite3.connect(source)
            live.execute("PRAGMA journal_mode=WAL")
            live.execute("CREATE TABLE contributions (count INTEGER)")
            live.execute("INSERT INTO contributions VALUES (10)")
            live.commit()
            status = root / "private" / "status.json"
            target = module.backup(source, root / "backups", status)
            # Restore by opening the standalone copy without any source WAL files.
            with closing(sqlite3.connect(target)) as restored:
                self.assertEqual(restored.execute("SELECT count FROM contributions").fetchall(), [(10,)])
                self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(json.loads(status.read_text())["status"], "ok")
            before = target.read_bytes()
            with self.assertRaises(ValueError):
                module.backup(root / "absent.sqlite", root / "backups", status)
            self.assertEqual(target.read_bytes(), before)
            live.execute("INSERT INTO contributions VALUES (11)")
            live.commit()
            module.backup(source, root / "backups", status)
            with closing(sqlite3.connect(target)) as restored:
                self.assertEqual(restored.execute("SELECT SUM(count) FROM contributions").fetchone(), (21,))
            live.close()


if __name__ == "__main__":
    unittest.main()
