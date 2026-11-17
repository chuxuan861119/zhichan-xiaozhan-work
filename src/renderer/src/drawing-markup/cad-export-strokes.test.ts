import { expect, test } from "vitest";
import { prepareCadExportStrokes } from "./cad-export-strokes";

test("gives CAD hairlines a physical floor without flattening heavy lines or changing colors", () => {
  const bytes = new TextEncoder().encode(
    '<svg viewBox="0 0 10000 8000"><style>.a{stroke:#000;stroke-width:1}.b{stroke-width:40}</style><path stroke-width="0"/><path stroke-width="4"/></svg>',
  );
  const result = new TextDecoder().decode(prepareCadExportStrokes(bytes, 2, 2000, 2));
  expect(result).toContain("stroke-width:10");
  expect(result).toContain("stroke-width:20");
  expect(result).toContain('stroke-width="0"');
  expect(result).toContain('stroke-width="10"');
  expect(result).toContain("stroke:#000");
  expect(new TextDecoder().decode(bytes)).toContain("stroke-width:1");
});

test("preserves native CAD lineweight ratios at the chosen output density", () => {
  const bytes = new TextEncoder().encode(
    '<svg data-cad-stroke-unit="0.069333" viewBox="0 0 100 100">' +
      '<path stroke="#777777" stroke-width="0.069333"/>' +
      '<path stroke="#000000" stroke-width="0.138666"/></svg>',
  );
  const result = new TextDecoder().decode(prepareCadExportStrokes(bytes, 10, 1200, 1.2));
  expect(result).toContain('stroke="#777777" stroke-width="0.1"');
  expect(result).toContain('stroke="#000000" stroke-width="0.2"');
});
