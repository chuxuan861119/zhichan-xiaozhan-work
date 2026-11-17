import { DOMParser as XmlDomParser, XMLSerializer as XmlSerializer } from "@xmldom/xmldom";
import { expect, test } from "vitest";
import { rebaseCadPath, rebaseCadScreenRoot } from "./cad-svg-origin";
import { prepareSvgPreview, previewGeometry } from "./fixed-line-preview";

test("absolute endpoints and controls move, arc radii and relative commands do not", () => {
  expect(
    rebaseCadPath(
      "M100 200 120 220H130V240C140 250 160 260 170 280S180 290 190 300Q200 310 210 320T220 330A10 20 45 0 1 230 340z",
      100,
      200,
    ),
  ).toBe(
    "M0 0 20 20 H30 V40 C40 50 60 60 70 80 S80 90 90 100 Q100 110 110 120 T120 130 A10 20 45 0 1 130 140 z",
  );
  expect(rebaseCadPath("m100 200 10 20 l4-5 m6 7h8v9a1 2 0 0 1 3 4Z", 100, 200)).toBe(
    "m0 0 10 20 l4 -5 m6 7 h8 v9 a1 2 0 0 1 3 4 Z",
  );
  expect(rebaseCadPath("M1e3,2e3L1001 2001", 1000, 2000)).toBe("M0 0 L1 1");
  expect(rebaseCadPath("M1 2 A1 2 3", 0, 0)).toBeNull();
});

test("shape origins and point lists rebase without changing sizes or the source", () => {
  const root = new DOMParser().parseFromString(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="30" height="40"/><circle cx="100" cy="200" r="10"/><line x1="100" y1="200" x2="120" y2="230"/><polyline points="100,200 110,220"/></svg>',
    "image/svg+xml",
  ).documentElement;
  const local = rebaseCadScreenRoot(root, 100, 200)!;
  expect(local.querySelector("rect")?.getAttribute("x")).toBe("-100");
  expect(local.querySelector("rect")?.getAttribute("height")).toBe("40");
  expect(local.querySelector("circle")?.getAttribute("r")).toBe("10");
  expect(local.querySelector("circle")?.getAttribute("cy")).toBe("0");
  expect(local.querySelector("line")?.getAttribute("x2")).toBe("20");
  expect(local.querySelector("polyline")?.getAttribute("points")).toBe("0 0 10 20");
  expect(root.querySelector("circle")?.getAttribute("cx")).toBe("100");
});

test.each([
  '<g transform="rotate(90)"><path d="M0 0L1 1"/></g>',
  "<defs/>",
  '<text x="1">a</text>',
  '<circle cx="50%"/>',
])("preserves unsupported SVG coordinate semantics: %s", (body) => {
  const root = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
    "image/svg+xml",
  ).documentElement;
  expect(rebaseCadScreenRoot(root, 100, 200)).toBeNull();
});

test("high zoom screen rebasing never changes ordinary preview or export coordinates", () => {
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000000 800000"><path d="M100000 400000H900000" stroke="black" stroke-width="1000"/></svg>',
  );
  const draw = prepareSvgPreview(bytes, { width: 2000, height: 1600 });
  const geometry = previewGeometry(
    { width: 2000, height: 1600 },
    { x: 999.99, y: 799.99, width: 0.1, height: 0.1 },
    1000,
    800,
    1,
  );
  const parse = (s: string) => new DOMParser().parseFromString(s, "image/svg+xml");
  const screen = parse(draw(geometry, true));
  expect(screen.documentElement.getAttribute("viewBox")?.startsWith("0 0 ")).toBe(true);
  expect(screen.querySelector("path")?.getAttribute("d")).not.toBe("M100000 400000H900000");
  const output = parse(draw(geometry, false));
  expect(output.querySelector("path")?.getAttribute("d")).toBe("M100000 400000H900000");
  expect(output.documentElement.getAttribute("viewBox")?.startsWith("0 0 ")).toBe(false);
});

test("root transforms keep their original coordinate system", () => {
  const root = new DOMParser().parseFromString(
    '<svg xmlns="http://www.w3.org/2000/svg" transform="translate(30 40)"><path d="M0 0L10 10"/></svg>',
    "image/svg+xml",
  ).documentElement;
  expect(rebaseCadScreenRoot(root, 100, 200)).toBeNull();
});

test("the background XML adapter rebases identically to the browser", () => {
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000000 800000"><path d="M100000 400000H900000" stroke="black" stroke-width="1000"/><circle r="10"/></svg>',
  );
  const geometry = previewGeometry(
    { width: 2000, height: 1600 },
    { x: 999.99, y: 799.99, width: 0.1, height: 0.1 },
    1000,
    800,
    1,
  );
  const expected = prepareSvgPreview(bytes, { width: 2000, height: 1600 })(geometry, true);
  const actual = prepareSvgPreview(
    bytes,
    { width: 2000, height: 1600 },
    {
      parse: (xml) =>
        new XmlDomParser().parseFromString(xml, "image/svg+xml") as unknown as Document,
      serialize: (node) => new XmlSerializer().serializeToString(node as never),
    },
  )(geometry, true);
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "image/svg+xml");
  for (const selector of ["svg", "path", "circle"]) {
    const attrs = (xml: string) =>
      Object.fromEntries(
        Array.from(parse(xml).querySelector(selector)!.attributes).map((attr) => [
          attr.name,
          attr.value,
        ]),
      );
    expect(attrs(actual)).toEqual(attrs(expected));
  }
});
