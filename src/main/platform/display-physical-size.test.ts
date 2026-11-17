import { execFile } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { readPhysicalDisplayWidthMm, validDisplayWidthMm } from "./display-physical-size.js";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});
afterEach(() => vi.resetAllMocks());
test.each([0, -1, NaN, Infinity, 99, 3001, "500"])(
  "rejects unavailable or implausible physical size %s",
  (value) => {
    expect(validDisplayWidthMm(value)).toBeNull();
  },
);
test("retains measured millimeters without resolution conversion", () => {
  expect(validDisplayWidthMm(326.571)).toBe(326.571);
  expect(validDisplayWidthMm(500)).toBe(500);
});
test("invalid display identifiers never run a helper", async () => {
  expect(await readPhysicalDisplayWidthMm(-1)).toBeNull();
  expect(execFile).not.toHaveBeenCalled();
});
test.skipIf(process.platform !== "darwin")(
  "macOS uses a bounded metadata helper and falls back on failure",
  async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
      callback(null, "326.571\n");
      return {} as never;
    });
    expect(await readPhysicalDisplayWidthMm(1)).toBe(326.571);
    expect(execFile).toHaveBeenCalledWith(
      expect.stringContaining("display-width-mm"),
      ["1"],
      expect.objectContaining({ timeout: 1500, maxBuffer: 128 }),
      expect.any(Function),
    );
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error, stdout: string) => void)(
        new Error("metadata unavailable"),
        "",
      );
      return {} as never;
    });
    expect(await readPhysicalDisplayWidthMm(1)).toBeNull();
  },
);
