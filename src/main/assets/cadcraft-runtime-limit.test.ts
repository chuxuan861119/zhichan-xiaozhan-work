import { execFile } from "node:child_process";
import { vi } from "vitest";
import { runCadCodec } from "./cadcraft-runtime.js";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});

test.each([
  [
    "DWG: converting this 10MB file produced more than 100MB of drawing data (the limit); file probably damaged",
    "EXIT",
    "CAD_OUTPUT_TOO_LARGE",
  ],
  ["Output exceeds 100 MiB", "EXIT", "CAD_OUTPUT_TOO_LARGE"],
  ["", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "CAD_OUTPUT_TOO_LARGE"],
  ["private drawing text", "EXIT", "CAD_CONVERSION_FAILED"],
  ["", "ENOENT", "CAD_RUNTIME_UNAVAILABLE"],
  ["", "EACCES", "CAD_RUNTIME_UNAVAILABLE"],
])(
  "reports capacity errors without leaking parser text: %s",
  async (stderr, code, expectedCode) => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: Buffer, stderr: Buffer) => void;
      queueMicrotask(() =>
        callback(
          Object.assign(new Error("native error"), { code }),
          Buffer.alloc(0),
          Buffer.from(stderr),
        ),
      );
      return { stdin: { on() {}, end() {} } } as unknown as ReturnType<typeof execFile>;
    });
    const error = await runCadCodec("runtime", "dwg-to-dxf", new Uint8Array([1])).catch(
      (error: Error & { code?: string }) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: string }).code).toBe(expectedCode);
    expect((error as Error).message).not.toMatch(/private drawing|damaged/);
  },
);

test("distinguishes a killed timeout from conversion failure and cancellation", async () => {
  const controller = new AbortController();
  for (const cancelled of [false, true]) {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: Buffer, stderr: Buffer) => void;
      queueMicrotask(() => {
        if (cancelled) controller.abort();
        callback(
          Object.assign(new Error("private native text"), { killed: true }),
          Buffer.alloc(0),
          Buffer.alloc(0),
        );
      });
      return { stdin: { on() {}, end() {} } } as unknown as ReturnType<typeof execFile>;
    });
    await expect(
      runCadCodec("runtime", "dxf-to-svg", new Uint8Array([1]), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: cancelled ? "CANCELLED" : "CAD_CONVERSION_TIMEOUT" });
  }
});
