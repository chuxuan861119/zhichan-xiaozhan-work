import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("renderer source does not invoke native alert, confirm or prompt", () => {
  const root = join(process.cwd(), "src/renderer/src");
  const offenders = readdirSync(root, { recursive: true })
    .filter(
      (file): file is string =>
        typeof file === "string" && /\.tsx?$/.test(file) && !file.includes(".test."),
    )
    .filter((file) =>
      /\b(?:window|globalThis)\.(?:alert|confirm|prompt)\s*\(/.test(
        readFileSync(join(root, file), "utf8"),
      ),
    );
  expect(offenders).toEqual([]);
});
