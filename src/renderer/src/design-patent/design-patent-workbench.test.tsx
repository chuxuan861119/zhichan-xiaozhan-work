import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { createPatentSession } from "../patents/patent-reducer";
import { DesignPatentWorkbench } from "./design-patent-workbench";

function workflowTab(name: RegExp) {
  return within(screen.getByRole("tablist", { name: "外观设计步骤" })).getByRole("tab", { name });
}

test("switches empty image modes and hides all six-view-only interfaces in multi mode", async () => {
  const patent = createBlankPatent({ patentType: "design", name: "模式测试" });
  const onUpdate = vi.fn();
  const previous = window.patentApi;
  window.patentApi = {
    assets: { getPreview: async () => ({ ok: false }) },
  } as unknown as typeof previous;
  try {
    const session = createPatentSession({
      patentId: patent.patentId,
      sessionId: crypto.randomUUID(),
      revision: 0,
      patent,
      saveState: "saved",
    });
    const result = render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "多图模式" }));
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ imageMode: "multi-image", views: [] }),
      [],
    );
    result.rerender(
      <DesignPatentWorkbench
        session={{ ...session, patent: { ...patent, designPatent: onUpdate.mock.calls[0]![0] } }}
        onUpdate={onUpdate}
      />,
    );
    expect(screen.getByRole("button", { name: "添加图片" })).toBeDefined();
    expect(screen.queryByLabelText("图片暂存区")).toBeNull();
    expect(screen.queryByLabelText("六视图展开布局")).toBeNull();
    await userEvent.setup().click(workflowTab(/导出/u));
    expect(screen.queryByText("长宽高对应检查")).toBeNull();
  } finally {
    window.patentApi = previous;
  }
});

test("requires explicit confirmation to discard images and preserves mode on save failure or cancellation", async () => {
  const patent = createBlankPatent({ patentType: "design", name: "模式切换" });
  patent.designPatent!.views = [
    {
      viewId: crypto.randomUUID(),
      assetId: crypto.randomUUID(),
      kind: "front",
      label: "主视图",
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      assignmentStatus: "confirmed",
      assignmentEvidence: null,
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
  const previous = window.patentApi;
  window.patentApi = {
    assets: { getPreview: async () => ({ ok: false }) },
  } as unknown as typeof previous;
  const onSwitchImageMode = vi.fn(async () => {
      throw new Error("保存失败");
    }),
    onUpdate = vi.fn();
  try {
    render(
      <DesignPatentWorkbench
        session={session}
        onUpdate={onUpdate}
        onSwitchImageMode={onSwitchImageMode}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "多图模式" }));
    expect(screen.getByRole("dialog", { name: "切换图片模式" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "取消切换" }));
    expect(onSwitchImageMode).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "多图模式" }));
    await user.click(screen.getByRole("button", { name: "放弃当前图片并切换" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("保存失败"));
    expect(onUpdate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消切换" }));
    expect(screen.getByRole("button", { name: "六视图模式" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  } finally {
    window.patentApi = previous;
  }
});

test("imports multi-file drops from any assignment child, queues repeated drops and preserves filename assignment", async () => {
  const patent = createBlankPatent({ patentType: "design", name: "拖入测试" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const makeAsset = (name: string) => ({
    descriptor: {
      assetId: crypto.randomUUID(),
      kind: "image",
      originalName: name,
      mediaType: "image/png",
      extension: "png",
      byteLength: 1,
      sha256: "A".repeat(64),
      widthPx: 100,
      heightPx: 200,
      previewByteLength: 1,
      previewSha256: "B".repeat(64),
    },
    preview: new Uint8Array([1]),
  });
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const importBytes = vi.fn(async ({ originalName }: { originalName: string }) => {
    if (originalName === "主视图.png") await pause;
    return { ok: true, value: makeAsset(originalName) };
  });
  const choose = vi.fn();
  const previous = window.patentApi;
  window.patentApi = {
    assets: {
      importBytes,
      chooseAndImportMany: choose,
      getPreview: async () => ({ ok: false }),
      processDesignImage: async () => ({ ok: true, value: { subjectBounds: null } }),
    },
  } as unknown as typeof previous;
  const file = (name: string) => {
    const value = new File(["image"], name, { type: "image/png" });
    Object.defineProperty(value, "arrayBuffer", { value: async () => new Uint8Array([1]).buffer });
    return value;
  };
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    const front = screen.getByRole("article", { name: "主视图：待分配" });
    const first = [file("主视图.png"), file("unknown.png")];
    fireEvent.drop(front, { dataTransfer: { files: first, types: ["Files"] } });
    await waitFor(() => expect(importBytes).toHaveBeenCalledTimes(1));
    fireEvent.drop(screen.getByRole("region", { name: "图片暂存区" }), {
      dataTransfer: { files: [file("左视图.jpg")], types: ["Files"] },
    });
    release();
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(importBytes).toHaveBeenCalledTimes(3);
    expect(choose).not.toHaveBeenCalled();
    expect(onUpdate.mock.calls[1]![0].views.map((v: { kind: string }) => v.kind)).toEqual([
      "front",
      "unassigned",
      "left",
    ]);
    expect(onUpdate.mock.calls[1]![1]).toHaveLength(3);
    await userEvent.setup().click(workflowTab(/简要说明/u));
    fireEvent.drop(screen.getByRole("article", { name: "外观设计简要说明填写页" }), {
      dataTransfer: { files: [file("后视图.png")], types: ["Files"] },
    });
    expect(importBytes).toHaveBeenCalledTimes(3);
    await userEvent.setup().click(workflowTab(/小栈修图/u));
    fireEvent.drop(screen.getByRole("tabpanel", { name: /小栈修图/u }), {
      dataTransfer: { files: [file("后视图.png")], types: ["Files"] },
    });
    expect(importBytes).toHaveBeenCalledTimes(3);
  } finally {
    release();
    window.patentApi = previous;
  }
});

test("representative options include assigned perspective views but exclude holding and legacy holding selections", async () => {
  const patent = createBlankPatent({ patentType: "design", name: "暂存隔离" });
  if (!patent.designPatent) throw new Error("fixture");
  const heldId = crypto.randomUUID();
  patent.designPatent.views = [
    {
      viewId: crypto.randomUUID(),
      assetId: crypto.randomUUID(),
      kind: "perspective",
      label: "立体图1",
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      operations: [],
      note: null,
    },
    {
      viewId: heldId,
      assetId: crypto.randomUUID(),
      kind: "unassigned",
      label: "未分配图片.png",
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      operations: [],
      note: null,
    },
  ];
  patent.designPatent.representativeViewId = heldId;
  const previous = window.patentApi;
  window.patentApi = {
    assets: {
      getPreview: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "fixture" } }),
    },
  } as unknown as typeof window.patentApi;
  try {
    render(
      <DesignPatentWorkbench
        session={createPatentSession({
          patentId: patent.patentId,
          sessionId: crypto.randomUUID(),
          revision: 0,
          patent,
          saveState: "saved",
        })}
        onUpdate={vi.fn()}
      />,
    );
    await userEvent.setup().click(workflowTab(/简要说明/u));
    const select = screen.getByRole("combobox", { name: /最能表明设计要点的图片或照片/ });
    expect(within(select).getByRole("option", { name: "立体图1" })).toBeDefined();
    expect(within(select).queryByRole("option", { name: "未分配图片.png" })).toBeNull();
    expect((select as HTMLSelectElement).value).toBe("");
    expect(screen.queryByAltText("代表图缩略图")).toBeNull();
  } finally {
    window.patentApi = previous;
  }
});

test("uses the four-step workflow navigation and opens export as a workspace page", async () => {
  const user = userEvent.setup();
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview: async () => ({ ok: true, value: Uint8Array.from([1]) }),
        processDesignImage: async () => ({
          ok: true,
          value: { bytes: Uint8Array.from([1]), widthPx: 1, heightPx: 1, subjectBounds: null },
        }),
      },
    },
  });
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });

  render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);

  expect(workflowTab(/图片整理/u)).toBeDefined();
  expect(workflowTab(/简要说明/u)).toBeDefined();
  expect(workflowTab(/导出/u)).toBeDefined();
  expect(document.querySelector(".design-patent-workbench__content")).not.toBeNull();
  const assignmentWorkspace = screen.getByRole("region", { name: "图片整理工作区" });
  expect(within(assignmentWorkspace).queryByRole("heading", { name: "分配视图" })).toBeNull();
  expect(within(assignmentWorkspace).queryByLabelText("主表现方式")).toBeNull();
  expect(within(assignmentWorkspace).queryByLabelText("尺寸比例参考视图")).toBeNull();
  expect(within(assignmentWorkspace).queryByRole("button", { name: "检查并导出" })).toBeNull();
  expect(within(assignmentWorkspace).getByRole("region", { name: "导入素材" })).toBeDefined();
  expect(within(assignmentWorkspace).getByRole("region", { name: "视图板" })).toBeDefined();
  expect(within(assignmentWorkspace).getByRole("region", { name: "图片暂存区" })).toBeDefined();
  expect(within(assignmentWorkspace).queryByRole("region", { name: "当前图片" })).toBeNull();
  expect(screen.queryByRole("region", { name: "下一步建议" })).toBeNull();
  expect(document.querySelector(".design-patent-workbench__images-layout")).toBeNull();
  expect(screen.queryByRole("complementary", { name: "本页检查" })).toBeNull();
  expect(screen.queryByRole("region", { name: "立体图" })).toBeNull();
  expect(screen.queryByRole("region", { name: "正投影视图" })).toBeNull();
  expect(workflowTab(/图片整理/u).getAttribute("aria-selected")).toBe("true");

  await user.click(workflowTab(/导出/u));

  expect(workflowTab(/导出/u).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("region", { name: "申报前检查" })).toBeNull();
  expect(screen.getByRole("complementary", { name: "导出申请文件" })).toBeDefined();
  expect(screen.queryByRole("dialog", { name: "导出前检查" })).toBeNull();
});

test("uses one workflow main region and opens the actual brief editor from its workflow tab", async () => {
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

  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.queryByRole("tablist", { name: "外观设计工作台" })).toBeNull();
  expect(screen.queryByRole("button", { name: "去填写简要说明" })).toBeNull();
  await user.click(workflowTab(/简要说明/u));

  expect(
    within(screen.getByRole("tablist", { name: "外观设计步骤" }))
      .getByRole("tab", { name: /简要说明/u })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByLabelText("产品用途（必填）")).toBeDefined();
  expect(workflowTab(/简要说明/u).getAttribute("aria-selected")).toBe("true");
});

test("revokes a preview URL created after its image step unmounts", async () => {
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
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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
  let resolvePreview!: (value: { ok: true; value: Uint8Array }) => void;
  const previousApi = window.patentApi;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const revoke = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:late-preview");
  URL.revokeObjectURL = revoke;
  const getPreview = vi.fn(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
  );
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { assets: { getPreview } },
  });
  try {
    const rendered = render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);
    await waitFor(() => expect(getPreview).toHaveBeenCalled());
    rendered.unmount();
    await act(async () => {
      resolvePreview({ ok: true, value: Uint8Array.from([1]) });
    });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob)));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:late-preview"));
  } finally {
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("does not overwrite an externally changed correction recipe", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  const view = {
    viewId: crypto.randomUUID(),
    kind: "front" as const,
    label: "主视图",
    assetId: crypto.randomUUID(),
    expression: "line-drawing" as const,
    subjectBounds: null,
    subjectBoundsSource: null,
    subjectBoundsConfirmed: false,
    operations: [],
    note: null,
  };
  patent.designPatent.views = [view];
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const onUpdate = vi.fn();
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: { getPreview: vi.fn(async () => ({ ok: true, value: Uint8Array.from([1]) })) },
    },
  });
  try {
    const rendered = render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(workflowTab(/小栈修图/u));
    await user.click(screen.getByRole("button", { name: "向右旋转 90°" }));
    const externallyChanged = {
      ...session,
      patent: {
        ...patent,
        designPatent: {
          ...patent.designPatent,
          views: [{ ...view, operations: [{ kind: "rotate" as const, degrees: 10 }] }],
        },
      },
    };
    rendered.rerender(<DesignPatentWorkbench session={externallyChanged} onUpdate={onUpdate} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "应用修改" })).toBeDefined());
    await user.click(screen.getByRole("button", { name: "应用修改" }));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("图片已在其他位置更新");
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("blocks a design edit after switching steps while export is pending", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  let resolveExport!: (value: { ok: true; value: null }) => void;
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      exports: {
        chooseDesignPatentDestination: async () => ({ ok: true, value: crypto.randomUUID() }),
        designPatent: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveExport = resolve;
            }),
        ),
      },
      assets: { getPreview: vi.fn() },
    },
  });
  const onUpdate = vi.fn();
  try {
    render(
      <DesignPatentWorkbench
        session={session}
        onUpdate={onUpdate}
        onPrepareExport={async () => ({ previewRevision: 0, revision: 0 })}
      />,
    );
    await user.click(workflowTab(/导出/u));
    await user.click(screen.getByRole("button", { name: "选择位置并导出" }));
    await user.click(workflowTab(/简要说明/u));
    await user.type(screen.getByLabelText("产品用途（必填）"), "用于测试。");
    expect(onUpdate).not.toHaveBeenCalled();
    await act(async () => {
      resolveExport({ ok: true, value: null });
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("blocks correction apply while a design export is pending", async () => {
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
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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
  let finishExport!: (value: { ok: true; value: null }) => void;
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      exports: {
        chooseDesignPatentDestination: async () => ({ ok: true, value: crypto.randomUUID() }),
        designPatent: () =>
          new Promise((resolve) => {
            finishExport = resolve;
          }),
      },
      assets: { getPreview: vi.fn(async () => ({ ok: true, value: Uint8Array.from([1]) })) },
    },
  });
  const onUpdate = vi.fn();
  try {
    render(
      <DesignPatentWorkbench
        session={session}
        onUpdate={onUpdate}
        onPrepareExport={async () => ({ previewRevision: 0, revision: 0 })}
      />,
    );
    await user.click(workflowTab(/导出/u));
    await user.click(screen.getByRole("button", { name: "选择位置并导出" }));
    await user.click(workflowTab(/小栈修图/u));
    await user.click(screen.getByRole("button", { name: "向右旋转 90°" }));
    await user.click(screen.getByRole("button", { name: "应用修改" }));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("导出进行中");
    await act(async () => finishExport({ ok: true, value: null }));
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
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
    value: {
      exports: {
        designPatent,
        chooseDesignPatentDestination: async () => ({ ok: true, value: crypto.randomUUID() }),
      },
    },
  });
  const onUpdate = vi.fn();
  const onPrepareExport = vi.fn(async () => ({ previewRevision: 0, revision: 1 }));
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
    await user.click(workflowTab(/导出/u));
    await user.click(screen.getByRole("button", { name: "选择位置并导出" }));

    await waitFor(() => expect(onExportCommitted).toHaveBeenCalledOnce());
    expect(onPrepareExport).toHaveBeenCalledOnce();
    expect(designPatent).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1 }));
    expect(onExportCommitted).toHaveBeenCalledWith(persistedPatent, "2026-08-11T04:00:00.000Z");
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("导出完成");
    expect(screen.getByRole("status").textContent).toContain("C:\\exports\\chair");
    expect(workflowTab(/导出/u).getAttribute("aria-selected")).toBe("true");
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("collects structured optional brief fields in the brief page", async () => {
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

  await user.click(workflowTab(/简要说明/u));
  const briefPage = screen.getByRole("article", { name: "外观设计简要说明填写页" });
  expect(document.querySelectorAll(".design-patent-workbench__brief-sheet")).toHaveLength(1);
  expect(within(briefPage).getByRole("group", { name: "基本信息" })).toBeDefined();
  expect(screen.getByRole("group", { name: "视图省略说明" })).toBeDefined();
  expect(screen.getByRole("checkbox", { name: "省略左视图" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "其他补充说明" }));
  expect(screen.getByLabelText("材料说明（选填）")).toBeDefined();
  expect(screen.queryByLabelText("图形用户界面说明（选填）")).toBeNull();
  expect(screen.queryByLabelText("成套产品说明（选填）")).toBeNull();
  expect(screen.getByLabelText("设计范围")).toBeDefined();
  expect(screen.getByLabelText("最能表明设计要点的图片或照片（必填）")).toBeDefined();
  expect(screen.getByText("视图省略说明")).toBeDefined();
  expect(screen.getByLabelText("细长物品省略长度")).toBeDefined();
  expect(screen.queryByLabelText("局部设计保护部分及表示方式（条件必填）")).toBeNull();
  expect(within(briefPage).queryByRole("region", { name: "简要说明实时预览" })).toBeNull();
  await user.click(within(briefPage).getByRole("button", { name: "正文预览" }));
  expect(within(briefPage).getByRole("region", { name: "简要说明实时预览" }).textContent).toContain(
    "产品名称：折叠椅。",
  );
  expect(within(briefPage).queryByLabelText("产品用途（必填）")).toBeNull();
});

test("presents the brief as one document surface with grouped supplemental fields", async () => {
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
  await user.click(workflowTab(/简要说明/u));

  const briefPanel = screen.getByRole("tabpanel", { name: /简要说明/u });
  const briefPage = within(briefPanel).getByRole("article", {
    name: "外观设计简要说明填写页",
  });
  expect(
    within(briefPanel)
      .getByRole("heading", { name: "简要说明" })
      .classList.contains("design-workspace-shell__visually-hidden"),
  ).toBe(true);
  expect(within(briefPanel).queryByRole("heading", { name: "折叠椅" })).toBeNull();
  await user.click(within(briefPage).getByRole("button", { name: "其他补充说明" }));
  const supplementalGroup = within(briefPage).getByRole("group", {
    name: "补充内容",
  });
  expect(within(supplementalGroup).getByLabelText("其他需要说明的内容（选填）")).toBeDefined();
  expect(within(supplementalGroup).getByLabelText("材料说明（选填）")).toBeDefined();
});

test("opens the selected representative view in the image-board viewer without changing the brief", async () => {
  const user = userEvent.setup();
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview: async () => ({ ok: true, value: Uint8Array.from([1]) }),
        processDesignImage: async () => ({
          ok: true,
          value: { bytes: Uint8Array.from([1]), widthPx: 1, heightPx: 1, subjectBounds: null },
        }),
      },
    },
  });
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
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      assignmentStatus: "confirmed",
      assignmentEvidence: null,
      operations: [],
      note: null,
    },
  ];
  patent.designPatent.representativeViewId = viewId;
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(workflowTab(/简要说明/u));
    const thumbnail = await screen.findByRole("button", { name: "放大代表图：主视图" });
    expect(within(thumbnail).getByAltText("代表图缩略图")).toBeDefined();
    expect(screen.queryByRole("button", { name: "更换代表图" })).toBeNull();
    expect(screen.queryByText(/必填项与条件必填项已标注/)).toBeNull();
    await user.click(thumbnail);
    const dialog = screen.getByRole("dialog", { name: "主视图大图预览" });
    expect(within(dialog).getByRole("button", { name: "适合窗口" })).toBeDefined();
    expect(within(dialog).getByAltText("主视图大图").getAttribute("src")).toBe(
      within(thumbnail).getByAltText("代表图缩略图").getAttribute("src"),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "主视图大图预览" })).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("产品用途（必填）"), "坐");
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ brief: expect.objectContaining({ productUse: "坐" }) }),
      patent.assets,
    );
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("only offers omission questions for orthographic views that are not uploaded", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "省略测试" });
  if (!patent.designPatent) throw new Error("fixture");
  patent.designPatent.views = [
    {
      viewId: crypto.randomUUID(),
      kind: "front",
      label: "主视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      assignmentStatus: "confirmed",
      assignmentEvidence: null,
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
  render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);
  await user.click(workflowTab(/简要说明/u));
  expect(screen.queryByLabelText("省略主视图")).toBeNull();
  expect(screen.getByLabelText("省略后视图")).toBeDefined();
});

test("excludes unassigned images from the export materials", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "导出清单" });
  if (!patent.designPatent) throw new Error("fixture");
  patent.designPatent.views = [
    {
      viewId: crypto.randomUUID(),
      kind: "unassigned",
      label: "待确认.png",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      assignmentStatus: "confirmed",
      assignmentEvidence: null,
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
  render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);
  await user.click(workflowTab(/导出/u));
  expect(screen.getByText("不导出：暂存图片 1 张。")).toBeDefined();
  expect(screen.getByRole("button", { name: "选择位置并导出" })).not.toHaveProperty(
    "disabled",
    true,
  );
});

test("analyzes imported subjects and retains duplicate views without duplicating case assets", async () => {
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
          value: [
            { descriptor, preview: Uint8Array.from([1]) },
            { descriptor, preview: Uint8Array.from([1]) },
          ],
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
    expect(onUpdate.mock.calls[0]?.[0].views).toHaveLength(2);
    expect(onUpdate.mock.calls[0]?.[1]).toEqual([descriptor]);
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

test("persists unique filename suggestions in matching slots while conflicts stay unassigned", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const descriptor = (originalName: string) => ({
    assetId: crypto.randomUUID(),
    kind: "image" as const,
    originalName,
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 100,
    heightPx: 200,
    previewByteLength: 8,
    previewSha256: "B".repeat(64),
  });
  const assets = [
    descriptor("产品_左视图.png"),
    descriptor("chair.png"),
    descriptor("立体图2.png"),
    descriptor("产品_左视图_副本.png"),
  ];
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        chooseAndImportMany: vi.fn(async () => ({
          ok: true as const,
          value: assets.map((item) => ({ descriptor: item, preview: Uint8Array.from([1]) })),
        })),
        processDesignImage: vi.fn(async () => ({
          ok: true as const,
          value: {
            bytes: Uint8Array.from([1]),
            widthPx: 100,
            heightPx: 200,
            subjectBounds: { leftPx: 10, topPx: 10, widthPx: 80, heightPx: 180 },
          },
        })),
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "导入图片" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(
      onUpdate.mock.calls[0]?.[0].views.map((view: { kind: string; assetId: string }) => [
        view.kind,
        view.assetId,
      ]),
    ).toEqual([
      ["left", assets[0]?.assetId],
      ["unassigned", assets[1]?.assetId],
      ["perspective-2", assets[2]?.assetId],
      ["unassigned", assets[3]?.assetId],
    ]);
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("does not create a view when imported image processing fails", async () => {
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
    originalName: "broken.png",
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 100,
    heightPx: 200,
    previewByteLength: 8,
    previewSha256: "B".repeat(64),
  };
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        chooseAndImportMany: vi.fn(async () => ({
          ok: true as const,
          value: [{ descriptor, preview: Uint8Array.from([1]) }],
        })),
        processDesignImage: vi.fn(async () => ({
          ok: false as const,
          error: { code: "INVALID_INPUT" as const, message: "图片无法处理" },
        })),
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "导入图片" }));

    const outcomes = await screen.findByRole("status", { name: "导入结果" });
    expect(outcomes.textContent).toContain("broken.png");
    expect(outcomes.textContent).toContain("图片无法处理");
    expect(onUpdate).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("clears previous import outcomes when the next picker is cancelled and blocks a concurrent batch", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  let chooseCount = 0;
  let resolveFirst: ((value: Awaited<ReturnType<typeof Promise.resolve>>) => void) | undefined;
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        chooseAndImportMany: vi.fn(() =>
          ++chooseCount === 1
            ? new Promise((resolve) => {
                resolveFirst = resolve;
              })
            : Promise.resolve({ ok: true, value: [] }),
        ),
      },
    },
  });
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "导入图片" }));
    await user.click(screen.getByRole("button", { name: "正在导入…" }));
    expect(chooseCount).toBe(1);
    resolveFirst?.({ ok: true, value: [] });
    await screen.findByRole("button", { name: "导入图片" });
    await user.click(screen.getByRole("button", { name: "导入图片" }));
    expect(chooseCount).toBe(2);
    expect(screen.queryByRole("status", { name: "导入结果" })).toBeNull();
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("clears an earlier picker error when a later picker is cancelled", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const chooseAndImportMany = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: { code: "INVALID_INPUT", message: "旧的导入错误" } })
    .mockResolvedValueOnce({ ok: true, value: [] });
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { assets: { chooseAndImportMany } },
  });
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "导入图片" }));
    expect(await screen.findByText("旧的导入错误")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "导入图片" }));
    await waitFor(() => expect(screen.queryByText("旧的导入错误")).toBeNull());
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("keeps failed images out of the saved asset list when a batch partially succeeds", async () => {
  const user = userEvent.setup();
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const descriptor = (name: string) => ({
    assetId: crypto.randomUUID(),
    kind: "image" as const,
    originalName: name,
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 100,
    heightPx: 200,
    previewByteLength: 8,
    previewSha256: "B".repeat(64),
  });
  const valid = descriptor("valid.png");
  const failed = descriptor("failed.png");
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        chooseAndImportMany: vi.fn(async () => ({
          ok: true as const,
          value: [valid, failed].map((item) => ({
            descriptor: item,
            preview: Uint8Array.from([1]),
          })),
        })),
        processDesignImage: vi.fn(async ({ assetId }: { assetId: string }) =>
          assetId === valid.assetId
            ? {
                ok: true as const,
                value: {
                  bytes: Uint8Array.from([1]),
                  widthPx: 100,
                  heightPx: 200,
                  subjectBounds: { leftPx: 10, topPx: 10, widthPx: 80, heightPx: 180 },
                },
              }
            : {
                ok: false as const,
                error: { code: "INVALID_INPUT" as const, message: "图片无法处理" },
              },
        ),
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "导入图片" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(
      onUpdate.mock.calls[0]?.[0].views.map((view: { assetId: string }) => view.assetId),
    ).toEqual([valid.assetId]);
    expect(onUpdate.mock.calls[0]?.[1].map((asset: { assetId: string }) => asset.assetId)).toEqual([
      valid.assetId,
    ]);
    const outcomes = screen.getByRole("status", { name: "导入结果" });
    expect(outcomes.textContent).toContain("failed.png");
    expect(outcomes.textContent).toContain("图片无法处理");
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
      views: [expect.objectContaining({ assetId: descriptor.assetId, kind: "front" })],
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

test("keeps image processing controls in the dedicated correction step", async () => {
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
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);

    const assignmentWorkspace = screen.getByRole("region", { name: "图片整理工作区" });
    expect(
      within(assignmentWorkspace).queryByRole("complementary", { name: "校正控制" }),
    ).toBeNull();

    await user.click(workflowTab(/小栈修图/u));

    expect(screen.getByRole("complementary", { name: "校正控制" })).toBeDefined();
    expect(screen.getByRole("button", { name: "向左旋转 90°" })).toBeDefined();
    expect(screen.getByRole("button", { name: "向右旋转 90°" })).toBeDefined();
    expect(screen.getByRole("button", { name: "应用当前裁剪框" })).toBeDefined();
    expect(screen.getByRole("button", { name: "统一到此尺寸" })).toBeDefined();
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("preserves a concurrent brief edit when a correction draft is applied", async () => {
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
      subjectBoundsSource: "automatic",
      subjectBoundsConfirmed: false,
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
  const processDesignImage = vi.fn(async () => ({
    ok: true as const,
    value: {
      bytes: Uint8Array.from([1]),
      widthPx: 200,
      heightPx: 100,
      subjectBounds: { leftPx: 5, topPx: 5, widthPx: 160, heightPx: 80 },
    },
  }));
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview: vi.fn(async () => ({ ok: true as const, value: Uint8Array.from([1]) })),
        processDesignImage,
      },
    },
  });
  const onUpdate = vi.fn();
  try {
    const rendered = render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    await user.click(workflowTab(/小栈修图/u));
    await user.click(screen.getByRole("button", { name: "向右旋转 90°" }));

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
    await user.click(screen.getByRole("button", { name: "应用修改" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      brief: { productUse: "并发填写的新用途" },
      views: [expect.objectContaining({ operations: [{ kind: "rotate", degrees: 90 }] })],
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("keeps unplaced supplemental views in holding without exposing them to correction", async () => {
  const user = userEvent.setup();
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
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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

    const holdingArea = screen.getByRole("region", { name: "图片暂存区" });
    expect(within(holdingArea).getAllByText(/使用状态参考图/u).length).toBeGreaterThan(0);
    expect(screen.queryByText("补充视图")).toBeNull();
    await user.click(workflowTab(/小栈修图/u));
    expect(screen.queryByRole("button", { name: /使用状态参考图\s*（当前）/u })).toBeNull();
    expect(screen.getByText("暂无已分配图片，请先在图片整理中设置视图。")).toBeDefined();
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
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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
    await user.click(screen.getByRole("button", { name: "删除主视图" }));
    const canceledDialog = screen.getByRole("dialog", { name: "请确认" });
    expect(within(canceledDialog).getByText(/代表图和尺寸比例参考/u)).toBeTruthy();
    await user.click(within(canceledDialog).getByRole("button", { name: "取消" }));
    expect(onUpdate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "删除主视图" }));
    const confirmedDialog = screen.getByRole("dialog", { name: "请确认" });
    await user.click(within(confirmedDialog).getByRole("button", { name: "确定" }));

    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      views: [],
      representativeViewId: null,
      dimensionReferenceViewId: null,
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("moves an assigned image by dragging it to another occupied view", () => {
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
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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
    const frontId = patent.designPatent.views[0]!.viewId;
    const transfer = {
      getData: vi.fn(() => frontId),
      setData: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };
    fireEvent.drop(screen.getByRole("article", { name: "后视图：后视图" }), {
      dataTransfer: transfer,
    });

    expect(onUpdate.mock.calls[0]?.[0].views.map((view: { kind: string }) => view.kind)).toEqual([
      "rear",
      "front",
    ]);
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("confirms only the pending automatic assignment selected on the view card", async () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  const frontId = crypto.randomUUID();
  const leftId = crypto.randomUUID();
  patent.designPatent.views = [
    {
      viewId: frontId,
      kind: "front",
      label: "主视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      assignmentStatus: "pending-auto",
      assignmentEvidence: "文件名包含“主视图”",
      operations: [],
      note: null,
    },
    {
      viewId: leftId,
      kind: "left",
      label: "左视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      assignmentStatus: "pending-auto",
      assignmentEvidence: "文件名包含“左视图”",
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
    fireEvent.click(screen.getByRole("button", { name: "确认主视图自动匹配" }));

    const views = onUpdate.mock.calls[0]?.[0].views;
    expect(views.find((view: { viewId: string }) => view.viewId === frontId)).toMatchObject({
      kind: "front",
      assignmentStatus: "confirmed",
      assignmentEvidence: null,
    });
    expect(views.find((view: { viewId: string }) => view.viewId === leftId)).toMatchObject({
      kind: "left",
      assignmentStatus: "pending-auto",
      assignmentEvidence: "文件名包含“左视图”",
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("does not offer a redundant confirmation action for an already confirmed target", () => {
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
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      assignmentStatus: "confirmed",
      assignmentEvidence: null,
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
    expect(screen.queryByRole("button", { name: "确认主视图自动匹配" })).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
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
  await user.click(workflowTab(/简要说明/u));
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
  await user.click(workflowTab(/简要说明/u));

  expect(screen.getByLabelText("局部设计保护部分及表示方式（条件必填）")).toBeDefined();
});

test("resets the workspace page when switching patents", async () => {
  const user = userEvent.setup();
  const patentA = createBlankPatent({ patentType: "design", name: "产品 A" });
  const patentB = createBlankPatent({ patentType: "design", name: "产品 B" });
  const sessionA = createPatentSession({
    patentId: patentA.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent: patentA,
    saveState: "saved",
  });
  const sessionB = createPatentSession({
    patentId: patentB.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent: patentB,
    saveState: "saved",
  });
  const rendered = render(
    <DesignPatentWorkbench key={sessionA.patentId} session={sessionA} onUpdate={vi.fn()} />,
  );
  await user.click(workflowTab(/导出/u));

  rendered.rerender(
    <DesignPatentWorkbench key={sessionB.patentId} session={sessionB} onUpdate={vi.fn()} />,
  );

  await waitFor(() => expect(workflowTab(/图片整理/u).getAttribute("aria-selected")).toBe("true"));
  await user.click(workflowTab(/导出/u));
  expect(screen.getByRole("button", { name: "选择位置并导出" })).toHaveProperty("disabled", false);
});

test("does not export a revision different from the visible materials", async () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
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
      exports: {
        chooseDesignPatentDestination: async () => ({ ok: true, value: crypto.randomUUID() }),
      },
    },
  });
  try {
    render(
      <DesignPatentWorkbench
        session={session}
        onUpdate={vi.fn()}
        onPrepareExport={async () => ({ previewRevision: 1, revision: 1 })}
      />,
    );
    const user = userEvent.setup();
    await user.click(workflowTab(/导出/u));
    await user.click(screen.getByRole("button", { name: "选择位置并导出" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "材料已更新，请确认当前预览后重试。",
    );
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("cancelling the directory picker does not prepare, apply or export images", async () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });
  const prepare = vi.fn(),
    designPatent = vi.fn();
  const chooseDesignPatentDestination = vi.fn(async () => ({ ok: true, value: null }));
  const previousApi = window.patentApi;
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      exports: { chooseDesignPatentDestination, designPatent },
    },
  });
  try {
    render(
      <DesignPatentWorkbench session={session} onUpdate={vi.fn()} onPrepareExport={prepare} />,
    );
    await userEvent.click(workflowTab(/导出/u));
    const button = screen.getByRole("button", { name: "选择位置并导出" });
    await userEvent.click(button);
    expect(chooseDesignPatentDestination).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(designPatent).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("uses one board for three perspective and six orthographic slots", () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  const session = createPatentSession({
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    patent,
    saveState: "saved",
  });

  render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);

  const board = screen.getByRole("region", { name: "视图板" });
  for (const label of [
    "立体图1",
    "立体图2",
    "立体图3",
    "主视图",
    "后视图",
    "左视图",
    "右视图",
    "俯视图",
    "仰视图",
  ]) {
    expect(within(board).getByRole("article", { name: `${label}：待分配` })).toBeDefined();
  }
  // Empty slots have no image actions; the separate model has its own controls.
  for (const slot of within(board).getAllByRole("article")) {
    expect(within(slot).queryAllByRole("button", { name: /查看.*大图|删除/ })).toHaveLength(0);
  }
  const inspector = screen.getByRole("region", { name: "视图核对" });
  expect(within(inspector).getByRole("region", { name: "六视图尺寸预览" })).toBeDefined();
  expect(screen.queryByRole("region", { name: "立体图" })).toBeNull();
  expect(screen.queryByRole("region", { name: "正投影视图" })).toBeNull();
});

test("shows three perspective slots and persists unassigned images in a holding area", () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  const assetId = crypto.randomUUID();
  patent.assets = [
    {
      assetId,
      kind: "image",
      originalName: "chair.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 10,
      sha256: "A".repeat(64),
      widthPx: 100,
      heightPx: 200,
      previewByteLength: 8,
      previewSha256: "B".repeat(64),
    },
  ];
  patent.designPatent.views = [
    {
      viewId: crypto.randomUUID(),
      kind: "unassigned",
      label: "chair.png",
      assetId,
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={vi.fn()} />);

    const board = screen.getByRole("region", { name: "视图板" });
    for (const label of ["立体图1", "立体图2", "立体图3"]) {
      expect(within(board).getByRole("article", { name: `${label}：待分配` })).toBeDefined();
    }
    expect(screen.getByRole("region", { name: "图片暂存区" }).textContent).toContain("chair.png");
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("swaps a held image with an occupied slot through drag and drop", () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  const frontViewId = crypto.randomUUID();
  const heldViewId = crypto.randomUUID();
  patent.designPatent.views = [
    {
      viewId: frontViewId,
      kind: "front",
      label: "主视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      operations: [],
      note: null,
    },
    {
      viewId: heldViewId,
      kind: "unassigned",
      label: "待分配.png",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      operations: [],
      note: null,
    },
  ];
  patent.designPatent.representativeViewId = frontViewId;
  patent.designPatent.dimensionReferenceViewId = frontViewId;
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
  const dataTransfer = {
    effectAllowed: "move",
    dropEffect: "move",
    setData: vi.fn(),
    getData: vi.fn(() => heldViewId),
  };
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    const heldImage = screen.getByRole("group", { name: "暂存图片：待分配.png" });
    const frontSlot = screen.getByRole("article", { name: "主视图：主视图" });

    fireEvent.dragStart(heldImage, { dataTransfer });
    fireEvent.drop(frontSlot, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith("application/x-design-view-id", heldViewId);
    expect(onUpdate).toHaveBeenCalledOnce();
    const updatedViews = onUpdate.mock.calls[0]?.[0].views;
    expect(updatedViews.find((view: { viewId: string }) => view.viewId === heldViewId)?.kind).toBe(
      "front",
    );
    expect(updatedViews.find((view: { viewId: string }) => view.viewId === frontViewId)?.kind).toBe(
      "unassigned",
    );
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      representativeViewId: null,
      dimensionReferenceViewId: null,
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});

test("moves an internal image to holding even when native drag also includes a file", () => {
  const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
  if (!patent.designPatent) throw new Error("fixture");
  const frontViewId = crypto.randomUUID();
  patent.designPatent.views = [
    {
      viewId: frontViewId,
      kind: "front",
      label: "主视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
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
  const dataTransfer = {
    effectAllowed: "move",
    dropEffect: "move",
    types: ["application/x-design-view-id", "Files"],
    files: [new File(["native image drag"], "native.png", { type: "image/png" })],
    setData: vi.fn(),
    getData: vi.fn(() => frontViewId),
  };
  try {
    render(<DesignPatentWorkbench session={session} onUpdate={onUpdate} />);
    const frontSlot = screen.getByRole("article", { name: "主视图：主视图" });
    const holdingArea = screen.getByRole("region", { name: "图片暂存区" });

    fireEvent.dragStart(frontSlot, { dataTransfer });
    fireEvent.dragOver(holdingArea, { dataTransfer });
    fireEvent.drop(holdingArea, { dataTransfer });

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]?.[0].views[0]).toMatchObject({
      viewId: frontViewId,
      kind: "unassigned",
    });
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: previousApi });
  }
});
