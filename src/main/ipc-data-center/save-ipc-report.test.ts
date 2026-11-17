import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { saveIpcReport } from "./save-ipc-report.js";

test("saves a valid PNG exactly and treats cancellation as no output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ipc-report-test-"));
  try {
    const bytes = await sharp({
      create: { width: 12, height: 12, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const request = {
      png: `data:image/png;base64,${bytes.toString("base64")}`,
      filename: "预审报告.png",
    };
    expect(await saveIpcReport(request, async () => null)).toBeNull();
    const path = join(root, request.filename);
    expect(await saveIpcReport(request, async () => path)).toBe(path);
    expect(await readFile(path)).toEqual(bytes);
    const choose = vi.fn(async () => path);
    await expect(saveIpcReport({ ...request, filename: "../other.png" }, choose)).rejects.toThrow();
    await expect(
      saveIpcReport({ ...request, png: "data:image/png;base64,YmFk" }, choose),
    ).rejects.toThrow();
    expect(choose).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
