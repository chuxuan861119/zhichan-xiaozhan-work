import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import type { PatentApi } from "../../../shared/ipc/contract";
import { createFactoryPatentTemplates } from "../../../shared/patent/templates";
import { TemplateBookEditor } from "./template-book-editor";

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

test("separates formatting, formula insertion and automatic template fields", () => {
  render(
    <TemplateBookEditor
      sessionId="groups"
      bookKind="claims"
      template={createFactoryPatentTemplates(() => crypto.randomUUID()).invention.claims}
      onChange={vi.fn()}
    />,
  );
  const formatting = screen.getByRole("group", { name: "文字格式" });
  const formulas = screen.getByRole("group", { name: "公式插入" });
  const fields = screen.getByRole("group", { name: "模板字段" });
  expect(within(formatting).getByRole("button", { name: "加粗" })).toBeDefined();
  expect(within(formulas).getByRole("button", { name: "化学结构式" })).toBeDefined();
  expect(within(formulas).getByRole("button", { name: "数学公式" })).toBeDefined();
  expect(within(fields).getByRole("button", { name: "专利题目" })).toBeDefined();
  expect(within(fields).getByRole("button", { name: "发明/实用新型" })).toBeDefined();
  expect(within(formatting).queryByRole("button", { name: "化学结构式" })).toBeNull();
});

test("template text color opens the shared swatch palette before custom colors", () => {
  const template = createFactoryPatentTemplates(() => crypto.randomUUID()).invention.claims;
  render(
    <TemplateBookEditor
      sessionId="palette-test"
      bookKind="claims"
      template={template}
      onChange={vi.fn()}
    />,
  );
  expect(document.querySelector('input[aria-label="文字颜色"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "应用文字颜色" }));
  expect(screen.queryByRole("dialog", { name: "文字颜色" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
  const palette = screen.getByRole("dialog", { name: "文字颜色" });
  expect(within(palette).getByText("主题颜色")).toBeDefined();
  expect(within(palette).getByText("标准色")).toBeDefined();
  fireEvent.click(within(palette).getByRole("button", { name: "自动(A)" }));
  expect(screen.queryByRole("dialog", { name: "文字颜色" })).toBeNull();
});
const originalRangeBounds = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getBoundingClientRect",
);

beforeEach(() => {
  // jsdom has no layout APIs; Tiptap focuses and scrolls after inserting a structure.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
});

afterEach(() => {
  for (const [name, descriptor] of [
    ["getClientRects", originalRangeRects],
    ["getBoundingClientRect", originalRangeBounds],
  ] as const) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
    else Reflect.deleteProperty(Range.prototype, name);
  }
  vi.restoreAllMocks();
});

vi.mock("../chemistry/ketcher-editor", () => ({
  KetcherEditor: ({
    onReady,
    onContentChange,
  }: {
    onReady(adapter: { readDraft(): Promise<unknown> }): void;
    onContentChange?(state: { hasContent: boolean; dirty: boolean }): void;
  }) => {
    useEffect(() => {
      onReady({
        readDraft: async () => ({ ok: true, value: { ket: "(ket)", svg: "<svg/>" } }),
      });
      onContentChange?.({ hasContent: true, dirty: false });
    }, [onReady, onContentChange]);
    return <p>结构编辑器已就绪</p>;
  },
}));

test("opens the template editor when Electron does not expose crypto.randomUUID", () => {
  const template = createFactoryPatentTemplates(() => "00000000-0000-4000-8000-000000000701")
    .invention.claims;
  const originalRandomUuid = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });

  try {
    render(
      <TemplateBookEditor
        sessionId="00000000-0000-4000-8000-000000000300"
        bookKind="claims"
        template={template}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("toolbar", { name: "模板格式工具栏" })).toBeDefined();
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: originalRandomUuid,
    });
  }
});

test("keeps a newly staged chemical preview valid while saving the edited template", async () => {
  const previewAssetId = "00000000-0000-4000-8000-000000000702";
  const descriptor = {
    assetId: previewAssetId,
    kind: "chemical-preview" as const,
    originalName: "structure.svg",
    mediaType: "image/svg+xml" as const,
    extension: "svg" as const,
    byteLength: 4,
    sha256: "A".repeat(64),
    widthPx: 128,
    heightPx: 96,
    previewByteLength: 4,
    previewSha256: "B".repeat(64),
  };
  window.patentApi = {
    chemistry: {
      rasterizePreview: vi.fn(async () => ({
        ok: true as const,
        value: { descriptor, preview: Uint8Array.from([137, 80, 78, 71]) },
      })),
    },
    assets: {
      getPreview: vi.fn(async () => ({
        ok: false as const,
        error: { code: "NOT_FOUND", message: "missing" },
      })),
    },
  } as unknown as PatentApi;
  const template = createFactoryPatentTemplates(() => crypto.randomUUID()).invention.claims;
  const onChange = vi.fn();
  const user = userEvent.setup();

  render(
    <TemplateBookEditor
      sessionId="00000000-0000-4000-8000-000000000300"
      bookKind="claims"
      template={template}
      onChange={onChange}
    />,
  );

  await user.click(screen.getByRole("button", { name: "化学结构式" }));
  await screen.findByText("结构编辑器已就绪");
  await user.click(screen.getByRole("button", { name: "插入" }));

  await waitFor(() =>
    expect(
      onChange.mock.calls.some(([updated]) =>
        updated.content.some(
          (node: { type: string; previewAssetId?: string }) =>
            node.type === "chemical-structure" && node.previewAssetId === previewAssetId,
        ),
      ),
    ).toBe(true),
  );
  // Let the insertion's deferred focus/scroll finish while layout stubs are installed.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
});
