import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import yauzl, { type Entry } from "yauzl";
import yazl from "yazl";
import { z } from "zod";
import { writeExportFile } from "../platform/atomic-export-write.js";

const LIMIT = 256 * 1024 * 1024;
const ref = z
  .object({
    path: z.string().max(240),
    size: z.number().int().nonnegative().max(LIMIT),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const manifestSchema = z
  .object({
    kind: z.literal("patent-workbench-five-books"),
    version: z.literal(1),
    bundleId: z.string().uuid(),
    format: z.enum(["patdoc", "docx", "pdf"]),
    items: z
      .array(z.object({ name: z.string().max(500), file: ref, native: ref.optional() }).strict())
      .min(1)
      .max(100),
  })
  .strict();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function bundleFileName(name: string) {
  return (
    [...name.replace(/[<>:"/\\|?*]/g, "_")]
      .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
      .join("")
      .slice(0, 80)
      .replace(/[. ]+$/g, "") || "未命名专利"
  );
}

export async function writePatentBundle(
  path: string,
  format: "patdoc" | "docx" | "pdf",
  items: { name: string; file: string; native: string }[],
) {
  const zip = new yazl.ZipFile();
  let total = 0;
  const add = async (name: string, file: string) => {
    const size = (await stat(file)).size;
    total += size;
    if (total > LIMIT) throw new Error("压缩包超过 256 MiB，请减少选择的专利数量。");
    const bytes = await readFile(file);
    zip.addBuffer(bytes, name);
    return { path: name, size: bytes.length, sha256: hash(bytes) };
  };
  const records = [];
  for (const [index, item] of items.entries()) {
    const prefix = String(index + 1).padStart(3, "0");
    const name = bundleFileName(item.name);
    const file = await add(`${prefix}-${name}.${format}`, item.file);
    records.push({
      name: item.name,
      file,
      ...(format === "docx" ? { native: await add(`restore/${prefix}.patdoc`, item.native) } : {}),
    });
  }
  const manifest = manifestSchema.parse({
    kind: "patent-workbench-five-books",
    version: 1,
    bundleId: randomUUID(),
    format,
    items: records,
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (total + manifestBytes.length > LIMIT)
    throw new Error("压缩包超过 256 MiB，请减少选择的专利数量。");
  zip.addBuffer(manifestBytes, "manifest.json");
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  const bytes = await result;
  if (bytes.length > LIMIT) throw new Error("压缩包超过 256 MiB，请减少选择的专利数量。");
  await writeExportFile(path, bytes);
}

export async function readPatentBundle(path: string) {
  if ((await stat(path)).size > LIMIT) throw new Error("压缩包超过 256 MiB。");
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, value) =>
        error || !value ? reject(error ?? new Error("压缩包无法打开")) : resolve(value),
    );
  });
  const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    const values = new Map<string, Buffer>();
    let total = 0;
    const fail = (error: unknown) => {
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      const name = entry.fileName;
      total += entry.uncompressedSize;
      if (
        values.size >= 201 ||
        total > LIMIT ||
        entry.generalPurposeBitFlag & 1 ||
        name.includes("\\") ||
        name.includes(":") ||
        name.startsWith("/") ||
        name.split("/").some((part) => !part || part === "." || part === "..") ||
        values.has(name) ||
        ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
        (name === "manifest.json" && entry.uncompressedSize > 1024 * 1024)
      ) {
        fail(new Error("压缩包条目或大小无效。"));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error("条目无法读取"));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        stream.on("error", fail);
        stream.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > entry.uncompressedSize) stream.destroy(new Error("条目大小无效"));
          else chunks.push(chunk);
        });
        stream.on("end", () => {
          values.set(name, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.on("end", () => resolve(values));
    zip.readEntry();
  });
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error("请选择本软件导出的 PATDOC 或 DOCX 专利压缩包。");
  const parsed = manifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8")));
  if (!parsed.success)
    throw new Error("压缩包清单无效或版本不受支持，请使用本软件导出的专利压缩包。");
  const manifest = parsed.data;
  if (manifest.format === "pdf") throw new Error("PDF 压缩包仅供查看，不能导入为可编辑专利。");
  const used = new Set(["manifest.json"]);
  const get = (record: z.infer<typeof ref>) => {
    const bytes = entries.get(record.path);
    if (
      !bytes ||
      used.has(record.path) ||
      bytes.length !== record.size ||
      hash(bytes) !== record.sha256
    )
      throw new Error("压缩包文件已修改或损坏，请使用原始导出包；修改后的 DOCX 请单独导入。");
    used.add(record.path);
    return bytes;
  };
  const items = manifest.items.map((item) => {
    if (!item.file.path.endsWith(`.${manifest.format}`)) throw new Error("压缩包格式不一致。");
    const bytes = get(item.file);
    if (manifest.format === "patdoc" && item.native)
      throw new Error("PATDOC 包不应包含额外还原数据。");
    if (manifest.format === "docx" && (!item.native || !item.native.path.endsWith(".patdoc")))
      throw new Error("DOCX 包缺少还原数据。");
    return { name: item.name, native: item.native ? get(item.native) : bytes };
  });
  if (used.size !== entries.size) throw new Error("压缩包含有清单之外的文件。");
  return { bundleId: manifest.bundleId, items };
}
