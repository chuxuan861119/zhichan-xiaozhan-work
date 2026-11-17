"""Behavioral regression for native stroke coverage and ordered tile replay."""
import json
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET
import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, layout, svg
from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy
from tiled_svg import write_tiles

class Progress:
    def report(self, *args, **kwargs):
        pass

class StrokeCoverageTest(unittest.TestCase):
    def test_wide_strokes_reach_neighbor_tiles_and_keep_source_order(self):
        doc = ezdxf.new()
        model = doc.modelspace()
        for row in range(260):
            for col in range(200):
                x, y = col / 199 * 100, row / 259 * 100
                model.add_line((x, y), (x + .001, y), dxfattribs={'lineweight': 5})
        model.add_line((49.2, 20), (49.2, 80), dxfattribs={'lineweight': 211})
        backend = svg.SVGBackend()
        Frontend(RenderContext(doc), backend, config=Configuration(color_policy=ColorPolicy.BLACK, background_policy=BackgroundPolicy.WHITE)).draw_layout(model)
        settings = layout.Settings()
        placement = layout.Layout(backend.player().bbox(), flip_y=True)
        page = placement.get_final_page(layout.Page(0, 0, margins=layout.Margins.all(5)), settings)
        full = backend.get_xml_root_element(layout.Page(0, 0, margins=layout.Margins.all(5)))
        paths = [element.attrib['d'] for element in full.iter('path')]
        wide = paths[-1]
        order = {path: i for i, path in enumerate(paths)}
        player = backend.player()
        record, properties = list(player.recordings())[-1]
        renderer = backend.make_backend(page, settings)
        renderer.configure(player.config)
        radius = renderer.resolve_stroke_width(properties.lineweight) / 2
        box = record.bbox()
        width, height = svg.make_view_box(page, settings.output_coordinate_space)
        units = max(width, height) / 2000
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)
            write_tiles(backend, output, 'large', Progress(), prepared=(page, settings))
            index = json.loads((output / 'index.json').read_text())
            self.assertGreater(len(index['tiles']), 1)
            for tile in index['tiles']:
                emitted = [element.attrib['d'] for element in ET.parse(output / (tile['id'] + '.svg')).getroot().iter('{http://www.w3.org/2000/svg}path')]
                self.assertEqual([order[p] for p in emitted], sorted(order[p] for p in emitted))
                c = tile['core']
                for amplification in [1, 2.2, 20]:
                    reach = radius * amplification
                    if box.extmin.x - reach < (c['x'] + c['width']) * units and box.extmax.x + reach > c['x'] * units and box.extmin.y - reach < (c['y'] + c['height']) * units and box.extmax.y + reach > c['y'] * units:
                        self.assertIn(wide, emitted)

if __name__ == '__main__':
    unittest.main()
