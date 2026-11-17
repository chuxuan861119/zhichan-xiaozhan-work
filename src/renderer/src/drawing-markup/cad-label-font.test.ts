// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CAD_LABEL_CAP_HEIGHT, cadLabelCssFontSize } from "./cad-label-font";

test("CAD label fallback metrics match the actual bundled native font", () => {
  const font = readFileSync(new URL("../../../shared/document/fonts/SourceHanSerifCN-Regular.otf", import.meta.url));
  const tables = new Map<string, number>();
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    tables.set(font.toString("ascii", at, at + 4), font.readUInt32BE(at + 8));
  }
  const units = font.readUInt16BE(tables.get("head")! + 18);
  const cap = font.readInt16BE(tables.get("OS/2")! + 88);
  expect(CAD_LABEL_CAP_HEIGHT).toBe(cap / units);
  for (const height of [0.1, 1, 12, 20, 100])
    expect(cadLabelCssFontSize(height) * cap / units).toBeCloseTo(height);
});
