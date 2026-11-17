import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("the main process lets the application setting own motion media queries", () => {
  const source = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
  expect(source).toContain('app.commandLine.appendSwitch("force-prefers-no-reduced-motion")');
});
