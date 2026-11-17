import { createBlankBookDocument, createBlankDocument } from "./defaults.js";
import {
  createImmutablePatentBookValidator,
  validateCanonicalDocument,
  validatePatentBookDocument,
} from "./validation.js";

describe("validatePatentBookDocument", () => {
  test("does not require canonical-only patent type or assets fields", () => {
    const book = createBlankBookDocument("说明书", "2026-08-02T00:00:00.000Z");

    expect(validatePatentBookDocument(book, new Set())).toEqual({ ok: true, value: book });
  });

  test("requires figures to refer to supplied book assets", () => {
    const book = createBlankBookDocument("附图", "2026-08-02T00:00:00.000Z");
    const assetId = "00000000-0000-4000-8000-000000000330";
    const input = {
      ...book,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000331",
          type: "figure" as const,
          assetId,
          widthMm: 80,
          alignment: "center" as const,
        },
      ],
    };

    expect(validatePatentBookDocument(input, new Set())).toMatchObject({ ok: false });
    expect(validatePatentBookDocument(input, new Set([assetId]))).toEqual({
      ok: true,
      value: input,
    });
  });

  test("requires inline figures to reference supplied assets and use unique node ids", () => {
    const { assets: _assets, patentType: _patentType, ...book } = createBlankDocument("说明书");
    const paragraph = book.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("缺少段落");
    const assetId = "00000000-0000-4000-8000-000000000332";
    const inlineFigure = {
      id: "00000000-0000-4000-8000-000000000333",
      type: "inline-figure" as const,
      assetId,
      widthMm: 30,
      alignment: "center" as const,
      rotationDeg: 0 as const,
    };
    paragraph.content = [inlineFigure];

    expect(validatePatentBookDocument(book, new Set())).toMatchObject({ ok: false });
    expect(validatePatentBookDocument(book, new Set([assetId]))).toEqual({ ok: true, value: book });
    book.content.push({ ...paragraph, id: crypto.randomUUID(), content: [inlineFigure] });
    expect(validatePatentBookDocument(book, new Set([assetId]))).toMatchObject({ ok: false });
  });

  test("requires chemical structure previews to be present, referenced and bounded", () => {
    const previewAssetId = "00000000-0000-4000-8000-000000000340";
    const preview = {
      assetId: previewAssetId,
      kind: "chemical-preview" as const,
      originalName: "structure.svg",
      mediaType: "image/svg+xml" as const,
      extension: "svg" as const,
      byteLength: 12,
      sha256: "A".repeat(64),
      widthPx: 4096,
      heightPx: 4096,
      previewByteLength: 12,
      previewSha256: "B".repeat(64),
    };
    const structure = {
      id: "00000000-0000-4000-8000-000000000341",
      type: "chemical-structure" as const,
      ketSource: "(ket) (atom C)",
      previewAssetId,
      widthMm: 80,
      alignment: "center" as const,
    };
    const {
      assets: _assets,
      patentType: _patentType,
      ...book
    } = {
      ...createBlankDocument("结构预览"),
      content: [structure],
      assets: [preview],
    };

    expect(validatePatentBookDocument(book, new Set([previewAssetId]), [preview])).toEqual({
      ok: true,
      value: book,
    });
    expect(validatePatentBookDocument(book, new Set())).toMatchObject({ ok: false });
    expect(
      validatePatentBookDocument(book, new Set([previewAssetId]), [
        {
          ...preview,
          kind: "image",
          mediaType: "image/jpeg",
          extension: "jpg",
        },
      ]),
    ).toMatchObject({ ok: false });
    expect(
      validatePatentBookDocument(book, new Set([previewAssetId]), [{ ...preview, widthPx: 4097 }]),
    ).toMatchObject({ ok: false });
    const cached = createImmutablePatentBookValidator();
    expect(cached(book, new Set([previewAssetId]), [preview]).ok).toBe(true);
    expect(cached(book, new Set(), [preview]).ok).toBe(false);
    expect(cached(book, new Set([previewAssetId]), [{ ...preview, widthPx: 4097 }]).ok).toBe(false);
    expect(cached(book, new Set([previewAssetId]), []).ok).toBe(false);
    expect(cached(book, new Set([previewAssetId]), [preview])).toEqual(
      validatePatentBookDocument(book, new Set([previewAssetId]), [preview]),
    );
  });

  test("accepts a legacy PNG image descriptor as a chemical structure preview", () => {
    const previewAssetId = "00000000-0000-4000-8000-000000000342";
    const preview = {
      assetId: previewAssetId,
      kind: "image" as const,
      originalName: "structure.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: 12,
      sha256: "A".repeat(64),
      widthPx: 1024,
      heightPx: 1024,
      previewByteLength: 12,
      previewSha256: "B".repeat(64),
    };
    const structure = {
      id: "00000000-0000-4000-8000-000000000343",
      type: "chemical-structure" as const,
      ketSource: "(ket) (atom C)",
      previewAssetId,
      widthMm: 80,
      alignment: "center" as const,
    };
    const {
      assets: _assets,
      patentType: _patentType,
      ...book
    } = {
      ...createBlankDocument("旧结构预览"),
      content: [structure],
      assets: [preview],
    };

    expect(validatePatentBookDocument(book, new Set([previewAssetId]), [preview])).toEqual({
      ok: true,
      value: book,
    });
  });

  test("validates canonical chemical structure preview descriptors", () => {
    const assetId = "00000000-0000-4000-8000-000000000350";
    const document = createBlankDocument("结构预览");
    document.content = [
      {
        id: "00000000-0000-4000-8000-000000000351",
        type: "chemical-structure",
        ketSource: "(ket) (atom O)",
        previewAssetId: assetId,
        widthMm: 80,
        alignment: "center",
      },
    ];
    document.assets = [
      {
        assetId,
        kind: "chemical-preview",
        originalName: "structure.svg",
        mediaType: "image/svg+xml",
        extension: "svg",
        byteLength: 12,
        sha256: "A".repeat(64),
        widthPx: 1024,
        heightPx: 1024,
        previewByteLength: 12,
        previewSha256: "B".repeat(64),
      },
    ];

    expect(validateCanonicalDocument(document).ok).toBe(true);
  });
});
