import { DOMParser as XmlDomParser, XMLSerializer as XmlSerializer } from "@xmldom/xmldom";
import { vi } from "vitest";
import {
  fixedStrokeWidth,
  prepareSvgPreview,
  previewGeometry,
  scaleSvgStrokeWidths,
  sharedSvgPreview,
} from "./fixed-line-preview";

const cadStyle =
  "<style>.C1 {stroke: #000000; stroke-width: 2; stroke-opacity: 1; fill: none; fill-opacity: 1;}</style>";
const cadPaths = '<path class="C1" d="M0 0L10 10"/><path class="C1" d="M20 20L30 30"/>';

test("native checkpoint polylines share bounded display paths without rewriting the export", () => {
  const body = Array.from(
    { length: 130 },
    (_, i) =>
      `<polyline fill="none" stroke="#000000" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round" points="${i},0 ${i},10 "/>`,
  ).join("");
  const bytes = new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" data-cad-stroke-unit="0.5" viewBox="0 0 200 100">${body}</svg>`,
  );
  const draw = prepareSvgPreview(bytes, { width: 200, height: 100 });
  const geometry = previewGeometry(
    { width: 200, height: 100 },
    { x: 0, y: 0, width: 200, height: 100 },
    200,
    100,
    1,
  );
  const display = new DOMParser().parseFromString(draw(geometry, true), "image/svg+xml");
  expect(display.querySelectorAll("polyline")).toHaveLength(0);
  const paths = [...display.querySelectorAll("path")];
  expect(paths).toHaveLength(3);
  expect(
    paths
      .map((p) => p.getAttribute("d"))
      .join(" ")
      .match(/M/g),
  ).toHaveLength(130);
  expect(paths.every((p) => p.getAttribute("stroke-width") === "1")).toBe(true);
  expect(draw(geometry, false).match(/<polyline/g)).toHaveLength(130);
  expect(new TextDecoder().decode(bytes)).toContain(body);
});

test("native display batches preserve paint order and keep unsupported compositing separate", () => {
  const stroke = (extra = "") =>
    `<polyline fill="none" stroke="#000000" stroke-width="1" points="0,0 10,10" ${extra}/>`;
  const body = `${stroke()}${stroke()}<path d="M0 0L10 0L10 10Z" fill="white"/>${stroke()}${stroke('opacity="0.5"')}${stroke('stroke-dasharray="2 1"')}${stroke()}`;
  const draw = prepareSvgPreview(
    new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`,
    ),
    { width: 100, height: 100 },
  );
  const g = previewGeometry(
    { width: 100, height: 100 },
    { x: 0, y: 0, width: 100, height: 100 },
    100,
    100,
    1,
  );
  const display = new DOMParser().parseFromString(draw(g, true), "image/svg+xml");
  const shapes = [...display.querySelectorAll("path,polyline")];
  expect(shapes.map((p) => p.localName)).toEqual([
    "path",
    "path",
    "path",
    "polyline",
    "polyline",
    "path",
  ]);
  expect(shapes[1]?.getAttribute("fill")).toBe("white");
  expect(shapes[3]?.getAttribute("opacity")).toBe("0.5");
  expect(shapes[4]?.getAttribute("stroke-dasharray")).toBe("2 1");
});
test("worker XML adapter preserves CAD batching and viewport rendering", () => {
  const bytes = new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">${cadStyle}${cadPaths}</svg>`,
  );
  const parse = vi.fn(
    (xml: string) =>
      new XmlDomParser().parseFromString(xml, "image/svg+xml") as unknown as Document,
  );
  const serialize = (node: Node) => new XmlSerializer().serializeToString(node as never);
  const draw = prepareSvgPreview(bytes, { width: 100, height: 80 }, { parse, serialize });
  const output = new DOMParser().parseFromString(
    draw(
      previewGeometry(
        { width: 100, height: 80 },
        { x: 0, y: 0, width: 100, height: 80 },
        100,
        80,
        1,
      ),
      true,
    ),
    "image/svg+xml",
  );
  expect(parse).toHaveBeenCalledOnce();
  expect(output.querySelectorAll("path")).toHaveLength(1);
  expect(output.querySelector("path")?.getAttribute("d")).toBe("M0 0L10 10 M20 20L30 30");
});
function cadPreview(body: string, screen = true) {
  const bytes = new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">${body}</svg>`,
  );
  const draw = prepareSvgPreview(bytes, { width: 100, height: 80 });
  const geometry = previewGeometry(
    { width: 100, height: 80 },
    { x: 0, y: 0, width: 100, height: 80 },
    100,
    80,
    1,
  );
  return new DOMParser().parseFromString(draw(geometry, screen), "image/svg+xml");
}

test("editable CAD uses the same one-pixel stroke before and after checkpoint rendering", () => {
  const project = { width: 100, height: 80 };
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><polyline points="0,0 80,40" stroke="black" stroke-width="0.066" fill="none"/></svg>',
  );
  const draw = prepareSvgPreview(bytes, project);
  const geometry = previewGeometry(project, { x: 0, y: 0, ...project }, 100, 80, 1);
  const stroke = (xml: string) =>
    new DOMParser()
      .parseFromString(xml, "image/svg+xml")
      .querySelector("polyline")
      ?.getAttribute("stroke-width");
  expect(stroke(draw(geometry, true, 1, 1))).toBe("1");
  expect(stroke(draw(geometry, true, 1))).toBe("0.65");
  // Display-only overrides must never leak into the source/export rendering.
  expect(stroke(draw(geometry, false, 1, 1))).toBe(stroke(draw(geometry, false, 1)));
});

test("batches adjacent opaque CAD strokes only in the screen preview", () => {
  const body = `${cadStyle}<g stroke-linecap="round" stroke-linejoin="round">${cadPaths}</g>`;
  const screen = cadPreview(body);
  expect(screen.querySelectorAll("path")).toHaveLength(1);
  expect(screen.querySelector("path")!.getAttribute("d")).toBe("M0 0L10 10 M20 20L30 30");
  expect(screen.querySelector("path")!.getAttribute("vector-effect")).toBe("non-scaling-stroke");
  expect(cadPreview(body, false).querySelectorAll("path")).toHaveLength(2);
});

test.each([
  cadStyle.replace("fill: none", "fill: #000000") + cadPaths,
  cadStyle.replace("stroke-opacity: 1", "stroke-opacity: 0.5") + cadPaths,
  `${cadStyle}<g opacity="0.5">${cadPaths}</g>`,
  `${cadStyle}<g transform="scale(2)">${cadPaths}</g>`,
  `${cadStyle}<style>path:nth-child(2){stroke:red}</style>${cadPaths}`,
  cadStyle + cadPaths.replace('d="M20', 'd="m20'),
  cadStyle + cadPaths.replace('d="M20', 'id="referenced" d="M20'),
  cadStyle + cadPaths.replace("/><path", '/><rect width="10" height="10"/><path'),
])("preserves paths whose compositing, placement or styling cannot be batched: %s", (body) => {
  expect(cadPreview(body).querySelectorAll("path")).toHaveLength(2);
});

test("bounds CAD batches and retains every original subpath in drawing order", () => {
  const paths = Array.from({ length: 150 }, (_, i) => `M${i} 0L${i} 80`);
  const result = cadPreview(cadStyle + paths.map((d) => `<path class="C1" d="${d}"/>`).join(""));
  const batches = Array.from(result.querySelectorAll("path"), (p) => p.getAttribute("d")!);
  expect(batches).toHaveLength(3);
  expect(batches.every((d) => (d.match(/M/g) ?? []).length <= 64)).toBe(true);
  expect(batches.join(" ")).toBe(paths.join(" "));
});

test("reuses one parsed CAD source across the base and detail previews", () => {
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><path d="M0 0H100"/></svg>',
  );
  const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
  try {
    const base = sharedSvgPreview(bytes, { width: 100, height: 80 });
    const detail = sharedSvgPreview(bytes, { width: 100, height: 80 });
    const differentlyScaled = sharedSvgPreview(bytes, { width: 200, height: 160 });
    expect(detail).toBe(base);
    expect(differentlyScaled).not.toBe(base);
    expect(parser).toHaveBeenCalledTimes(2);
  } finally {
    parser.mockRestore();
  }
});

test("zooms vector geometry while retaining the original fitted screen stroke width", () => {
  const project = { width: 1000, height: 800 };
  const fit = previewGeometry(project, { x: -40, y: -32, width: 1080, height: 864 }, 900, 700, 1.5);
  const zoom = previewGeometry(project, { x: 300, y: 200, width: 270, height: 216 }, 900, 700, 1.5);
  expect(zoom.zoom).toBeCloseTo(4);
  expect(fixedStrokeWidth(6, zoom.zoom, zoom.scale)).toBeCloseTo(1.5);
  expect(fixedStrokeWidth(6, zoom.zoom, zoom.scale) * zoom.scale).toBeCloseTo(6 * fit.scale);
  expect(fixedStrokeWidth(0.01, 4, 2) * 2).toBeGreaterThanOrEqual(1);
});

test("changes only SVG viewport and numeric strokes, preserving fill geometry and source bytes", () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800"><style>.a{stroke-width:6;fill:none}</style><path class="a" d="M 0 400 L 1000 400"/><rect width="50" height="80" fill="black" stroke-width="8"/></svg>';
  const draw = prepareSvgPreview(new TextEncoder().encode(source), { width: 1000, height: 800 });
  const result = draw(
    previewGeometry(
      { width: 1000, height: 800 },
      { x: 0, y: 0, width: 270, height: 216 },
      900,
      700,
      1,
    ),
  );
  expect(result).toContain("stroke-width:1.5");
  expect(result).toContain('stroke-width="2"');
  expect(result).toContain('width="50" height="80" fill="black"');
  expect(source).toContain("stroke-width:6");
  expect(result).toContain('d="M 0 400 L 1000 400"');
});

test("CAD screen strokes use fitted CSS pixels and preserve a transformed-source fallback", () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 8000"><path stroke-width="20" d="M0 0H10000"/></svg>';
  const project = { width: 1000, height: 800 };
  const draw = prepareSvgPreview(new TextEncoder().encode(source), project);
  const geometry = previewGeometry(project, { x: 0, y: 0, width: 1080, height: 864 }, 1080, 864, 1);
  expect(draw.supportsScreenStrokes).toBe(true);
  const screen = draw(geometry, true);
  expect(screen).toContain('stroke-width="2"');
  expect(screen).toContain("vector-effect:non-scaling-stroke");
  expect(screen).toContain('vector-effect="non-scaling-stroke"');
  expect(draw(geometry)).toContain('stroke-width="20"');
  const transformed = source.replace("<path", '<path transform="scale(2)"');
  expect(
    prepareSvgPreview(new TextEncoder().encode(transformed), project).supportsScreenStrokes,
  ).toBe(false);
});

test("keeps tiny nonzero CAD screen strokes visible after returning from high zoom", () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 8000"><path stroke-width="0.01" d="M0 0H10000"/></svg>';
  const draw = prepareSvgPreview(new TextEncoder().encode(source), { width: 1000, height: 800 });
  const geometry = previewGeometry(
    { width: 1000, height: 800 },
    { x: 0, y: 0, width: 1080, height: 864 },
    1080,
    864,
    1,
  );
  expect(draw(geometry, true)).toContain('stroke-width="0.65"');
});

test("scales SVG strokes down before an enlarged detail is rasterized", () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><path stroke-width="6" d="M0 0H100"/><style>.a{stroke-width:4px}</style></svg>';
  const scaled = new TextDecoder().decode(
    scaleSvgStrokeWidths(new TextEncoder().encode(source), 6),
  );
  expect(scaled).toContain('stroke-width="1"');
  expect(scaled).toContain("stroke-width:0.6666666666666666px");
  expect(source).toContain('stroke-width="6"');
});

test("explicit CAD lineweights remain distinct and stable when zooming", () => {
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" data-cad-stroke-unit="0.2" viewBox="0 0 100 80"><path stroke-width="0.2" d="M0 0H100"/><path stroke-width="0.8" d="M0 10H100"/></svg>',
  );
  const project = { width: 100, height: 80 },
    draw = prepareSvgPreview(bytes, project);
  for (const width of [100, 20, 500]) {
    const g = previewGeometry(project, { x: 0, y: 0, width, height: width * 0.8 }, 1000, 800, 1);
    const svg = new DOMParser().parseFromString(draw(g, true, 1, 1), "image/svg+xml");
    expect([...svg.querySelectorAll("path")].map((p) => p.getAttribute("stroke-width"))).toEqual([
      "1",
      "4",
    ]);
  }
  const detail = prepareSvgPreview(scaleSvgStrokeWidths(bytes, 5), project);
  const detailSvg = new DOMParser().parseFromString(
    detail(
      previewGeometry(project, { x: 0, y: 0, width: 100, height: 80 }, 1000, 800, 1),
      true,
      1,
      1,
    ),
    "image/svg+xml",
  );
  expect(
    [...detailSvg.querySelectorAll("path")].map((p) => p.getAttribute("stroke-width")),
  ).toEqual(["1", "4"]);
});

test("screen stroke compensation includes the outer fragment transform", () => {
  const source = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 8000"><path stroke-width="20" d="M0 4000H10000"/></svg>',
  );
  const draw = prepareSvgPreview(source, { width: 1000, height: 800 });
  const geometry = previewGeometry(
    { width: 1000, height: 800 },
    { x: 0, y: 0, width: 1080, height: 864 },
    1080,
    864,
    1,
  );
  for (const outerScale of [1, 6, 30, 1000]) {
    const svg = new DOMParser().parseFromString(
      draw(geometry, true, 1 / outerScale),
      "image/svg+xml",
    );
    expect(
      Number(svg.querySelector("path")!.getAttribute("stroke-width")) * outerScale,
    ).toBeCloseTo(2);
  }
});
