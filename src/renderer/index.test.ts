import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("allows Ketcher's local worker and required runtime evaluation only", () => {
  const html = readFileSync(resolve(process.cwd(), "src/renderer/index.html"), "utf8");

  expect(html).toContain("script-src 'self' 'unsafe-eval'");
  expect(html).toContain("worker-src 'self' blob:");
});
