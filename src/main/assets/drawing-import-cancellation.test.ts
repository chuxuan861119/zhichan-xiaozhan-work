import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname } from "node:path";

const converter = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, default: { ...actual, execFile: converter.run }, execFile: converter.run };
});

vi.mock("./drawing-runtime.js", () => ({
  drawingRuntimeCacheIdentity: async () => "cancel-runtime",
  drawingRuntimeCommands: async () => ({
    reader: "reader",
    renderer: "renderer",
    rendererArguments: [],
  }),
}));

import { importDrawing } from "./drawing-importer.js";

test("aborting a running reader stops conversion and removes its own temporary directory", async () => {
  const controller = new AbortController();
  let directory = "";
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  converter.run.mockImplementation(
    (
      _file: string,
      args: string[],
      options: { signal: AbortSignal },
      callback: (error: Error) => void,
    ) => {
      directory = dirname(args[0]!);
      options.signal.addEventListener(
        "abort",
        () => callback(new DOMException("Cancelled", "AbortError")),
        { once: true },
      );
      started();
    },
  );
  const importing = importDrawing(
    {
      sessionId: randomUUID(),
      operationId: randomUUID(),
      originalName: "cancel.dwg",
      declaredMediaType: null,
      bytes: Buffer.from("AC1032  "),
    },
    "test-runtime",
    controller.signal,
  );
  const result = importing.then(
    (value) => value,
    (error) => error,
  );
  await ready;
  controller.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  expect(converter.run).toHaveBeenCalledTimes(1);
  await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
});
