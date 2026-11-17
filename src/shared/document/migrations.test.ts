import { createBlankDocument } from "./defaults.js";
import { migrateCanonicalDocument } from "./migrations.js";
import { CANONICAL_DOCUMENT_FORMAT_VERSION } from "./model.js";

describe("canonical document migrations", () => {
  test("upgrades version 3 without adding formatting to existing paragraphs", () => {
    const current = createBlankDocument("旧文档");
    const old = { ...current, formatVersion: 3 };
    const result = migrateCanonicalDocument(old);
    expect(result).toEqual({ ok: true, value: current });
    expect(old.formatVersion).toBe(3);
  });
  test("migrates version 1 to the current version without mutating prose or assets", () => {
    const input = {
      ...createBlankDocument("迁移测试"),
      formatVersion: 1,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000101",
          type: "paragraph",
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 12,
          },
          content: [
            { type: "text", text: "原正文", marks: [] },
            { type: "inline-formula", source: "x+1" },
          ],
        },
      ],
    };
    const snapshot = structuredClone(input);
    const result = migrateCanonicalDocument(input);

    expect(input).toEqual(snapshot);
    expect(result).toMatchObject({
      ok: true,
      value: {
        formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
        content: [{ content: [{ text: "原正文" }, { source: "x+1", formulaKind: "math" }] }],
        assets: snapshot.assets,
      },
    });
    if (result.ok) expect(result.value).not.toBe(input);
  });

  test("accepts current version documents", () => {
    expect(migrateCanonicalDocument(createBlankDocument("当前版本")).ok).toBe(true);
  });

  test("preserves supported font families across repeated migrations", () => {
    const input = {
      ...createBlankDocument("字体归一化"),
      content: [
        {
          id: "00000000-0000-4000-8000-000000000201",
          type: "paragraph",
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "KaiTi",
            defaultFontSizePt: 12,
          },
          content: [
            {
              type: "text",
              text: "楷体正文",
              marks: [{ type: "font-family", value: "FangSong" }, { type: "bold" }],
            },
            {
              type: "text",
              text: "宋体正文",
              marks: [{ type: "font-family", value: "SimSun" }],
            },
          ],
        },
      ],
    };
    const snapshot = structuredClone(input);
    const once = migrateCanonicalDocument(input);
    expect(input).toEqual(snapshot);
    expect(once.ok).toBe(true);
    if (!once.ok) throw new Error("fixture");
    const paragraph = once.value.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    expect(paragraph.attrs.defaultFontFamily).toBe("KaiTi");
    const kaiTiText = paragraph.content[0];
    if (kaiTiText?.type !== "text") throw new Error("fixture");
    expect(kaiTiText.marks).toContainEqual({ type: "font-family", value: "FangSong" });
    const songText = paragraph.content[1];
    if (songText?.type !== "text") throw new Error("fixture");
    expect(songText.marks).toContainEqual({ type: "font-family", value: "SimSun" });
    const twice = migrateCanonicalDocument(once.value);
    expect(twice).toEqual(once);
  });

  test("migrates version 2 to the current version and keeps repeated migration stable", () => {
    const input = {
      ...createBlankDocument("旧版本"),
      formatVersion: 2,
    };
    const snapshot = structuredClone(input);
    const once = migrateCanonicalDocument(input);
    expect(input).toEqual(snapshot);
    expect(once).toMatchObject({
      ok: true,
      value: { formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION },
    });
    if (!once.ok) throw new Error("fixture");
    const twice = migrateCanonicalDocument(once.value);
    expect(twice).toEqual(once);
  });

  test("adds molecule mode to legacy chemical structures without mutating input", () => {
    const input = {
      ...createBlankDocument("旧结构"),
      formatVersion: 2,
      assets: [
        {
          assetId: "00000000-0000-4000-8000-000000000104",
          kind: "image",
          originalName: "structure.png",
          mediaType: "image/png",
          extension: "png",
          byteLength: 1,
          sha256: "A".repeat(64),
          widthPx: 100,
          heightPx: 100,
          previewByteLength: 1,
          previewSha256: "B".repeat(64),
        },
      ],
      content: [
        {
          id: "00000000-0000-4000-8000-000000000103",
          type: "chemical-structure",
          ketSource: "{}",
          previewAssetId: "00000000-0000-4000-8000-000000000104",
          widthMm: 80,
          alignment: "center",
        },
      ],
    };
    const snapshot = structuredClone(input);
    const result = migrateCanonicalDocument(input);
    expect(input).toEqual(snapshot);
    expect(result).toMatchObject({
      ok: true,
      value: { content: [{ editorMode: "molecule" }] },
    });
  });

  test("rejects version 2 formula fields under a version 1 envelope", () => {
    const input = {
      ...createBlankDocument("错误版本"),
      formatVersion: 1,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000102",
          type: "block-formula",
          source: "H2O",
          formulaKind: "chemistry",
        },
      ],
    };

    expect(migrateCanonicalDocument(input).ok).toBe(false);
  });

  test("fails safely for deeply nested malformed version 1 input", () => {
    const input: Record<string, unknown> = { formatVersion: 1 };
    const firstNode: Record<string, unknown> = { type: "paragraph", content: [] };
    input.content = [firstNode];
    let cursor = firstNode;
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = { type: "paragraph", content: [] };
      cursor.content = [next];
      cursor = next;
    }

    expect(() => migrateCanonicalDocument(input)).not.toThrow();
    expect(migrateCanonicalDocument(input).ok).toBe(false);
  });

  test("fails safely for circular malformed version 1 input", () => {
    const input: Record<string, unknown> = { formatVersion: 1 };
    const circularNode: Record<string, unknown> = { type: "paragraph" };
    circularNode.content = [circularNode];
    input.content = [circularNode];

    expect(() => migrateCanonicalDocument(input)).not.toThrow();
    expect(migrateCanonicalDocument(input).ok).toBe(false);
  });

  test("rejects future document versions", () => {
    const result = migrateCanonicalDocument({
      formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION + 1,
      title: "未来文档",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_VERSION");
  });

  test("rejects missing and nonexistent historical versions", () => {
    expect(migrateCanonicalDocument({ title: "无版本" }).ok).toBe(false);
    expect(migrateCanonicalDocument({ formatVersion: 0, title: "不存在的旧版本" }).ok).toBe(false);
  });
});
