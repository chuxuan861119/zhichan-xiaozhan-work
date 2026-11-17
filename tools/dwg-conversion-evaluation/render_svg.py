"""Development-only rendering probe; diagnostic output may contain private CAD names."""
import argparse
from collections import Counter
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import time

import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, layout, svg
from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy, HatchPolicy


class ProbeFrontend(Frontend):
    def __init__(self, context, backend):
        self.skipped = []
        self.messages = []
        self.hatch_calls = 0
        super().__init__(context, backend, config=Configuration(
            color_policy=ColorPolicy.BLACK, background_policy=BackgroundPolicy.WHITE,
            hatch_policy=HatchPolicy.NORMAL))

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
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; refusing to overwrite')
    started = time.perf_counter()
    doc = ezdxf.readfile(args.input)
    audit = doc.audit()
    backend = svg.SVGBackend()
    frontend = ProbeFrontend(RenderContext(doc), backend)
    frontend.draw_layout(doc.modelspace())
    content = backend.get_string(layout.Page(0, 0, margins=layout.Margins.all(5)))
    report = {
        'ezdxf': ezdxf.__version__, 'elapsedSeconds': time.perf_counter() - started,
        'entities': dict(Counter(e.dxftype() for e in doc.modelspace())),
        'auditErrors': [str(e) for e in audit.errors], 'auditFixes': [str(e) for e in audit.fixes],
        'hatchPatternCalls': frontend.hatch_calls, 'skipped': frontend.skipped,
        'messages': frontend.messages,
        'externalReferences': sum(1 for b in doc.blocks if b.block.is_xref),
    }
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'drawing.svg').write_text(content, encoding='utf-8')
    (args.output / 'render-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
