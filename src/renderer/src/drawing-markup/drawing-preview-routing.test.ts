import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("plain DWG keeps the direct vector preview path during viewport zoom", () => {
  const source = readFileSync(
    join(process.cwd(), "src/renderer/src/drawing-markup/drawing-workspace.tsx"),
    "utf8",
  );
  expect(source).toMatch(
    /!current\.baseFragments[\s\S]{0,100}current\.sourceKind === "dwg"[\s\S]{0,100}current\.sourceKind === "pdf"/u,
  );
  expect(source).not.toMatch(
    /\(current\.sourceKind === "dwg"\s*\|\|[\s\S]{0,100}current\.baseFragments/u,
  );
});
