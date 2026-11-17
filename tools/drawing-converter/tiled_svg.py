"""Bounded, ordered SVG replay in one shared coordinate system (ezdxf 1.4.4)."""
import hashlib
import json
from pathlib import Path
from xml.etree import ElementTree as ET
import numpy as np
from ezdxf.addons.drawing import layout, svg, recorder

MIB = 1024 * 1024


def write_tiles(backend, output: Path, tier, progress, prepared=None):
    player = backend.player()
    if prepared is None:
        settings = layout.Settings()
        placement = layout.Layout(player.bbox(), flip_y=True)
        page = placement.get_final_page(layout.Page(0, 0, margins=layout.Margins.all(5)), settings)
        player.transform(placement.get_placement_matrix(page, settings=settings, top_origin=True))
    else:
        page, settings = prepared
    width, height = svg.make_view_box(page, settings.output_coordinate_space)
    world_scale = 2000 / max(width, height)
    # The renderer resolves mm/relative line weights after placement. Use its actual
    # stroke width, including round caps/joins, rather than centerline bounds.
    stroke_backend = backend.make_backend(page, settings)
    stroke_backend.configure(player.config)
    maximum_radius = 0
    boxes = np.empty((len(player.records), 4), dtype=np.float64)
    for i, (record, properties) in enumerate(player.recordings()):
        box = record.bbox()
        radius = stroke_backend.resolve_stroke_width(properties.lineweight) / 2 + 1
        maximum_radius = max(maximum_radius, radius)
        # Fixed display strokes can expand at the editor's 5% minimum zoom;
        # allow 20x plus density-bucket rounding without inflating tile bitmaps.
        reach = radius * 32
        boxes[i] = (box.extmin.x - reach, box.extmin.y - reach,
                    box.extmax.x + reach, box.extmax.y + reach) if box.has_data else (0, 0, width, height)
        if i % 4096 == 0:
            progress.report('svg', i, len(player.records), force=True)
    bleed = max(width, height) / 2000 * 8 + maximum_radius
    tiles, total_bytes = [], 0

    def emit(core, indices, depth=0):
        nonlocal total_bytes
        x, y, w, h = core
        left, top = max(0, x - bleed), max(0, y - bleed)
        right, bottom = min(width, x + w + bleed), min(height, y + h + bleed)
        b = boxes[indices]
        chosen = indices[(b[:, 0] <= right) & (b[:, 2] >= left) & (b[:, 1] <= bottom) & (b[:, 3] >= top)]

        def split():
            if depth >= 12 or len(tiles) >= 4092:
                raise RuntimeError('CAD_OUTPUT_TOO_LARGE')
            if w >= h:
                emit((x, y, w / 2, h), chosen, depth + 1)
                emit((x + w / 2, y, w / 2, h), chosen, depth + 1)
            else:
                emit((x, y, w, h / 2), chosen, depth + 1)
                emit((x, y + h / 2, w, h / 2), chosen, depth + 1)

        if len(chosen) > 60_000 and depth >= 9:
            raise RuntimeError('CAD_OUTPUT_TOO_LARGE')
        if len(chosen) > 50_000 and depth < 9:
            split()
            return
        partial = recorder.Player()
        partial.config, partial.background, partial.properties = player.config, player.background, player.properties
        partial.records = [player.records[int(i)] for i in chosen]
        rendered = backend.make_backend(page, settings)
        partial.replay(rendered)
        root = rendered.get_xml_root_element()
        root.set('viewBox', f'{left} {top} {right-left} {bottom-top}')
        root.set('width', str((right-left) * world_scale))
        root.set('height', str((bottom-top) * world_scale))
        root.set('preserveAspectRatio', 'none')
        content = ET.tostring(root, encoding='utf-8', xml_declaration=True)
        if len(content) > 6 * MIB and depth < 12 and len(chosen) > 1:
            split()
            return
        if len(content) > 8 * MIB or len(tiles) >= 4094:
            raise RuntimeError('CAD_OUTPUT_TOO_LARGE')
        total_bytes += len(content)
        if total_bytes > 512 * MIB:
            raise RuntimeError('CAD_OUTPUT_TOO_LARGE')
        tile_id = f'tile-{len(tiles)}'
        (output / f'{tile_id}.svg').write_bytes(content)
        def rect(a, b, c, d):
            return dict(x=a * world_scale, y=b * world_scale, width=c * world_scale, height=d * world_scale)
        tiles.append(dict(id=tile_id, core=rect(x,y,w,h), render=rect(left,top,right-left,bottom-top),
                          byteLength=len(content), sha256=hashlib.sha256(content).hexdigest().upper()))
        progress.report('serialize', len(tiles), force=True)

    emit((0, 0, width, height), np.arange(len(player.records)))
    index = dict(version=1, width=width * world_scale, height=height * world_scale,
                 tier=tier, primitives=len(player.records), tiles=tiles)
    (output / 'index.json').write_text(json.dumps(index, separators=(',', ':')), encoding='utf-8')
    return len(tiles), total_bytes
