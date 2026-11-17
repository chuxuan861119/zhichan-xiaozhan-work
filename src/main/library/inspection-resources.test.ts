import { createBlankPatent } from "../../shared/patent/defaults.js";
import { inspectResourceFiles } from "./inspection-resources.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
function fixture() {
  const patent = createBlankPatent({ patentType: "invention", name: "文件异常" });
  patent.figures = [1, 2, 3].map((n) => ({ figureId: id(n + 100), assetId: id(n), widthMm: 80 }));
  return patent;
}
test("distinguishes missing, corrupt and unreadable resources without exposing system paths", async () => {
  const result = await inspectResourceFiles(fixture(), async (id) => {
    throw Object.assign(new Error("/private/secret-path"), {
      code: id.endsWith("1") ? "NOT_FOUND" : id.endsWith("2") ? "CORRUPT_FILE" : "EACCES",
    });
  });
  expect(result.assets.map((a) => a.status)).toEqual(["missing", "damaged", "unreadable"]);
  expect(JSON.stringify(result)).not.toContain("secret-path");
});
test("stops queued reads when cancelled during an in-flight resource read", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const read = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new Error("failed");
  });
  const task = inspectResourceFiles(fixture(), read, controller.signal);
  const rejected = expect(task).rejects.toThrow();
  controller.abort();
  release();
  await rejected;
  expect(read).toHaveBeenCalledTimes(1);
});
