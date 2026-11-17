// @vitest-environment node
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { createFolderExport, folderFileNames } from "./patent-folder-export.js";

test("allocates safe unique filenames including Windows reserved names", () => {
  const names = folderFileNames([
    { name: "a/b", format: "docx" },
    { name: "a\\b", format: "docx" },
    { name: "CON", format: "pdf" },
    { name: "A_b", format: "docx" },
  ]);
  expect(names).toEqual(["a_b.docx", "a_b (2).docx", "_CON.pdf", "A_b (3).docx"]);
});

test("single item is not zipped; a batch uses defaults and contains each file", async () => {
  const patent = createBlankPatent({ patentType: "invention", name: "测试" });
  const render = vi.fn(async (_entry, format) => Buffer.from(format));
  const single = await createFolderExport(patent, [{ key: "book:claims", format: "pdf" }], render);
  expect(single.extension).toBe("pdf");
  expect(Buffer.from(single.bytes).toString()).toBe("pdf");
  const batch = await createFolderExport(
    patent,
    [
      { key: "book:claims", format: "docx" },
      { key: "book:description", format: "docx" },
    ],
    render,
  );
  expect(batch.extension).toBe("zip");
  expect(Buffer.from(batch.bytes).subarray(0, 2).toString()).toBe("PK");
  expect(Buffer.from(batch.bytes).includes(Buffer.from("权利要求书.docx"))).toBe(true);
  expect(Buffer.from(batch.bytes).includes(Buffer.from("说明书.docx"))).toBe(true);
  await expect(
    createFolderExport(
      patent,
      [
        { key: "book:claims", format: "pdf" },
        { key: "book:description", format: "docx" },
      ],
      render,
    ),
  ).rejects.toThrow();
});

test("one failed file rejects whole batch and missing/duplicate targets never render", async () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const render = vi.fn(async () => {
    throw new Error("failed");
  });
  await expect(
    createFolderExport(
      patent,
      [
        { key: "book:claims", format: "docx" },
        { key: "book:description", format: "docx" },
      ],
      render,
    ),
  ).rejects.toThrow("failed");
  render.mockClear();
  await expect(
    createFolderExport(patent, [{ key: "book:missing", format: "docx" }], render),
  ).rejects.toThrow();
  expect(render).not.toHaveBeenCalled();
});
