"""Real renderer behavior, independent of DWG source-size hints."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import ezdxf

class UnifiedRenderTest(unittest.TestCase):
    def test_source_size_does_not_change_output_or_force_tiles(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            doc = ezdxf.new()
            model = doc.modelspace()
            model.add_line((0, 0), (100, 70))
            model.add_circle((40, 20), 8)
            source = root / 'source.dxf'
            doc.saveas(source)
            results = []
            for size in [1, 100 * 1024 * 1024]:
                output = root / str(size)
                subprocess.run([sys.executable, str(Path(__file__).with_name('render_svg.py')), str(source), str(output), '--source-bytes', str(size)], check=True, capture_output=True)
                self.assertTrue((output / 'drawing.svg').exists(), 'A source-size hint must not force the tiled path')
                self.assertFalse((output / 'index.json').exists())
                results.append((output / 'drawing.svg').read_bytes())
            self.assertEqual(results[0], results[1])

if __name__ == '__main__':
    unittest.main()
