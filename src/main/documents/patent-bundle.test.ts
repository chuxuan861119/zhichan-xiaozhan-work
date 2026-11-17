import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import yazl from "yazl";
import { readPatentBundle, writePatentBundle } from "./patent-bundle.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
test("round trips own document bundle and rejects unsupported PDF import", async () => {
  root = await mkdtemp(join(tmpdir(), "bundle-test-"));
  const file = join(root, "one.patdoc");
  await writeFile(file, "native");
  const path = join(root, "bundle.zip");
  await writePatentBundle(path, "patdoc", [
    { name: "同名", file, native: file },
    { name: "同名", file, native: file },
  ]);
  const result = await readPatentBundle(path);
  expect(result.items).toHaveLength(2);
  expect(result.items[0]!.native.toString()).toBe("native");
  expect(result.items[0]!.name).toBe("同名");
  await writePatentBundle(path, "pdf", [{ name: "专利", file, native: file }]);
  await expect(readPatentBundle(path)).rejects.toThrow(/PDF/);
});
test("rejects truncated bundles", async () => {
  root = await mkdtemp(join(tmpdir(), "bundle-test-"));
  const file = join(root, "one.docx");
  await writeFile(file, "word");
  const path = join(root, "bundle.zip");
  await writePatentBundle(path, "docx", [{ name: "专利", file, native: file }]);
  const bytes = await readFile(path);
  await writeFile(path, bytes.subarray(0, bytes.length - 30));
  await expect(readPatentBundle(path)).rejects.toThrow();
});

async function archive(path: string, entries: Record<string, Buffer>) {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of Object.entries(entries)) zip.addBuffer(bytes, name);
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  await writeFile(path, await result);
}

test("rejects ordinary ZIP, modified DOCX, unlisted files and missing native restore data", async () => {
  root = await mkdtemp(join(tmpdir(), "bundle-test-"));
  const path = join(root, "input.zip");
  const word = Buffer.from("word");
  const native = Buffer.from("native");
  const reference = (path: string, bytes: Buffer) => ({
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const manifest = {
    kind: "patent-workbench-five-books",
    version: 1,
    bundleId: randomUUID(),
    format: "docx",
    items: [
      {
        name: "测试",
        file: reference("one.docx", word),
        native: reference("restore/one.patdoc", native),
      },
    ],
  };
  await archive(path, { "one.docx": word });
  await expect(readPatentBundle(path)).rejects.toThrow(/本软件/);
  const entries = {
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "one.docx": word,
    "restore/one.patdoc": native,
  };
  await archive(path, { ...entries, "one.docx": Buffer.from("edit") });
  await expect(readPatentBundle(path)).rejects.toThrow(/已修改或损坏/);
  await archive(path, { ...entries, "extra.txt": word });
  await expect(readPatentBundle(path)).rejects.toThrow(/清单之外/);
  await archive(path, { "manifest.json": entries["manifest.json"], "one.docx": word });
  await expect(readPatentBundle(path)).rejects.toThrow(/已修改或损坏/);
});
