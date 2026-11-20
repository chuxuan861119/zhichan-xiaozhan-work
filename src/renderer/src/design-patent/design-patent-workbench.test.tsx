import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { createPatentSession } from "../patents/patent-reducer";
import { DesignPatentWorkbench } from "./design-patent-workbench";

test("uses two primary tabs and keeps checking in the export action", () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });

  render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);

  expect(screen.getByRole("tab", { name: "图片或照片" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "简要说明" })).toBeDefined();
  expect(screen.getByRole("button", { name: "检查并导出" })).toBeDefined();
  expect(screen.queryByRole("tab", { name: /检查|导出/ })).toBeNull();
});

test("flushes before export and adopts the history committed by the main process", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const persistedPatent = structuredClone(session.patent);
  if (!persistedPatent.designPatent) throw new Error("fixture");
  persistedPatent.revision = 1;
  persistedPatent.designPatent.exports = [
    {
      exportedAt: "2026-08-11T04:00:00.000Z",
      format: "docx",
      outputDirectory: "C:\\exports\\chair",
      documentPath: "C:\\exports\\chair\\外观设计简要说明.docx",
      imagePaths: [],
      zipped: false,
      warningCodes: ["missing-product-use"],
    },
  ];
  const designPatent = vi.fn(async () => ({
    ok: true as const,
    value: {
      outputDirectory: "C:\\exports\\chair",
      documentPath: "C:\\exports\\chair\\外观设计简要说明.docx",
      imagePaths: [],
      zipPath: null,
      patent: persistedPatent,
      savedAt: "2026-08-11T04:00:00.000Z",
    },
  }));
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { exports: { designPatent } },
  });
  const onUpdate = vi.fn();
  const onPrepareExport = vi.fn(async () => 0);
  const onExportCommitted = vi.fn(() => true);
  try {
    render(
      <DesignPatentWorkbench
        session={session}
        onUpdate={onUpdate}
        onPrepareExport={onPrepareExport}
        onExportCommitted={onExportCommitted}
      />,
    );
    await user.click(screen.getByRole("button", { name: "检查并导出" }));
    await user.click(screen.getByLabelText("我已了解上述提示，确认继续导出"));
    await user.click(screen.getByRole("button", { name: "选择位置并导出" }));

    await waitFor(() => expect(onExportCommitted).toHaveBeenCalledOnce());
    expect(onPrepareExport).toHaveBeenCalledOnce();
    expect(designPatent).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
    expect(onExportCommitted).toHaveBeenCalledWith(persistedPatent, "2026-08-11T04:00:00.000Z");
    expect(onUpdate).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("collects source-expression and structured optional brief fields in the two tabs", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });

  render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);

  expect(screen.getByLabelText("主表现方式")).toBeDefined();
  await user.click(screen.getByRole("tab", { name: "简要说明" }));
  expect(screen.getByLabelText("材料说明（选填）")).toBeDefined();
  expect(screen.queryByLabelText("图形用户界面说明（选填）")).toBeNull();
  expect(screen.queryByLabelText("成套产品说明（选填）")).toBeNull();
  expect(screen.getByLabelText("设计范围")).toBeDefined();
  expect(screen.getByLabelText("最能表明设计要点的图片或照片（必填）")).toBeDefined();
  expect(screen.getByText("视图省略说明（选填）")).toBeDefined();
  expect(screen.getByLabelText("细长物品省略长度")).toBeDefined();
  expect(screen.queryByLabelText("局部设计保护部分及表示方式（条件必填）")).toBeNull();
  expect(screen.getByRole("region", { name: "简要说明实时预览" }).textContent).toContain(
    "产品名称：折叠椅。",
  );
});

test("analyzes the imported product subject before saving a view", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const descriptor = {
    assetId: crypto.randomUUID(),
    kind: "image" as const,
    originalName: "front.png",
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 100,
    heightPx: 200,
    previewByteLength: 8,
    previewSha256: "B".repeat(64),
  };
  const processDesignImage = vi.fn(async () => ({
    ok: true as const,
    value: {
      bytes: Uint8Array.from([1]),
      widthPx: 100,
      heightPx: 200,
      subjectBounds: { leftPx: 10, topPx: 20, widthPx: 80, heightPx: 160 },
    },
  }));
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        chooseAndImportMany: vi.fn(async () => ({
          ok: true as const,
          value: [{ descriptor, preview: Uint8Array.from([1]) }],
        })),
        processDesignImage,
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "导入图片" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(processDesignImage).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      assetId: descriptor.assetId,
      operations: [],
    });
    expect(onUpdate.mock.calls[0]?.[0].views[0].subjectBounds).toEqual({
      leftPx: 10,
      topPx: 20,
      widthPx: 80,
      heightPx: 160,
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("merges imported images into the latest design state after analysis", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const descriptor = {
    assetId: crypto.randomUUID(),
    kind: "image" as const,
    originalName: "front.png",
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 100,
    heightPx: 200,
    previewByteLength: 8,
    previewSha256: "B".repeat(64),
  };
  let resolveAnalysis!: (value: {
    ok: true;
    value: {
      bytes: Uint8Array;
      widthPx: number;
      heightPx: number;
      subjectBounds: { leftPx: number; topPx: number; widthPx: number; heightPx: number };
    };
  }) => void;
  const analysis = new Promise<Parameters<typeof resolveAnalysis>[0]>((resolve) => {
    resolveAnalysis = resolve;
  });
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        chooseAndImportMany: vi.fn(async () => ({
          ok: true as const,
          value: [{ descriptor, preview: Uint8Array.from([1]) }],
        })),
        processDesignImage: vi.fn(() => analysis),
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    const rendered = render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "导入图片" }));
    const sessionDesign = session.patent.designPatent;
    if (!sessionDesign) throw new Error("fixture");
    const concurrentDesign = {
      ...sessionDesign,
      brief: { ...sessionDesign.brief, productUse: "分析期间填写的用途" },
    };
    rendered.rerender(
      <DesignPatentWorkbench
        session={{ ...session, patent: { ...session.patent, designPatent: concurrentDesign } }}
        onUpdate={onUpdate}
      />,
    );
    resolveAnalysis({
      ok: true,
      value: {
        bytes: Uint8Array.from([1]),
        widthPx: 100,
        heightPx: 200,
        subjectBounds: { leftPx: 10, topPx: 10, widthPx: 80, heightPx: 180 },
      },
    });

    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      brief: { productUse: "分析期间填写的用途" },
      views: [expect.objectContaining({ assetId: descriptor.assetId, kind: "perspective" })],
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("rejects an image above the design processing limit before creating a view", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const descriptor = {
    assetId: crypto.randomUUID(),
    kind: "image" as const,
    originalName: "oversized.png",
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 10_001,
    heightPx: 4_001,
    previewByteLength: 8,
    previewSha256: "B".repeat(64),
  };
  const processDesignImage = vi.fn();
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        chooseAndImportMany: vi.fn(async () => ({
          ok: true as const,
          value: [{ descriptor, preview: Uint8Array.from([1]) }],
        })),
        processDesignImage,
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "导入图片" }));

    expect((await screen.findByRole("alert")).textContent).toContain("超过 10000 像素边长");
    expect(processDesignImage).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("shows an imported view preview and user-controlled image operations", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  const assetId = crypto.randomUUID();
  patent.designPatent.views = [
    {
      viewId: crypto.randomUUID(),
      kind: "front",
      label: "主视图",
      assetId,
      expression: "line-drawing",
      subjectBounds: { leftPx: 10, topPx: 20, widthPx: 80, heightPx: 160 },
      operations: [{ kind: "rotate", degrees: 90 }],
      note: null,
    },
  ];
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const previousApi = window.patentApi;
  const previousCreateObjectUrl = URL.createObjectURL;
  const previousRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:front-preview");
  URL.revokeObjectURL = vi.fn();
  const getPreview = vi.fn(async () => ({
    ok: true as const,
    value: Uint8Array.from([1]),
  }));
  const processDesignImage = vi.fn(async () => ({
    ok: true as const,
    value: {
      bytes: Uint8Array.from([2]),
      widthPx: 200,
      heightPx: 100,
      subjectBounds: { leftPx: 20, topPx: 10, widthPx: 160, heightPx: 80 },
    },
  }));
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview,
        processDesignImage,
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);

    expect((await screen.findByRole("img", { name: "主视图预览" })).getAttribute("src")).toBe(
      "blob:front-preview",
    );
    expect(processDesignImage).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      assetId,
      operations: [{ kind: "rotate", degrees: 90 }],
    });
    expect(getPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "裁剪空白边" })).toBeDefined();
    expect(screen.getByRole("button", { name: "顺时针旋转 90°" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "透视向左校正" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0].views[0].operations.at(-1)).toEqual({
      kind: "affine",
      xSkew: -0.06,
      ySkew: 0,
    });
    expect(screen.getByRole("button", { name: "透视向右校正" })).toBeDefined();
    expect(screen.getByRole("button", { name: "统一画布" })).toBeDefined();
    expect(screen.getByRole("button", { name: "单轴尺寸校准（高风险）" })).toBeDefined();
  } finally {
    URL.createObjectURL = previousCreateObjectUrl;
    URL.revokeObjectURL = previousRevokeObjectUrl;
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("preserves a concurrent brief edit when image processing finishes", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  const viewId = crypto.randomUUID();
  patent.designPatent.views = [
    {
      viewId,
      kind: "front",
      label: "主视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: { leftPx: 5, topPx: 5, widthPx: 80, heightPx: 160 },
      operations: [],
      note: null,
    },
  ];
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  let resolveProcessing!: (value: {
    ok: true;
    value: {
      bytes: Uint8Array;
      widthPx: number;
      heightPx: number;
      subjectBounds: { leftPx: number; topPx: number; widthPx: number; heightPx: number };
    };
  }) => void;
  const processing = new Promise<Parameters<typeof resolveProcessing>[0]>((resolve) => {
    resolveProcessing = resolve;
  });
  const processDesignImage = vi.fn(() => processing);
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview: vi.fn(() => new Promise(() => undefined)),
        processDesignImage,
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    const rendered = render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "顺时针旋转 90°" }));
    await waitFor(() => expect(processDesignImage).toHaveBeenCalledTimes(1));

    const sessionDesign = session.patent.designPatent;
    if (!sessionDesign) throw new Error("fixture");
    const concurrentDesign = structuredClone(sessionDesign);
    concurrentDesign.brief.productUse = "并发填写的新用途";
    rendered.rerender(
      <DesignPatentWorkbench
        session={{ ...session, patent: { ...session.patent, designPatent: concurrentDesign } }}
        onUpdate={onUpdate}
      />,
    );
    resolveProcessing({
      ok: true,
      value: {
        bytes: Uint8Array.from([1]),
        widthPx: 200,
        heightPx: 100,
        subjectBounds: { leftPx: 5, topPx: 5, widthPx: 160, heightPx: 80 },
      },
    });

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      brief: { productUse: "并发填写的新用途" },
      views: [expect.objectContaining({ operations: [{ kind: "rotate", degrees: 90 }] })],
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("keeps supplemental views visible and exposes per-view expression and dimension reference", () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  patent.designPatent.views = [
    {
      viewId: crypto.randomUUID(),
      kind: "reference",
      label: "使用状态参考图",
      assetId: crypto.randomUUID(),
      expression: "photo",
      subjectBounds: null,
      operations: [],
      note: null,
    },
  ];
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview: vi.fn(() => new Promise(() => undefined)),
      },
    },
  });
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);

    expect(screen.getByText("补充视图")).toBeDefined();
    expect(screen.getAllByText("使用状态参考图").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("使用状态参考图表现方式")).toBeDefined();
    expect(screen.getByLabelText("使用状态参考图视图类型")).toBeDefined();
    expect(screen.getByLabelText("使用状态参考图名称")).toBeDefined();
    expect(screen.getByRole("button", { name: "设为代表图" })).toBeDefined();
    expect(screen.getByLabelText("尺寸比例参考视图")).toBeDefined();
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("clears selected view references when their image is removed", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  const viewId = crypto.randomUUID();
  patent.designPatent.views = [
    {
      viewId,
      kind: "front",
      label: "主视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      operations: [],
      note: null,
    },
  ];
  patent.designPatent.representativeViewId = viewId;
  patent.designPatent.dimensionReferenceViewId = viewId;
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { assets: { getPreview: vi.fn(() => new Promise(() => undefined)) } },
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "移除" }));
    expect(screen.getByText(/代表图和尺寸比例参考/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: /^确定$/ }));

    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      views: [],
      representativeViewId: null,
      dimensionReferenceViewId: null,
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("swaps occupied standard view slots instead of creating duplicate kinds", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  patent.designPatent.views = [
    {
      viewId: crypto.randomUUID(),
      kind: "front",
      label: "主视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      operations: [],
      note: null,
    },
    {
      viewId: crypto.randomUUID(),
      kind: "rear",
      label: "后视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      operations: [],
      note: null,
    },
  ];
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { assets: { getPreview: vi.fn(() => new Promise(() => undefined)) } },
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.selectOptions(screen.getByLabelText("主视图视图类型"), "rear");

    expect(onUpdate.mock.calls[0]?.[0].views.map((view: { kind: string }) => view.kind)).toEqual([
      "rear",
      "front",
    ]);
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("collects a custom omission reason", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  patent.designPatent.brief.omissions = [{ viewKind: "rear", reason: "other", otherReason: "" }];
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const onUpdate = vi.fn();
  render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
  await user.click(screen.getByRole("tab", { name: "简要说明" }));
  fireEvent.change(screen.getByLabelText("后视图其他省略原因（条件必填）"), {
    target: { value: "底面无设计要点" },
  });

  expect(onUpdate.mock.calls.at(-1)?.[0].brief.omissions).toContainEqual({
    viewKind: "rear",
    reason: "other",
    otherReason: "底面无设计要点",
  });
});

test("shows the protected-part explanation only for a partial design", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  patent.designPatent.subject = "partial-design";
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });

  render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);
  await user.click(screen.getByRole("tab", { name: "简要说明" }));

  expect(screen.getByLabelText("局部设计保护部分及表示方式（条件必填）")).toBeDefined();
});
