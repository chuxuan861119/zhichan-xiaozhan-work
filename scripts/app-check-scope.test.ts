// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("desktop build checks all shipped code independently of website prototypes", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.scripts.check).toBe("biome check .");
  expect(pkg.scripts["check:app"]).toBe("biome check --config-path biome.app.json .");
  expect(pkg.scripts.build).toContain("npm run check:app &&");
  const config = JSON.parse(readFileSync("biome.app.json", "utf8"));
  expect(config.extends).toEqual(["./biome.json"]);
  expect(config.files.includes).toContain("**");
  // Retain the existing vendor-resource exceptions, without excluding app-owned resources.
  const excluded = config.files.includes.filter((pattern: string) => pattern.startsWith("!"));
  expect(excluded).toEqual([
    "!out-*",
    "!website/**",
    "!docs/**",
    "!build/icon.svg",
    "!resources/drawio/app",
    "!resources/ipc-data-center",
    "!tests/fixtures/vector-image/patent-black-output.svg",
    "!tests/fixtures/vector-image/render-reference.svg",
  ]);
  expect(config.files.includes).toContain("!website/**");
  expect(config.files.includes).toContain("!docs/**");
});
