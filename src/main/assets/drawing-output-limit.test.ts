// @vitest-environment node
import { randomUUID } from "node:crypto";

const converter = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: converter.run };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: string, ...args: unknown[]) =>
      path.replaceAll("\\", "/").endsWith("render/drawing.svg")
        ? Buffer.alloc(50 * 1024 * 1024 + 1)
        : Reflect.apply(actual.readFile, actual, [path, ...args]),
  };
});
vi.mock("./drawing-runtime.js", () => ({
  drawingRuntimeCommands: async () => ({
    reader: "synthetic-reader",
    renderer: "synthetic-renderer",
    rendererArguments: [],
  }),
  drawingRuntimeCacheIdentity: async () => "synthetic-runtime",
}));

import { importDrawing } from "./drawing-importer.js";

test("oversized converted geometry reports an actionable capacity error instead of generic failure", async () => {
  converter.run.mockImplementation((_file, _args, _options, callback) => callback(null, "", ""));
  await expect(
    importDrawing(
      {
        sessionId: randomUUID(),
        operationId: randomUUID(),
        originalName: "synthetic.dwg",
        declaredMediaType: null,
        bytes: Buffer.from("AC1032 fixture"),
      },
      "synthetic-runtime",
    ),
  ).rejects.toMatchObject({ code: "CAD_OUTPUT_TOO_LARGE" });
});
