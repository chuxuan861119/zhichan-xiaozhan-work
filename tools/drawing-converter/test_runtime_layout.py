"""Run with the pinned development Python; never invoke the user's CAD software."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from prepare_runtime import configure_windows_python

class WindowsLayoutTest(unittest.TestCase):
    def test_isolated_paths_include_bundled_modules_and_exclude_environment(self):
        with tempfile.TemporaryDirectory() as root:
            py = Path(root) / 'python'
            py.mkdir()
            configure_windows_python(py)
            lines = (py / 'python313._pth').read_text().splitlines()
            self.assertEqual(lines, ['python313.zip', '.', '..', 'Lib/site-packages', 'import site'])
            # Model _pth's explicit local entries under -I, which also omits script cwd.
            renderer = Path(__file__).with_name('render_svg.py').resolve()
            code = "import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=[sys.argv[2],'--help'];runpy.run_path(sys.argv[0],run_name='__main__')"
            result = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(renderer.parent), str(renderer)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('--source-bytes', result.stdout)

if __name__ == '__main__':
    unittest.main()
