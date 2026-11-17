import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNewFileWithoutClobber } from "../documents/file-service.js";
import { createAtomicExportWriter } from "./atomic-export-write.js";

test.each(["openharmony", "ohos"])(
  "%s public export creates a verified new file without requiring rename or hard links",
  async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "public-export-"));
    const target = join(root, "new.pdf");
    const bytes = Buffer.from("%PDF-synthetic-file");
    const nativeWriter = vi.fn(async () => {
      throw new Error("public rename must not be used");
    });
    const writer = createAtomicExportWriter({
      platform,
      isPublicPath: () => true,
      temporaryRoot: root,
      writeAtomic: nativeWriter,
      installNewFile: (source, destination) =>
        installNewFileWithoutClobber(source, destination, async () => {
          throw Object.assign(new Error("hard links unsupported"), { code: "EPERM" });
        }),
    });
    try {
      await writer(target, bytes);
      expect(await readFile(target)).toEqual(bytes);
      expect(nativeWriter).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual(["new.pdf"]);
      await expect(writer(target, Buffer.from("replacement"))).rejects.toMatchObject({
        code: "UNSAFE_OVERWRITE",
      });
      expect(await readFile(target)).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a file created by another writer during export is never replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-export-race-"));
  const target = join(root, "new.docx");
  const writer = createAtomicExportWriter({
    platform: "openharmony",
    isPublicPath: () => true,
    temporaryRoot: root,
    installNewFile: async (source, destination) => {
      await writeFile(destination, "other writer", { flag: "wx" });
      await installNewFileWithoutClobber(source, destination);
    },
  });
  try {
    await expect(writer(target, Buffer.from("our export"))).rejects.toMatchObject({
      code: "UNSAFE_OVERWRITE",
    });
    expect(await readFile(target, "utf8")).toBe("other writer");
    expect(await readdir(root)).toEqual(["new.docx"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["darwin", "win32"])("%s retains the existing atomic writer", async (platform) => {
  const nativeWriter = vi.fn(async () => {});
  const installer = vi.fn(async () => {});
  await createAtomicExportWriter({
    platform,
    isPublicPath: () => true,
    writeAtomic: nativeWriter,
    installNewFile: installer,
  })("target.pdf", Buffer.from("data"));
  expect(nativeWriter).toHaveBeenCalledOnce();
  expect(installer).not.toHaveBeenCalled();
});
