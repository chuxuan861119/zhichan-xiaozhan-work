import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PatentApi } from "../../../shared/ipc/contract";
import type {
  PatentTemplateAuxiliaryCatalog,
  PatentTemplateCatalog,
  PatentTemplateEditorSnapshot,
  PatentTemplateLauncherSummary,
} from "../../../shared/patent/template-catalog";
import { createFactoryPatentTemplates } from "../../../shared/patent/templates";
import { ApplicationCloseProvider } from "../app/application-close-coordinator";
import * as appDialogs from "../shared/app-dialog";
import { PatentTemplateCatalogSettings } from "./patent-template-catalog-settings";

function id(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function snapshot(): PatentTemplateEditorSnapshot {
  const factory = createFactoryPatentTemplates(() => id(900));
  const at = "2026-08-28T00:00:00.000Z";
  const slots = (patentType: "invention" | "utility-model") =>
    ([1, 2, 3, 4, 5] as const).map((slotIndex) => ({
      templateId: id((patentType === "invention" ? 100 : 200) + slotIndex),
      patentType,
      slotIndex,
      name: `自定义模板 ${slotIndex}`,
      claims: null,
      description: null,
      abstract: null,
      unavailableReason: null,
      revision: 0,
      createdAt: at,
      updatedAt: at,
    }));
  const catalog: PatentTemplateCatalog = {
    revision: 0,
    invention: { selection: { kind: "system" }, slots: slots("invention") },
    "utility-model": { selection: { kind: "system" }, slots: slots("utility-model") },
  };
  const auxiliary: PatentTemplateAuxiliaryCatalog = {
    invention: {
      patentType: "invention",
      figureExplanation: factory.invention.figureExplanation,
      drawingLegend: factory.invention.drawingLegend,
      updatedAt: at,
    },
    "utility-model": {
      patentType: "utility-model",
      figureExplanation: factory["utility-model"].figureExplanation,
      drawingLegend: factory["utility-model"].drawingLegend,
      updatedAt: at,
    },
  };
  return { sessionId: id(300), catalog, auxiliary };
}

function launcherSummary(catalog: PatentTemplateCatalog): PatentTemplateLauncherSummary {
  return {
    ...(catalog.separatePatentTypes !== undefined
      ? { separatePatentTypes: catalog.separatePatentTypes }
      : {}),
    invention: { selection: catalog.invention.selection, selectedTemplateName: null },
    "utility-model": {
      selection: catalog["utility-model"].selection,
      selectedTemplateName: null,
    },
  };
}

test.each([false, true])(
  "saving and reopening starts a fresh template session (reduced motion: %s)",
  async (reduced) => {
    document.documentElement.dataset.reducedMotion = String(reduced);
    const active = new Set<string>();
    let stored = snapshot();
    let sequence = 300;
    const saveEditor = vi.fn(
      async (request: Parameters<PatentApi["patentTemplates"]["saveEditor"]>[0]) => {
        if (!active.has(request.sessionId))
          return { ok: false, error: { code: "CANCELLED", message: "操作已取消。" } };
        stored = { ...stored, catalog: request.catalog, auxiliary: request.auxiliary };
        return { ok: true, value: { ...stored, sessionId: request.sessionId } };
      },
    );
    window.patentApi = {
      application: { onPrepareClose: vi.fn(() => () => undefined) },
      patentTemplates: {
        readSummary: async () => ({ ok: true, value: launcherSummary(stored.catalog) }),
        openEditor: async () => {
          const sessionId = id(++sequence);
          active.add(sessionId);
          return { ok: true, value: { ...stored, sessionId } };
        },
        saveEditor,
        closeEditor: async ({ sessionId }: { sessionId: string }) => {
          active.delete(sessionId);
          return { ok: true, value: undefined };
        },
      },
    } as unknown as PatentApi;
    const view = render(
      <ApplicationCloseProvider>
        <PatentTemplateCatalogSettings />
      </ApplicationCloseProvider>,
    );
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "打开默认模板设置" }));
        });
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
        });
        expect(screen.queryByRole("dialog", { name: "默认模板设置" })).toBeNull();
        expect(Boolean(view.container.querySelector('[data-motion-state="closing"]'))).toBe(
          !reduced,
        );
      }
      expect(saveEditor).toHaveBeenCalledTimes(2);
      expect(saveEditor.mock.calls[0]?.[0].sessionId).not.toBe(
        saveEditor.mock.calls[1]?.[0].sessionId,
      );
      expect(active.size).toBe(0);
    } finally {
      view.unmount();
      delete document.documentElement.dataset.reducedMotion;
    }
  },
);

test("shares one template by default and preserves separate templates while toggling and saving", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(true);
  const opened = snapshot();
  opened.catalog.separatePatentTypes = false;
  const utilitySlot = opened.catalog["utility-model"].slots[0];
  if (!utilitySlot) throw new Error("missing slot");
  utilitySlot.name = "保留的实用新型模板";
  const utilityFactory = createFactoryPatentTemplates(() => id(951))["utility-model"];
  utilitySlot.claims = utilityFactory.claims;
  utilitySlot.description = utilityFactory.description;
  utilitySlot.abstract = utilityFactory.abstract;
  const saveEditor = vi.fn(
    async (request: Parameters<PatentApi["patentTemplates"]["saveEditor"]>[0]) => ({
      ok: true as const,
      value: {
        sessionId: request.sessionId,
        catalog: request.catalog,
        auxiliary: request.auxiliary,
      },
    }),
  );
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      saveEditor,
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "打开默认模板设置" }));
  const toggle = await screen.findByRole("switch", { name: "发明与实用新型分别设置" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByRole("tablist", { name: "专利类型" })).toBeNull();
  await user.click(screen.getByText("发明与实用新型分别设置"));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await user.click(toggle);
  expect(screen.getByRole("tablist", { name: "专利类型" })).toBeDefined();
  await user.click(screen.getByRole("tab", { name: "实用新型" }));
  expect(screen.getAllByText("保留的实用新型模板").length).toBeGreaterThan(0);
  confirm.mockResolvedValueOnce(false);
  await user.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await user.click(toggle);
  expect(screen.queryByRole("tablist", { name: "专利类型" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(saveEditor).toHaveBeenCalledTimes(1));
  const saved = saveEditor.mock.calls[0]?.[0].catalog;
  expect(saved?.separatePatentTypes).toBe(false);
  expect(saved?.["utility-model"].slots[0]?.name).toBe("保留的实用新型模板");
});

test("template views animate their changing content and respect reduced motion", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  const original = HTMLElement.prototype.animate;
  const animated: HTMLElement[] = [];
  HTMLElement.prototype.animate = function () {
    animated.push(this);
    return { cancel: vi.fn() } as unknown as Animation;
  };
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  const rendered = render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );
  try {
    await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
    await screen.findByRole("textbox", { name: "编辑 权利要求书" });
    const switchAndCheck = async (name: string, className: string) => {
      animated.length = 0;
      await user.click(screen.getByRole("tab", { name }));
      expect(animated.some((element) => element.classList.contains(className))).toBe(true);
      expect(
        animated.some((element) => element.classList.contains("template-catalog-dialog__editor")),
      ).toBe(false);
    };
    await switchAndCheck("说明书", "template-view-transition__content");
    await switchAndCheck("说明书摘要", "template-view-transition__content");
    await switchAndCheck("实用新型", "template-catalog-dialog__sources");
    animated.length = 0;
    await user.click(screen.getByRole("button", { name: "空白模板" }));
    expect(
      animated.some((element) => element.classList.contains("template-view-transition__content")),
    ).toBe(true);
    document.documentElement.dataset.reducedMotion = "true";
    animated.length = 0;
    await user.click(screen.getByRole("button", { name: /^系统默认模板/u }));
    expect(animated).toHaveLength(0);
  } finally {
    rendered.unmount();
    HTMLElement.prototype.animate = original;
    delete document.documentElement.dataset.reducedMotion;
  }
});

test("keeps the default template editor in a standalone dialog opened from its settings page", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent: vi.fn(),
      saveEditor: vi.fn(),
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;

  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );

  const launcher = await screen.findByRole("region", { name: "默认模板" });
  const openButton = within(launcher).getByRole("button", { name: "打开默认模板设置" });
  expect(within(launcher).queryByRole("tablist", { name: "专利类型" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "默认模板设置" })).toBeNull();

  await user.click(openButton);

  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  expect(within(dialog).getByRole("tablist", { name: "专利类型" })).toBeDefined();
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.classList.contains("standard-dialog")).toBe(true);
  expect(dialog.classList.contains("standard-dialog--xl")).toBe(true);
  expect(dialog.classList.contains("template-catalog-dialog--embedded")).toBe(false);
  expect(within(dialog).queryByText("自定义模板 1")).toBeNull();
  for (const index of [1, 2, 3, 4, 5]) {
    await user.click(within(dialog).getByRole("button", { name: "新建自定义模板" }));
    const editor = within(dialog).getByRole("textbox", { name: "编辑 权利要求书" });
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(editor.textContent?.trim()).toBe("");
    expect(within(dialog).getByRole("heading", { name: `自定义模板 ${index}` })).toBeDefined();
  }
  expect(within(dialog).queryByRole("button", { name: "新建自定义模板" })).toBeNull();
});

test("fills a custom slot from the current three books, warns about omitted images, and saves it", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(true);
  const opened = snapshot();
  const factory = createFactoryPatentTemplates(() => id(950));
  const captureCurrent = vi.fn(async () => ({
    ok: true as const,
    value: {
      templateId: opened.catalog.invention.slots[0]?.templateId ?? id(101),
      patentType: "invention" as const,
      claims: factory.invention.claims,
      description: factory.invention.description,
      abstract: factory.invention.abstract,
      omittedOrdinaryImageCount: 2,
      referencedChemicalPreviewAssetIds: [],
    },
  }));
  const saveEditor = vi.fn(
    async (request: Parameters<PatentApi["patentTemplates"]["saveEditor"]>[0]) => ({
      ok: true as const,
      value: {
        sessionId: request.sessionId,
        catalog: request.catalog,
        auxiliary: request.auxiliary,
      },
    }),
  );
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent,
      saveEditor,
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings
        prepareCurrentPatent={vi.fn(async () => ({ patentId: id(400), expectedRevision: 7 }))}
      />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  await user.click(within(dialog).getByRole("button", { name: "新建自定义模板" }));
  const firstCard = within(dialog).getAllByText("自定义模板 1")[0]?.closest("article");
  expect(firstCard).toBeTruthy();
  await user.click(
    within(firstCard as HTMLElement).getByRole("button", { name: "自定义模板 1更多操作" }),
  );
  await user.click(
    within(firstCard as HTMLElement).getByRole("menuitem", { name: "填入当前文档内容" }),
  );

  expect(within(dialog).queryByRole("status")).toBeNull();
  expect(captureCurrent).toHaveBeenCalledWith(
    expect.objectContaining({
      patentId: id(400),
      expectedPatentRevision: 7,
      targetPatentType: "invention",
    }),
  );
  await user.click(within(firstCard as HTMLElement).getByRole("button", { name: "设为当前模板" }));
  await user.click(within(dialog).getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(saveEditor).toHaveBeenCalledOnce());
  expect(saveEditor.mock.calls[0]?.[0].catalog.invention.selection).toEqual({
    kind: "custom",
    templateId: opened.catalog.invention.slots[0]?.templateId,
  });
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("2 张普通图片"));
  confirm.mockRestore();
});

test("keeps an existing template unchanged when the ordinary-image warning is cancelled", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  const target = opened.catalog.invention.slots[0];
  if (!target) throw new Error("template slot fixture missing");
  const factory = createFactoryPatentTemplates(() => id(960));
  const captureCurrent = vi.fn(async () => ({
    ok: true as const,
    value: {
      templateId: target.templateId,
      patentType: "invention" as const,
      claims: factory.invention.claims,
      description: factory.invention.description,
      abstract: factory.invention.abstract,
      omittedOrdinaryImageCount: 1,
      referencedChemicalPreviewAssetIds: [],
    },
  }));
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent,
      saveEditor: vi.fn(),
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  const confirm = vi
    .spyOn(appDialogs, "confirmAppAction")
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings
        prepareCurrentPatent={vi.fn(async () => ({ patentId: id(401), expectedRevision: 8 }))}
      />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  await user.click(within(dialog).getByRole("button", { name: "新建自定义模板" }));
  const firstCard = within(dialog).getAllByText("自定义模板 1")[0]?.closest("article");
  await user.click(
    within(firstCard as HTMLElement).getByRole("button", { name: "自定义模板 1更多操作" }),
  );
  await user.click(
    within(firstCard as HTMLElement).getByRole("menuitem", { name: "填入当前文档内容" }),
  );

  expect(captureCurrent).toHaveBeenCalledOnce();
  await user.click(within(firstCard as HTMLElement).getByRole("button", { name: "自定义模板 1" }));
  expect(within(dialog).getByRole("textbox", { name: "编辑 权利要求书" }).textContent?.trim()).toBe(
    "",
  );
  expect(within(dialog).queryByText(/已填入当前三书内容/)).toBeNull();
  confirm.mockRestore();
});

test("keeps the system template read-only and exposes all three custom slot actions", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent: vi.fn(),
      saveEditor: vi.fn(),
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  expect(within(dialog).queryByText("只读预览")).toBeNull();
  for (const _index of [1, 2, 3]) {
    await user.click(within(dialog).getByRole("button", { name: "新建自定义模板" }));
  }
  const menuTriggers = within(dialog).getAllByRole("button", { name: /更多操作/ });
  expect(menuTriggers).toHaveLength(3);
  await user.click(menuTriggers[0] as HTMLElement);
  const menu = within(dialog).getByRole("menu", { name: "自定义模板 1操作" });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["填入当前文档内容", "重命名", "删除"]);
  expect(within(dialog).getByLabelText("模板格式工具栏")).toBeDefined();
  const confirm = vi
    .spyOn(appDialogs, "confirmAppAction")
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  await user.click(within(menu).getByRole("menuitem", { name: "删除" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("自定义模板 1"));
  expect(within(dialog).getAllByRole("button", { name: /更多操作/ })).toHaveLength(3);
  await user.click(menuTriggers[0] as HTMLElement);
  await user.click(within(dialog).getByRole("menuitem", { name: "删除" }));
  await waitFor(() =>
    expect(within(dialog).getAllByRole("button", { name: /更多操作/ })).toHaveLength(2),
  );
  expect(within(dialog).queryByRole("button", { name: "自定义模板 1更多操作" })).toBeNull();
  confirm.mockRestore();
});

test("shows the active template as a status instead of a disabled action", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent: vi.fn(),
      saveEditor: vi.fn(),
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  const systemCard = within(dialog).getByText("系统默认模板").closest("article");
  expect(systemCard).toBeTruthy();
  const currentStatus = within(systemCard as HTMLElement).getByText("当前使用");
  expect(currentStatus.tagName).toBe("SPAN");
  expect(within(systemCard as HTMLElement).queryByRole("button", { name: "当前使用" })).toBeNull();
  expect(
    within(systemCard as HTMLElement).queryByRole("button", { name: "设为当前模板" }),
  ).toBeNull();
});

test("does not crowd an empty custom template card with an unavailable activation action", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent: vi.fn(),
      saveEditor: vi.fn(),
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  expect(within(dialog).queryByText("自定义模板 1")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "新建自定义模板" })).toBeDefined();
});

test("collects the three custom template editing actions in an overflow menu", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent: vi.fn(),
      saveEditor: vi.fn(),
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings
        prepareCurrentPatent={vi.fn(async () => ({ patentId: id(402), expectedRevision: 9 }))}
      />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  await user.click(within(dialog).getByRole("button", { name: "新建自定义模板" }));
  const firstCard = within(dialog).getAllByText("自定义模板 1")[0]?.closest("article");
  expect(firstCard).toBeTruthy();
  expect(
    within(firstCard as HTMLElement).queryByRole("button", { name: "填入当前文档内容" }),
  ).toBeNull();
  expect(within(firstCard as HTMLElement).queryByRole("button", { name: "重命名" })).toBeNull();
  expect(within(firstCard as HTMLElement).queryByRole("button", { name: "删除" })).toBeNull();

  await user.click(
    within(firstCard as HTMLElement).getByRole("button", { name: "自定义模板 1更多操作" }),
  );
  const menu = within(firstCard as HTMLElement).getByRole("menu", { name: "自定义模板 1操作" });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["填入当前文档内容", "重命名", "删除"]);
});

test("previewing another template does not create an unsaved change", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  let prepareClose: ((token: string) => void) | undefined;
  const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const closeEditor = vi.fn(async () => ({ ok: true as const, value: undefined }));
  window.patentApi = {
    application: {
      onPrepareClose: vi.fn((listener: (token: string) => void) => {
        prepareClose = listener;
        return () => undefined;
      }),
      closeResult,
    },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent: vi.fn(),
      saveEditor: vi.fn(),
      closeEditor,
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  await user.click(within(dialog).getByRole("button", { name: /空白模板/ }));
  await waitFor(() => expect(prepareClose).toBeDefined());
  await act(async () => prepareClose?.("close-1"));
  await waitFor(() =>
    expect(closeResult).toHaveBeenCalledWith({ token: "close-1", proceed: true }),
  );
  expect(closeEditor).toHaveBeenCalledWith({ sessionId: opened.sessionId });
});

test("offers continue editing, discard, and save-and-exit for unsaved changes", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  let prepareClose: ((token: string) => void) | undefined;
  const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const closeEditor = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const saveEditor = vi.fn(
    async (request: Parameters<PatentApi["patentTemplates"]["saveEditor"]>[0]) => ({
      ok: true as const,
      value: {
        sessionId: request.sessionId,
        catalog: request.catalog,
        auxiliary: request.auxiliary,
      },
    }),
  );
  window.patentApi = {
    application: {
      onPrepareClose: vi.fn((listener: (token: string) => void) => {
        prepareClose = listener;
        return () => undefined;
      }),
      closeResult,
    },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent: vi.fn(),
      saveEditor,
      closeEditor,
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  await user.click(within(dialog).getByRole("button", { name: "新建自定义模板" }));
  await user.click(within(dialog).getByRole("button", { name: "自定义模板 1更多操作" }));
  await user.click(within(dialog).getByRole("menuitem", { name: "重命名" }));
  const name = within(dialog).getByRole("textbox", { name: "重命名自定义模板 1" });
  await user.clear(name);
  await user.type(name, "常用模板");
  await user.click(within(dialog).getByRole("button", { name: "确认" }));
  await waitFor(() => expect(prepareClose).toBeDefined());

  await act(async () => prepareClose?.("close-1"));
  const exitDialog = await screen.findByRole("alertdialog");
  await user.click(within(exitDialog).getByRole("button", { name: "继续编辑" }));
  await waitFor(() =>
    expect(closeResult).toHaveBeenCalledWith({ token: "close-1", proceed: false }),
  );
  expect(closeEditor).not.toHaveBeenCalled();

  await act(async () => prepareClose?.("close-2"));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "保存并退出",
    }),
  );
  await waitFor(() =>
    expect(closeResult).toHaveBeenCalledWith({ token: "close-2", proceed: true }),
  );
  expect(saveEditor).toHaveBeenCalledOnce();
  expect(closeEditor).toHaveBeenCalledWith({ sessionId: opened.sessionId });
});

test("hides obsolete automatic drawing-text defaults and preserves their stored values", async () => {
  const user = userEvent.setup();
  const opened = snapshot();
  const saveEditor = vi.fn(
    async (request: Parameters<PatentApi["patentTemplates"]["saveEditor"]>[0]) => ({
      ok: true as const,
      value: {
        sessionId: request.sessionId,
        catalog: request.catalog,
        auxiliary: request.auxiliary,
      },
    }),
  );
  window.patentApi = {
    application: { onPrepareClose: vi.fn(() => () => undefined) },
    patentTemplates: {
      readSummary: vi.fn(async () => ({ ok: true, value: launcherSummary(opened.catalog) })),
      openEditor: vi.fn(async () => ({ ok: true, value: opened })),
      captureCurrent: vi.fn(),
      saveEditor,
      closeEditor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <PatentTemplateCatalogSettings />
    </ApplicationCloseProvider>,
  );

  await user.click(screen.getByRole("button", { name: "打开默认模板设置" }));
  const dialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  expect(within(dialog).queryByRole("button", { name: /附图辅助文字/ })).toBeNull();
  expect(within(dialog).queryByLabelText("附图说明默认文字")).toBeNull();
  expect(within(dialog).queryByLabelText("附图标记默认文字")).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "保存设置" }));

  await waitFor(() => expect(saveEditor).toHaveBeenCalledOnce());
  expect(saveEditor.mock.calls[0]?.[0].auxiliary).toEqual(opened.auxiliary);
});
