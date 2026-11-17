import { createHash } from "node:crypto";

type Table = { record: number; offset: number; length: number };
function tables(bytes: Buffer): Map<string, Table> {
  const result = new Map<string, Table>();
  for (let i = 0; i < bytes.readUInt16BE(4); i++) {
    const record = 12 + i * 16;
    result.set(bytes.toString("ascii", record, record + 4), {
      record,
      offset: bytes.readUInt32BE(record + 8),
      length: bytes.readUInt32BE(record + 12),
    });
  }
  return result;
}

/** Bundled Source Han fonts have a Unicode format-12 cmap. Fail explicitly if
 * a future vendor font changes that contract; never silently corrupt a PDF. */
export function unicodeGlyphMap(bytes: Buffer): Map<number, number> {
  const cmap = tables(bytes).get("cmap");
  if (!cmap) throw new Error("打印字体缺少字符映射。");
  let offset = -1;
  for (let i = 0; i < bytes.readUInt16BE(cmap.offset + 2); i++) {
    const candidate = cmap.offset + bytes.readUInt32BE(cmap.offset + 4 + i * 8 + 4);
    if (bytes.readUInt16BE(candidate) === 12) offset = candidate;
  }
  if (offset < 0) throw new Error("打印字体缺少 Unicode 字符映射。");
  const result = new Map<number, number>();
  for (let i = 0; i < bytes.readUInt32BE(offset + 12); i++) {
    const record = offset + 16 + i * 12;
    const first = bytes.readUInt32BE(record),
      last = bytes.readUInt32BE(record + 4);
    const glyph = bytes.readUInt32BE(record + 8);
    for (let point = first; point <= last; point++) result.set(point, glyph + point - first);
  }
  return result;
}

function checksum(bytes: Buffer): number {
  let result = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) word = (word << 8) | (bytes[i + j] ?? 0);
    result = (result + (word >>> 0)) >>> 0;
  }
  return result;
}

function cmapTable(points: Map<number, number>, source: Buffer): Buffer {
  // Keep variation-selector mappings; only ambiguous base-character mappings change.
  const table = tables(source).get("cmap");
  let variations: Buffer | undefined;
  if (table) {
    for (let i = 0; i < source.readUInt16BE(table.offset + 2); i++) {
      const offset = table.offset + source.readUInt32BE(table.offset + 8 + i * 8);
      if (source.readUInt16BE(offset) === 14)
        variations = source.subarray(offset, offset + source.readUInt32BE(offset + 2));
    }
  }
  const entries = [...points].sort(([a], [b]) => a - b);
  const header = variations ? 28 : 20;
  const subtableLength = 16 + entries.length * 12;
  const result = Buffer.alloc(header + subtableLength + (variations?.length ?? 0));
  result.writeUInt16BE(variations ? 3 : 2, 2);
  // Unicode full repertoire and Windows UCS-4 both reference one format-12 table.
  result.writeUInt16BE(4, 6);
  result.writeUInt32BE(header, 8);
  result.writeUInt16BE(3, 12);
  result.writeUInt16BE(10, 14);
  result.writeUInt32BE(header, 16);
  if (variations) {
    result.writeUInt16BE(5, 22);
    result.writeUInt32BE(header + subtableLength, 24);
    variations.copy(result, header + subtableLength);
  }
  result.writeUInt16BE(12, header);
  result.writeUInt32BE(subtableLength, header + 4);
  result.writeUInt32BE(entries.length, header + 12);
  entries.forEach(([point, glyph], i) => {
    result.writeUInt32BE(point, header + 16 + i * 12);
    result.writeUInt32BE(point, header + 20 + i * 12);
    result.writeUInt32BE(glyph, header + 24 + i * 12);
  });
  return result;
}

function renamedCff(bytes: Buffer, table: Table, suffix: string): { bytes: Buffer; name: string } {
  const result = Buffer.from(bytes.subarray(table.offset, table.offset + table.length));
  const index = (offset: number) => {
    const count = result.readUInt16BE(offset);
    if (count === 0) return { end: offset + 2, entries: [] as { start: number; end: number }[] };
    const size = result[offset + 2];
    if (!size || size > 4) throw new Error("打印字体 CFF 索引无效。");
    const data = offset + 3 + (count + 1) * size;
    const at = (i: number) => result.readUIntBE(offset + 3 + i * size, size) + data - 1;
    return {
      end: at(count),
      entries: Array.from({ length: count }, (_, i) => ({ start: at(i), end: at(i + 1) })),
    };
  };
  const names = index(result[2] ?? 0);
  const first = names.entries[0];
  if (!first) throw new Error("打印字体 CFF 名称缺失。");
  const name = `ZXWPrintSerif-${suffix}`.slice(0, first.end - first.start);
  result.write(name.padEnd(first.end - first.start, "X"), first.start, "ascii");
  const strings = index(index(names.end).end);
  for (const entry of strings.entries) {
    if (result.toString("ascii", entry.start, entry.end) === "Source Han Serif CN") {
      result.write("ZXW Print Serif".padEnd(entry.end - entry.start, " "), entry.start, "ascii");
    } else if (result.toString("ascii", entry.start, entry.end).startsWith("SourceHanSerifCN")) {
      result.write("ZXWPrintSerifXXX", entry.start, "ascii");
    }
  }
  return { bytes: result, name };
}

function renamedNameTable(bytes: Buffer, name: Table, suffix: string): Buffer {
  const records: { record: Buffer; text: Buffer }[] = [];
  for (let i = 0; i < bytes.readUInt16BE(name.offset + 2); i++) {
    const offset = name.offset + 6 + i * 12;
    const record = Buffer.from(bytes.subarray(offset, offset + 12));
    const id = record.readUInt16BE(6),
      platform = record.readUInt16BE(0);
    const sourceOffset =
      name.offset + bytes.readUInt16BE(name.offset + 4) + record.readUInt16BE(10);
    let text = bytes.subarray(sourceOffset, sourceOffset + record.readUInt16BE(8));
    if ([1, 3, 4, 6, 16].includes(id)) {
      const value = suffix;
      text =
        platform === 0 || platform === 3
          ? Buffer.from(value, "utf16le").swap16()
          : Buffer.from(value, "ascii");
    }
    records.push({ record, text });
  }
  const headerSize = 6 + records.length * 12;
  const result = Buffer.alloc(
    headerSize + records.reduce((total, entry) => total + entry.text.length, 0),
  );
  result.writeUInt16BE(records.length, 2);
  result.writeUInt16BE(headerSize, 4);
  let cursor = headerSize;
  records.forEach(({ record, text }, i) => {
    record.writeUInt16BE(text.length, 8);
    record.writeUInt16BE(cursor - headerSize, 10);
    record.copy(result, 6 + i * 12);
    text.copy(result, cursor);
    cursor += text.length;
  });
  return result;
}

function replaceTables(bytes: Buffer, replacements: Map<string, Buffer>): Buffer {
  const records = tables(bytes);
  const headerSize = 12 + records.size * 16;
  let cursor = headerSize;
  const header = Buffer.from(bytes.subarray(0, headerSize));
  const parts: Buffer[] = [header];
  for (const [tag, table] of records) {
    const data = Buffer.from(
      replacements.get(tag) ?? bytes.subarray(table.offset, table.offset + table.length),
    );
    if (tag === "head") data.writeUInt32BE(0, 8);
    const padded = Buffer.alloc((data.length + 3) & ~3);
    data.copy(padded);
    header.writeUInt32BE(checksum(padded), table.record + 4);
    header.writeUInt32BE(cursor, table.record + 8);
    header.writeUInt32BE(data.length, table.record + 12);
    parts.push(padded);
    cursor += padded.length;
  }
  const result = Buffer.concat(parts);
  const head = tables(result).get("head");
  if (!head) throw new Error("打印字体缺少 head 表。");
  result.writeUInt32BE((0xb1b0afba - checksum(result)) >>> 0, head.offset + 8);
  return result;
}

/** CoreText/Skia may reverse shared glyphs to radicals instead of the supplied
 * Han characters. Give each print-only face an unambiguous cmap. When the text
 * actually contains both aliases, separate faces preserve both code points.
 * Outlines, metrics and licensing metadata stay intact; reserved font names are
 * replaced. Editor fonts and distributed original fonts are never modified. */
export function pdfFontVariants(
  bytes: Buffer,
  usedPoints: ReadonlySet<number>,
  original: ReadonlyMap<number, number> = unicodeGlyphMap(bytes),
): { bytes: Buffer; points: number[] }[] {
  const layers: Map<number, number>[] = [];
  const glyphs: Set<number>[] = [];
  const radical = (point: number) => Number(point >= 0x2e80 && point <= 0x2fff);
  for (const point of [...usedPoints].sort((a, b) => radical(a) - radical(b) || a - b)) {
    const glyph = original.get(point);
    if (!glyph) continue;
    let layer = glyphs.findIndex((used) => !used.has(glyph));
    if (layer < 0) {
      layer = layers.length;
      layers.push(new Map());
      glyphs.push(new Set());
    }
    const pointLayer = layers[layer];
    const glyphLayer = glyphs[layer];
    if (!pointLayer || !glyphLayer) throw new Error("打印字体映射分组失败。");
    pointLayer.set(point, glyph);
    glyphLayer.add(glyph);
  }
  const name = tables(bytes).get("name");
  if (!name) throw new Error("打印字体缺少名称表。");
  return layers.map((points) => {
    const cmap = cmapTable(points, bytes);
    const suffix = createHash("sha256").update(bytes).update(cmap).digest("hex").slice(0, 16);
    const cffTable = tables(bytes).get("CFF ");
    if (!cffTable) throw new Error("打印字体缺少 CFF 字形表。");
    const cff = renamedCff(bytes, cffTable, suffix);
    return {
      points: [...points.keys()],
      bytes: replaceTables(
        bytes,
        new Map([
          ["cmap", cmap],
          ["name", renamedNameTable(bytes, name, cff.name)],
          ["CFF ", cff.bytes],
        ]),
      ),
    };
  });
}
