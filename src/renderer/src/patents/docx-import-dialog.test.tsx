import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createBlankBookDocument } from "../../../shared/document/defaults";
import type { DocxImportPreview } from "../../../shared/ipc/contract";
import { DocxImportDialog } from "./docx-import-dialog";

const sessionId = "00000000-0000-4000-8000-000000000701";
const unitId = "00000000-0000-4000-8000-000000000702";
const warningId = "00000000-0000-4000-8000-000000000703";

function preview(): DocxImportPreview {
  return {
    sessionId,
    sourceFileNames: ["五书.docx"],
    duplicateOfficialTargets: [],
    warnings: [
      {
        warningId,
        unitId,
        code: "UNSUPPORTED_SMARTART",
        message: "SmartArt 无法转换，已保留提示位置。",
        severity: "important",
      },
    ],
    units: [
      {
        unitId,
        sourceFileName: "五书.docx",
        title: "权利要求书",
        target: { kind: "official-book", bookKind: "claims" },
        confidence: "high",
        evidence: ["检测到文档标题“权利要求书”"],
        document: {
          ...createBlankBookDocument("权利要求书"),
          content: [
            {
              id: crypto.randomUUID(),
              type: "paragraph",
              attrs: {
                alignment: "left",
                lineSpacing: 1.5,
                paragraphIndentMm: 0,
                defaultFontFamily: "SimSun",
                defaultFontSizePt: 14,
              },
              content: [{ type: "text", text: "1. 一种装置", marks: [] }],
            },
          ],
        },
        imageCount: 0,
      },
    ],
  };
}

describe("DocxImportDialog", () => {
  it("shows fixed recognition results without rename or reassignment controls", () => {
    render(
      <DocxImportDialog
        preview={preview()}
        busy={false}
        onUpdate={vi.fn()}
        onCancel={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("导入到")).toBeNull();
    expect(screen.queryByLabelText("文档名称")).toBeNull();
    expect(screen.queryByText("其他文档")).toBeNull();
    expect((screen.getByRole("button", { name: "创建并导入" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("renders three columns and requires important-warning acknowledgement", async () => {
    const onCommit = vi.fn(async () => undefined);
    render(
      <DocxImportDialog
        preview={preview()}
        busy={false}
        onUpdate={vi.fn(async () => undefined)}
        onCancel={vi.fn(async () => undefined)}
        onCommit={onCommit}
      />,
    );

    expect(screen.getByRole("dialog", { name: "导入docx" })).toBeDefined();
    expect(screen.getByLabelText("来源文件与内容")).toBeDefined();
    expect(screen.getByLabelText("文档内容预览").textContent).toContain("1. 一种装置");
    expect(screen.getByLabelText("导入设置")).toBeDefined();
    expect(screen.getByText("原 DOCX 不会保存在软件中，请自行保留源文件。")).toBeDefined();
    const commit = screen.getByRole("button", { name: "创建并导入" }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("请先确认所有重要导入提示");
    fireEvent.click(screen.getByRole("checkbox", { name: /SmartArt 无法转换/u }));
    expect(commit.disabled).toBe(false);
    fireEvent.click(commit);
    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          assignments: [expect.objectContaining({ unitId })],
          acknowledgedWarningIds: [warningId],
        }),
      ),
    );
  });

  it("explains when creating the imported patent takes longer than expected", async () => {
    vi.useFakeTimers();
    let resolveCommit: (() => void) | undefined;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    const view = render(
      <DocxImportDialog
        preview={{ ...preview(), warnings: [] }}
        busy={false}
        onUpdate={vi.fn(async () => undefined)}
        onCancel={vi.fn(async () => undefined)}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建并导入" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      (screen.getByRole("button", { name: "正在准备导入…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByText("导入耗时较长，仍在处理中，请勿重复操作。")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByRole("status").textContent).toContain(
      "导入耗时较长，仍在处理中，请勿重复操作。",
    );

    resolveCommit?.();
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    vi.useRealTimers();
  });

  it("shows basic paragraph and run formatting in the preview", () => {
    const formatted = preview();
    const unit = formatted.units[0];
    if (!unit) throw new Error("preview unit missing");
    unit.document.content = [
      {
        id: crypto.randomUUID(),
        type: "paragraph",
        attrs: {
          alignment: "center",
          lineSpacing: 2,
          paragraphIndentMm: 9.88,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 14,
        },
        content: [
          {
            type: "text",
            text: "格式预览",
            marks: [
              { type: "bold" },
              { type: "italic" },
              { type: "underline" },
              { type: "color", value: "#123456" },
              { type: "background-color", value: "#FEDCBA" },
              { type: "font-family", value: "KaiTi" },
              { type: "font-size", valuePt: 16 },
            ],
          },
        ],
      },
    ];

    render(
      <DocxImportDialog
        preview={{ ...formatted, warnings: [] }}
        busy={false}
        onUpdate={vi.fn(async () => undefined)}
        onCancel={vi.fn(async () => undefined)}
        onCommit={vi.fn(async () => undefined)}
      />,
    );

    const text = screen.getByText("格式预览");
    const paragraph = text.closest("p");
    expect(paragraph?.style.textAlign).toBe("center");
    expect(paragraph?.style.textIndent).toBe("9.88mm");
    expect(paragraph?.style.lineHeight).toBe("2");
    expect(paragraph?.style.fontFamily).toContain("SimSun");
    expect(paragraph?.style.fontSize).toBe("14pt");
    expect(text.style.fontWeight).toBe("700");
    expect(text.style.fontStyle).toBe("italic");
    expect(text.style.textDecoration).toContain("underline");
    expect(text.style.color).toBe("rgb(18, 52, 86)");
    expect(text.style.backgroundColor).toBe("rgb(254, 220, 186)");
    expect(text.style.fontFamily).toContain("KaiTi");
    expect(text.style.fontSize).toBe("16pt");
  });

  it("loads staged DOCX images into the content preview", async () => {
    const assetId = "00000000-0000-4000-8000-000000000704";
    const getDocxImportPreviewAsset = vi.fn(async () => ({
      ok: true as const,
      value: Uint8Array.from([137, 80, 78, 71]),
    }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { patents: { getDocxImportPreviewAsset } },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:docx-import-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const withImage = preview();
    const unit = withImage.units[0];
    if (!unit) throw new Error("preview unit missing");
    unit.document.content.push({
      id: crypto.randomUUID(),
      type: "figure",
      assetId,
      widthMm: 80,
      alignment: "center",
    });
    unit.imageCount = 1;

    render(
      <DocxImportDialog
        preview={{ ...withImage, warnings: [] }}
        busy={false}
        onUpdate={vi.fn(async () => undefined)}
        onCancel={vi.fn(async () => undefined)}
        onCommit={vi.fn(async () => undefined)}
      />,
    );

    const image = await screen.findByRole("img", { name: "导入图片预览" });
    expect(image.getAttribute("src")).toBe("blob:docx-import-preview");
    expect(getDocxImportPreviewAsset).toHaveBeenCalledWith(sessionId, assetId);
    expect(screen.queryByText(new RegExp(assetId.slice(0, 8), "u"))).toBeNull();
  });
});

it("prefills the centered description title and preserves the user's replacement", async () => {
  const source = preview();
  source.warnings = [];
  const unit = source.units[0]!;
  unit.target = { kind: "official-book", bookKind: "description" };
  const first = unit.document.content[0]!;
  if (first.type !== "paragraph") throw new Error("fixture");
  first.attrs.alignment = "center";
  first.content = [{ type: "text", text: "一种自动送料装置", marks: [] }];
  const commit = vi.fn(async () => undefined);
  render(
    <DocxImportDialog
      preview={source}
      busy={false}
      onUpdate={vi.fn()}
      onCancel={vi.fn()}
      onCommit={commit}
    />,
  );
  const name = screen.getByRole("textbox", { name: "专利名称" });
  expect((name as HTMLInputElement).value).toBe("一种自动送料装置");
  fireEvent.change(name, { target: { value: "用户修改的题目" } });
  fireEvent.click(screen.getByRole("button", { name: "创建并导入" }));
  await waitFor(() =>
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ name: "用户修改的题目" })),
  );
});
