import yazl from "yazl";
import {
  type FolderFormat,
  folderExportItems,
  type PatentFolderEntry,
  patentFolderEntries,
} from "../../shared/patent/folder.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";

const LIMIT = 256 * 1024 * 1024;
export function folderFileNames(items: { name: string; format: string }[]): string[] {
  const used = new Set<string>();
  return items.map((item) => {
    let name =
      [...item.name]
        .map((c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? "_" : c))
        .join("")
        .slice(0, 100)
        .replace(/[. ]+$/gu, "") || "未命名文件";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
    let candidate = `${name}.${item.format}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n++)
      candidate = `${name} (${n}).${item.format}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** Build fully before touching the destination: one failed entry never leaves a partial archive. */
export async function createFolderExport(
  patent: CanonicalPatent,
  items: { key: string; format: FolderFormat }[],
  render: (entry: PatentFolderEntry, format: FolderFormat) => Promise<Uint8Array>,
): Promise<{ bytes: Uint8Array; extension: string; name: string }> {
  const entries = patentFolderEntries(patent);
  const expected = folderExportItems(
    entries,
    items.map((i) => i.key),
    items.length === 1 ? items[0]!.format : undefined,
  );
  if (expected.some((item, i) => item.format !== items[i]!.format))
    throw new Error("批量导出须使用各文件的默认格式。");
  const selected = items.map((i) => entries.find((e) => e.key === i.key)!);
  const names = folderFileNames(
    selected.map((entry, i) => ({ name: entry.name, format: items[i]!.format })),
  );
  if (items.length === 1)
    return {
      bytes: await render(selected[0]!, items[0]!.format),
      extension: items[0]!.format,
      name: names[0]!,
    };
  const zip = new yazl.ZipFile();
  let size = 0;
  // Collect bounded file bodies before creating a stream, so render failures do not leak a stream.
  const files: Uint8Array[] = [];
  for (let i = 0; i < items.length; i++) {
    const bytes = await render(selected[i]!, items[i]!.format);
    size += bytes.byteLength;
    if (size > LIMIT) throw new Error("文件总量超过 256 MiB，请分批导出。");
    files.push(bytes);
  }
  const completed = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  files.forEach((bytes, i) => {
    zip.addBuffer(Buffer.from(bytes), names[i]!);
  });
  zip.end();
  const bytes = await completed;
  if (bytes.byteLength > LIMIT) throw new Error("压缩包超过 256 MiB，请分批导出。");
  return {
    bytes,
    extension: "zip",
    name: `${folderFileNames([{ name: patent.name ?? "未命名专利", format: "zip" }])[0]}`,
  };
}
