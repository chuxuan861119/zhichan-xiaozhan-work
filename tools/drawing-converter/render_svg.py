"""Development-only rendering probe; diagnostic output may contain private CAD names."""
import argparse
from collections import Counter
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import time
import sys
from xml.etree import ElementTree as ET

import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, layout, svg
from ezdxf.addons.drawing.recorder import Player
from tiled_svg import write_tiles
from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy, HatchPolicy


class ProgressReporter:
    def __init__(self):
        self.last = 0
        self.phase = None

    def report(self, phase, completed=None, total=None, force=False):
        now = time.monotonic()
        if not force and phase == self.phase and now - self.last < 0.25:
            return
        self.last, self.phase = now, phase
        print('ZXW_CAD_PROGRESS ' + json.dumps({'phase': phase, 'completed': completed, 'total': total or None}), file=sys.stderr, flush=True)


progress = ProgressReporter()


class ProgressPlayer(Player):
    def recordings(self):
        total = len(self.records)
        progress.report('svg', 0, total, force=True)
        for count, item in enumerate(super().recordings(), 1):
            yield item
            if count % 128 == 0:
                progress.report('svg', count, total)
        progress.report('svg', total, total, force=True)


class ProgressSVGBackend(svg.SVGBackend):
    def player(self):
        original = super().player()
        player = ProgressPlayer()
        # Share exactly the same recording references as SVGBackend.player().
        player.__dict__.update(original.__dict__)
        return player


class ProbeFrontend(Frontend):
    def __init__(self, context, backend, entity_total=None):
        self.entity_total = entity_total
        self.progress_depth = 0
        self.skipped = []
        self.messages = []
        self.hatch_calls = 0
        super().__init__(context, backend, config=Configuration(
            color_policy=ColorPolicy.BLACK, background_policy=BackgroundPolicy.WHITE,
            hatch_policy=HatchPolicy.NORMAL))

    def draw_entities(self, entities, *, filter_func=None):
        if self.progress_depth:
            return super().draw_entities(entities, filter_func=filter_func)
        def counted():
            progress.report('draw', 0, self.entity_total, force=True)
            count = 0
            for entity in entities:
                yield entity
                count += 1
                if count % 128 == 0:
                    progress.report('draw', count, self.entity_total)
            progress.report('draw', count, self.entity_total, force=True)
        self.progress_depth += 1
        try:
            super().draw_entities(counted(), filter_func=filter_func)
        finally:
            self.progress_depth -= 1

    def skip_entity(self, entity, message):
        self.skipped.append({'type': entity.dxftype(), 'handle': entity.dxf.handle, 'message': message})

    def log_message(self, message):
        self.messages.append(str(message))

    def draw_hatch_pattern(self, polygon, paths, properties):
        self.hatch_calls += 1
        captured = io.StringIO()
        with redirect_stdout(captured):
            super().draw_hatch_pattern(polygon, paths, properties)
        if captured.getvalue():
            raise RuntimeError('Hatching did not complete: ' + captured.getvalue())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--source-bytes', type=int, default=0)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; refusing to overwrite')
    started = time.perf_counter()
    progress.report('parse', force=True)
    doc = ezdxf.readfile(args.input)
    progress.report('audit', force=True)
    audit = doc.audit()
    backend = ProgressSVGBackend()
    frontend = ProbeFrontend(RenderContext(doc), backend, len(doc.modelspace()))
    frontend.draw_layout(doc.modelspace())
    args.output.mkdir(parents=True, exist_ok=False)
    progress.report('svg', force=True)
    # One bounded vector pipeline for every drawing. Input bytes and file tiers
    # do not select quality or execution paths; only actual output chunks are bounded.
    tile_count, _ = write_tiles(backend, args.output, 'large', progress)
    if tile_count == 1:
        (args.output / 'tile-0.svg').replace(args.output / 'drawing.svg')
        (args.output / 'index.json').unlink()
    report = {
        'ezdxf': ezdxf.__version__, 'elapsedSeconds': time.perf_counter() - started,
        'entities': dict(Counter(e.dxftype() for e in doc.modelspace())),
        'auditErrors': [str(e) for e in audit.errors], 'auditFixes': [str(e) for e in audit.fixes],
        'hatchPatternCalls': frontend.hatch_calls, 'skipped': frontend.skipped,
        'messages': frontend.messages,
        'externalReferences': sum(1 for b in doc.blocks if b.block.is_xref),
    }
    (args.output / 'render-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'complete': True, 'format': 'svg' if tile_count == 1 else 'tiles', 'elapsedSeconds': report['elapsedSeconds']}))


if __name__ == '__main__':
    main()
