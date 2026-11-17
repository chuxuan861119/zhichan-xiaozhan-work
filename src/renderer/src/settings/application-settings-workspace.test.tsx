import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render as renderView, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createBlankBookDocument } from "../../../shared/document/defaults";
import type { PatentApi } from "../../../shared/ipc/contract";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { ApplicationCloseProvider } from "../app/application-close-coordinator";
import { ApplicationSettingsWorkspace } from "./application-settings-workspace";

const APPLICATION_STYLES = readFileSync(
  join(process.cwd(), "src/renderer/src/app/app.css"),
  "utf8",
);

function installPageMarginSettingsApi() {
  window.patentApi = {
    settings: {
      read: vi.fn(async () => ({ ok: true as const, value: DEFAULT_APP_SETTINGS })),
      update: vi.fn(async () => ({ ok: true as const, value: DEFAULT_APP_SETTINGS })),
    },
  } as unknown as PatentApi;
}

function render(ui: ReactNode) {
  const currentApi = window.patentApi as unknown as Record<string, unknown> | undefined;
  window.patentApi = {
    ...currentApi,
    application: currentApi?.application ?? {
      onPrepareClose: vi.fn(() => vi.fn()),
      closeResult: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
    patentTemplates: currentApi?.patentTemplates ?? {
      readSummary: vi.fn(async () => ({
        ok: true as const,
        value: {
          invention: { selection: { kind: "system" as const }, selectedTemplateName: null },
          "utility-model": {
            selection: { kind: "system" as const },
            selectedTemplateName: null,
          },
        },
      })),
      openEditor: vi.fn(() => new Promise(() => undefined)),
      closeEditor: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
  } as unknown as PatentApi;
  return renderView(<ApplicationCloseProvider>{ui}</ApplicationCloseProvider>);
}

function renderWorkspace() {
  render(workspaceElement());
}

function renderWorkspaceWithCloseCoordinator() {
  window.patentApi = {
    application: {
      onPrepareClose: vi.fn(() => vi.fn()),
      closeResult: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
  } as unknown as PatentApi;
  render(workspaceElement());
}

function workspaceElement() {
  return (
    <ApplicationSettingsWorkspace
      pageMarginContext={{
        hasEditableDocument: true,
        pageWidthMm: 210,
        pageHeightMm: 297,
        onSaved: vi.fn(),
      }}
    />
  );
}

function installAiCorrectionSettingsApi() {
  window.patentApi = {
    aiCorrection: {
      getSettings: vi.fn(async () => ({
        ok: true as const,
        value: {
          settings: {
            enabled: false,
            profiles: [],
            activeProfileId: null,
            timeoutMs: 30000,
            maxUploadCharacters: 10000,
          },
          credentialProfileIds: [],
        },
      })),
    },
  } as unknown as PatentApi;
}

describe("application settings workspace", () => {
  test.each(["openharmony", "ohos"])(
    "%s hides Agent CLI and rejects its initial route",
    (platform) => {
      vi.stubGlobal("documentFontPlatform", platform);
      try {
        render(<ApplicationSettingsWorkspace initialRoute="automation" />);
        expect(screen.queryByRole("button", { name: "Agent CLI（实验功能）" })).toBeNull();
        expect(screen.queryByRole("region", { name: "Agent CLI 设置" })).toBeNull();
        expect(screen.getByRole("region", { name: "默认模板" })).toBeDefined();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  test.each(["ai-models", "ai-model-editor"] as const)(
    "Harmony rejects %s deep links",
    (initialRoute) => {
      vi.stubGlobal("documentFontPlatform", "ohos");
      try {
        render(<ApplicationSettingsWorkspace initialRoute={initialRoute} />);
        expect(screen.queryByRole("button", { name: "AI 设置（实验功能）" })).toBeNull();
        expect(screen.getByRole("region", { name: "默认模板" })).toBeDefined();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  test.each(["win32", "darwin"])("%s retains the Agent CLI entry", (platform) => {
    vi.stubGlobal("documentFontPlatform", platform);
    try {
      renderWorkspace();
      expect(screen.getByRole("button", { name: "Agent CLI（实验功能）" })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test("shows all settings categories without a search box", () => {
    renderWorkspace();
    expect(screen.queryByRole("searchbox")).toBeNull();
    for (const label of ["AI 设置", "Agent CLI"]) {
      const entry = screen.getByRole("button", { name: `${label}（实验功能）` });
      expect(within(entry).getByText("实验功能")).toBeDefined();
    }
    const navigation = screen.getByRole("navigation", { name: "设置分类" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(12);
    expect(within(navigation).queryByRole("button", { name: /^AI 使用与隐私/ })).toBeNull();
    expect(screen.getByRole("region", { name: "默认模板" })).toBeDefined();
  });
  test("unifies connection control, models and the policy dialog without losing the route", async () => {
    const user = userEvent.setup();
    installAiCorrectionSettingsApi();
    const save = vi.fn(async () => true);
    render(
      <ApplicationSettingsWorkspace
        initialRoute="ai-models"
        preferences={{ ...DEFAULT_APP_SETTINGS, aiConnectionsEnabled: true }}
        onSavePreferences={save}
      />,
    );
    expect(screen.getByRole("heading", { name: /^AI 设置/ })).toBeDefined();
    await user.click(screen.getByRole("checkbox", { name: "允许连接 AI 服务" }));
    expect(save).toHaveBeenCalledWith({ aiConnectionsEnabled: false });
    expect(screen.queryByText(/AI功能由用户自行配置/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "AI 使用协议与隐私说明" }));
    const dialog = screen.getByRole("dialog", { name: "AI 使用协议与隐私说明" });
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "添加模型" }));
    expect(screen.queryByRole("checkbox", { name: "允许连接 AI 服务" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("checkbox", { name: "允许连接 AI 服务" })).toBeDefined();
    expect(screen.getByRole("button", { name: "AI 使用协议与隐私说明" })).toBeDefined();
  });
  test("starts at default templates with the available settings routes", () => {
    renderWorkspace();

    expect(screen.getAllByRole("heading", { name: "默认模板" })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "默认模板" })).toBeDefined();
    const navigation = screen.getByRole("navigation", { name: "设置分类" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(12);
    expect(within(navigation).getByRole("button", { name: "软件更新" })).toBeDefined();
    expect(within(navigation).queryByRole("button", { name: "使用统计" })).toBeNull();
    expect(within(navigation).getByRole("button", { name: "启动与关闭" })).toBeDefined();
    expect(
      within(navigation).getByRole("button", { name: /^AI 设置(?:（实验功能）|\s*实验功能)?$/ }),
    ).toBeDefined();
    expect(within(navigation).getByText("文档与写作")).toBeDefined();
    expect(within(navigation).getByText("界面与启动")).toBeDefined();
    expect(within(navigation).getByText("智能辅助")).toBeDefined();
    expect(within(navigation).getByText("数据与安全")).toBeDefined();
    expect(screen.getByRole("button", { name: "页边距" })).toBeDefined();
    expect(screen.getByRole("button", { name: "数据迁移" })).toBeDefined();
    expect(screen.getByRole("button", { name: "存储与备份" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "快照版本" })).toBeNull();
    expect(document.querySelector(".settings-workspace-content")?.className).toContain("content");
  });

  test("uses the approved content hierarchy for real settings pages", async () => {
    const user = userEvent.setup();
    render(
      <ApplicationSettingsWorkspace
        initialRoute="display"
        preferences={DEFAULT_APP_SETTINGS}
        onSavePreferences={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText("适合偏好较少动效的用户")).toBeDefined();
    expect(APPLICATION_STYLES).toContain(".settings-workspace-content__route--standard");
    expect(APPLICATION_STYLES).toContain(".settings-workspace-content .preference-card");
    expect(APPLICATION_STYLES).toMatch(
      /\.application-settings-dialog h3\.settings-workspace-content__title\s*\{[^}]*font-size:\s*22px;/s,
    );
    await user.click(screen.getByRole("button", { name: "启动与关闭" }));
    expect(screen.getByRole("heading", { name: "启动" })).toBeDefined();
  });

  test("opens editor assistance and forwards the reference-mark locator switch", async () => {
    const onReferenceMarkLocatorEnabledChange = vi.fn();
    render(
      <ApplicationSettingsWorkspace
        referenceMarkLocatorEnabled
        onReferenceMarkLocatorEnabledChange={onReferenceMarkLocatorEnabledChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "编辑辅助" }));
    const toggle = screen.getByRole("switch", { name: "零部件定位" });
    fireEvent.click(toggle);
    expect(onReferenceMarkLocatorEnabledChange).toHaveBeenCalledWith(false);
  });

  test("keeps dynamic-field buttons inside the editor and wraps whole buttons when needed", () => {
    renderWorkspace();

    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog__token-bar\s*\{[^}]*min-width:\s*0;[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog__token-bar button\s*\{[^}]*white-space:\s*nowrap;/s,
    );
  });

  test("marks one workspace content region as the scroll container while navigation stays separate", () => {
    renderWorkspace();

    expect(
      screen
        .getByTestId("settings-workspace-content")
        .classList.contains("settings-workspace-content"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("settings-workspace-navigation")
        .classList.contains("settings-workspace-navigation"),
    ).toBe(true);
  });

  test("keeps route content and explicit actions inside a fixed settings-page frame", () => {
    renderWorkspace();

    expect(APPLICATION_STYLES).toMatch(
      /\.settings-workspace-content\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.settings-workspace-content__route\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.settings-workspace-content__route\s*>\s*div:not\(\[hidden\]\)\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.shortcut-settings-dialog--embedded\s+\.shortcut-settings-dialog__surface\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.shortcut-settings-dialog--embedded\s+\.shortcut-settings-dialog__body\s*\{[^}]*overflow:\s*auto;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.page-margin-dialog--embedded\s+\.page-margin-dialog__actions\s*\{[^}]*margin:\s*0;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.shortcut-settings-dialog--embedded\s+\.shortcut-settings-dialog__footer\s*\{[^}]*margin:\s*0 -32px 0;/s,
    );
  });

  test("uses grouped full-width sidebar items with the approved fixed width", () => {
    renderWorkspace();

    const templatesItem = screen.getByRole("button", { name: "默认模板" });
    expect(templatesItem.classList.contains("settings-workspace-navigation__item")).toBe(true);
    expect(templatesItem.closest(".settings-workspace-navigation__group")?.textContent).toContain(
      "文档与写作",
    );
    expect(
      screen
        .getByRole("button", { name: "存储与备份" })
        .closest(".settings-workspace-navigation__group")?.textContent,
    ).toContain("数据与安全");
    expect(
      templatesItem
        .closest(".settings-workspace-navigation")
        ?.classList.contains("settings-workspace-navigation"),
    ).toBe(true);
    expect(APPLICATION_STYLES).toMatch(
      /\.application-settings-dialog__body--workspace\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.application-settings-dialog__body\s*\{[^}]*grid-template-columns:\s*232px minmax\(0,\s*1fr\);/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.application-settings-dialog__surface--workspace\s*\{[^}]*width:\s*min\(1110px,[^}]*height:\s*min\(764px,/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.application-settings-dialog__header\s*\{[^}]*min-height:\s*67px;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.settings-workspace-navigation__item\s*\{[^}]*width:\s*100%;[^}]*display:\s*block;[^}]*text-align:\s*left;/s,
    );
    expect(APPLICATION_STYLES).toContain(
      '.settings-workspace-navigation__item[aria-current="page"] {',
    );
    expect(APPLICATION_STYLES).toContain(".settings-workspace-navigation__group {");
    expect(APPLICATION_STYLES).toContain(".settings-workspace-navigation__group-title {");
    expect(APPLICATION_STYLES).toContain(".settings-workspace-breadcrumb {");
    expect(APPLICATION_STYLES).not.toContain(".application-settings-dialog__body nav {");
    expect(APPLICATION_STYLES).not.toContain(".application-settings-dialog__body > nav");
  });

  test("lays out the embedded default template editor as an equal-width two-column workspace", () => {
    renderWorkspace();

    expect(screen.getByTestId("settings-workspace-content").className).toContain(
      "settings-workspace-content--templates",
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog--embedded\s+\.template-dialog__template-selector\s*\{[^}]*white-space:\s*nowrap;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog--embedded\s+\.template-dialog__body--settings\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog--embedded\s+\.template-dialog__text-input\s*\{[^}]*min-height:\s*240px;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog--embedded\s+\.template-dialog__preview pre\s*\{[^}]*min-height:\s*240px;/s,
    );
  });

  test("aligns the template title and keeps its action bar visible at the bottom", () => {
    renderWorkspace();

    expect(APPLICATION_STYLES).toMatch(
      /\.settings-workspace-content--templates\s*\{[^}]*overflow:\s*hidden;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.settings-workspace-content__route--templates\s*\{[^}]*height:\s*100%;[^}]*margin-top:\s*0;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog--embedded\s*\{[^}]*height:\s*100%;[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog--embedded\s+\.template-dialog__preview h3\s*\{[^}]*font-size:\s*16px;/s,
    );
  });

  test("keeps template-range buttons compact and on one line", () => {
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog--embedded\s+\.template-dialog__tabs\s*\{[^}]*gap:\s*6px;/s,
    );
    expect(APPLICATION_STYLES).toMatch(
      /\.template-dialog--embedded\s+\.template-dialog__tabs button\s*\{[^}]*min-height:\s*32px;[^}]*padding:\s*0 8px;[^}]*font-size:\s*14px;[^}]*white-space:\s*nowrap;/s,
    );
  });

  test("navigates directly to backup management without a redundant return path", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: "存储与备份" }));
    await user.click(screen.getByRole("button", { name: "备份文件" }));

    expect(screen.getByRole("heading", { name: "存储与备份" })).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "返回路径" })).toBeNull();
  });

  test("places data migration after recovery entries and opens its entry page", async () => {
    const user = userEvent.setup();
    renderWorkspaceWithCloseCoordinator();

    const navigation = screen.getByRole("navigation", { name: "设置分类" });
    const labels = within(navigation)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels.indexOf("存储与备份")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("数据迁移")).toBeGreaterThan(labels.indexOf("存储与备份"));

    await user.click(screen.getByRole("button", { name: "数据迁移" }));

    expect(await screen.findByRole("heading", { name: "数据迁移" })).toBeDefined();
    expect(screen.getByRole("button", { name: "导出完整数据包" })).toBeDefined();
    expect(screen.getByRole("button", { name: "导入完整数据包" })).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "返回路径" })).toBeNull();
  });

  test("renders page settings inside the workspace without another dialog", async () => {
    const user = userEvent.setup();
    installPageMarginSettingsApi();
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: "页边距" }));

    expect(screen.queryByRole("dialog", { name: "页边距设置" })).toBeNull();
    expect(screen.getByRole("region", { name: "页面设置" })).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "返回路径" })).toBeNull();
  });

  test("renders data safety settings in the protection route without another dialog", async () => {
    const user = userEvent.setup();
    window.patentApi = {
      settings: { read: vi.fn(async () => ({ ok: true as const, value: DEFAULT_APP_SETTINGS })) },
      backup: {
        status: vi.fn(async () => ({
          ok: true as const,
          value: {
            enabled: false,
            folder: null,
            intervalMinutes: 5,
            lastAttemptAt: null,
            lastBackupAt: null,
            nextBackupAt: null,
            lastRunSuccessCount: 0,
            lastRunFailureCount: 0,
            lastError: null,
          },
        })),
      },
      snapshot: {
        status: vi.fn(async () => ({
          ok: true as const,
          value: {
            enabled: false,
            intervalMinutes: 5,
            maxCount: 30,
            lastCheckAt: null,
            lastSnapshotAt: null,
            nextCheckAt: null,
            lastError: null,
          },
        })),
      },
    } as unknown as PatentApi;
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: "存储与备份" }));
    await user.click(screen.getByRole("button", { name: "定时备份" }));

    expect(await screen.findByRole("region", { name: "数据安全设置" })).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "数据安全设置" })).toBeNull();
    expect(
      screen
        .getByTestId("settings-workspace-content")
        .classList.contains("settings-workspace-content--protection"),
    ).toBe(true);
    await user.selectOptions(await screen.findByLabelText("备份间隔"), "10");
    expect(screen.queryByRole("checkbox", { name: "启用自动快照" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "快照设置" }));
    expect(await screen.findByRole("checkbox", { name: "启用自动快照" })).toBeDefined();
    expect(screen.queryByRole("checkbox", { name: "启用定时备份" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "定时备份" }));
    expect(screen.getByLabelText("备份间隔")).toHaveProperty("value", "10");
  });

  test("opens snapshot preview as an independent dialog and keeps the manager in place", async () => {
    const user = userEvent.setup();
    const documentId = "00000000-0000-4000-8000-000000000921";
    const document = createBlankBookDocument("快照预览");
    window.patentApi = {
      snapshot: {
        list: vi.fn(async () => ({
          ok: true as const,
          value: {
            entries: [
              {
                documentType: "patent" as const,
                documentId,
                displayName: "测试专利",
                revision: 4,
                sizeBytes: 1024,
                createdAt: "2026-08-16T01:02:03.000Z",
                status: "healthy" as const,
                errorMessage: null,
                deletable: true,
                contentSummary: {
                  books: [],
                  figureCount: 0,
                  assetCount: 0,
                  flowchartCount: 0,

                  referenceMarkCount: 0,
                },
              },
            ],
            warnings: [],
          },
        })),
        preview: vi.fn(async () => ({
          ok: true as const,
          value: {
            current: {
              revision: 4,
              createdAt: "2026-08-16T01:02:03.000Z",
              books: [
                "claims",
                "description",
                "description-drawings",
                "abstract",
                "abstract-drawing",
              ].map((kind) => ({ kind, document })),
            },
            baseline: null,
            comparison: "initial" as const,
            skippedRevisions: [],
          },
        })),
      },
    } as unknown as PatentApi;
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: "存储与备份" }));
    await user.click(screen.getByRole("button", { name: "快照版本" }));
    await user.click(await screen.findByRole("button", { name: /测试专利/ }));
    await user.click(screen.getByRole("button", { name: "查看 v4 内容预览" }));

    expect(await screen.findByRole("dialog", { name: "v4 内容预览" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "v4 内容预览" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "关闭内容预览" }));
    expect(screen.getByRole("heading", { name: "存储与备份" })).toBeDefined();
    expect(screen.getByRole("region", { name: "快照管理器" })).toBeDefined();
  });

  test("keeps page-margin drafts while navigating back through the template launcher", async () => {
    const user = userEvent.setup();
    installPageMarginSettingsApi();
    renderWorkspace();

    expect(screen.getByRole("region", { name: "默认模板" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "页边距" }));

    await screen.findByLabelText("左边距 (cm)");
    fireEvent.change(screen.getByLabelText("左边距 (cm)"), { target: { value: "1.23" } });
    await user.click(screen.getByRole("button", { name: "默认模板" }));

    expect(screen.getByRole("region", { name: "默认模板" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "页边距" }));
    expect(screen.getByLabelText("左边距 (cm)")).toHaveProperty("value", "1.23");
  });

  test("keeps an embedded shortcut draft while switching between its fixed and custom tabs", async () => {
    const user = userEvent.setup();
    render(
      <ApplicationSettingsWorkspace
        shortcutSettings={DEFAULT_SHORTCUT_SETTINGS}
        onSaveShortcutSettings={vi.fn(async () => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "快捷键" }));

    expect(screen.queryByRole("dialog", { name: "快捷键设置" })).toBeNull();
    expect(screen.getByRole("region", { name: "快捷键设置" })).toBeDefined();
    expect(screen.getByTestId("settings-workspace-content").className).toContain(
      "settings-workspace-content--shortcuts",
    );
    expect(screen.queryByRole("heading", { name: "快捷键设置" })).toBeNull();
    expect(screen.getByText(/Backspace 或 Delete 可清除/u)).toBeDefined();
    const shortcutInput = screen.getByRole("button", { name: "设置附图排序快捷键" });
    await user.click(shortcutInput);
    fireEvent.keyDown(shortcutInput, { code: "F8", key: "F8" });
    await user.click(screen.getByRole("tab", { name: "固定快捷键" }));
    await user.click(screen.getByRole("button", { name: "默认模板" }));
    await user.click(screen.getByRole("button", { name: "快捷键" }));
    await user.click(screen.getByRole("tab", { name: "自定义快捷键" }));

    expect(screen.getByRole("button", { name: "设置附图排序快捷键" }).textContent).toContain("F8");
  });

  test("keeps the settings workspace open and shows feedback after automatic shortcut saving", async () => {
    const user = userEvent.setup();
    const onCloseWorkspace = vi.fn();
    render(
      <ApplicationSettingsWorkspace
        shortcutSettings={DEFAULT_SHORTCUT_SETTINGS}
        onCloseWorkspace={onCloseWorkspace}
        onSaveShortcutSettings={vi.fn(async () => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "快捷键" }));
    const shortcutInput = screen.getByRole("button", { name: "设置附图排序快捷键" });
    await user.click(shortcutInput);
    fireEvent.keyDown(shortcutInput, { code: "F8", key: "F8" });

    expect(onCloseWorkspace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "快捷键" })).toBeDefined();
    expect(await screen.findByText("已自动保存。")).toBeDefined();
    expect(screen.getByRole("region", { name: "快捷键设置" }).className).toContain(
      "shortcut-settings-dialog--embedded",
    );
  });

  test("places custom dual-view configuration in editor assistance", async () => {
    const user = userEvent.setup();
    const onOpenCustomDualView = vi.fn();
    render(
      <ApplicationSettingsWorkspace
        shortcutSettings={DEFAULT_SHORTCUT_SETTINGS}
        onSaveShortcutSettings={vi.fn(async () => true)}
        onOpenCustomDualView={onOpenCustomDualView}
      />,
    );

    await user.click(screen.getByRole("button", { name: "快捷键" }));
    expect(screen.queryByRole("button", { name: "自定义同屏双显" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "编辑辅助" }));
    await user.click(screen.getByRole("button", { name: "自定义同屏双显" }));

    expect(onOpenCustomDualView).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "编辑辅助设置" })).toBeDefined();
  });

  test("does not render manual save or cancel actions for embedded shortcuts", async () => {
    const user = userEvent.setup();
    const onCloseWorkspace = vi.fn();
    render(
      <ApplicationSettingsWorkspace
        shortcutSettings={DEFAULT_SHORTCUT_SETTINGS}
        onCloseWorkspace={onCloseWorkspace}
        onSaveShortcutSettings={vi.fn(async () => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "快捷键" }));

    expect(onCloseWorkspace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "快捷键" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  test("opens the embedded AI model editor on the workspace route without a nested dialog", async () => {
    const user = userEvent.setup();
    installAiCorrectionSettingsApi();
    render(<ApplicationSettingsWorkspace />);

    await user.click(
      screen.getByRole("button", { name: /^AI 设置(?:（实验功能）|\s*实验功能)?$/ }),
    );
    expect(await screen.findByRole("region", { name: "AI 设置" })).toBeDefined();
    const routeContent = screen
      .getByTestId("settings-workspace-content")
      .querySelector(".settings-workspace-content__route");
    expect(
      Array.from(routeContent?.children ?? []).filter((child) => !child.hasAttribute("hidden")),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("navigation", { name: "设置分类" })).getByText("智能辅助"),
    ).toBeDefined();
    expect(screen.queryByRole("heading", { name: "AI 模型管理" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "添加模型" }));

    expect(screen.getByRole("heading", { name: "添加新模型" })).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: /^AI 设置(?:（实验功能）|\s*实验功能)?$/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("region", { name: "添加新模型" }).className).toContain(
      "ai-settings-workspace-panel",
    );
    expect(screen.queryByRole("heading", { name: "添加模型" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "添加模型" })).toBeNull();
  });

  test("shows embedded AI model settings without redundant footer actions", async () => {
    const user = userEvent.setup();
    const onCloseWorkspace = vi.fn();
    installAiCorrectionSettingsApi();
    render(<ApplicationSettingsWorkspace onCloseWorkspace={onCloseWorkspace} />);

    await user.click(
      screen.getByRole("button", { name: /^AI 设置(?:（实验功能）|\s*实验功能)?$/ }),
    );

    expect(onCloseWorkspace).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: /^AI 设置(?:（实验功能）|\s*实验功能)?$/ }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
  });

  test("starts a new model after cancelling an edit of an existing model", async () => {
    const user = userEvent.setup();
    window.patentApi = {
      aiCorrection: {
        getSettings: vi.fn(async () => ({
          ok: true as const,
          value: {
            settings: {
              enabled: true,
              profiles: [
                {
                  profileId: "11111111-1111-4111-8111-111111111111",
                  providerId: "deepseek",
                  displayName: "已有模型",
                  baseUrl: "https://api.deepseek.com",
                  model: "deepseek-chat",
                },
              ],
              activeProfileId: "11111111-1111-4111-8111-111111111111",
              timeoutMs: 30000,
              maxUploadCharacters: 10000,
            },
            credentialProfileIds: ["11111111-1111-4111-8111-111111111111"],
          },
        })),
      },
    } as unknown as PatentApi;
    render(<ApplicationSettingsWorkspace />);

    await user.click(
      screen.getByRole("button", { name: /^AI 设置(?:（实验功能）|\s*实验功能)?$/ }),
    );
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getAllByRole("heading", { name: "编辑模型" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "添加模型" }));

    expect(screen.getByRole("heading", { name: "添加新模型" })).toBeDefined();
  });

  test("retains the model draft when navigating back without cancelling", async () => {
    const user = userEvent.setup();
    installAiCorrectionSettingsApi();
    render(<ApplicationSettingsWorkspace />);

    await user.click(
      screen.getByRole("button", { name: /^AI 设置(?:（实验功能）|\s*实验功能)?$/ }),
    );
    await user.click(await screen.findByRole("button", { name: "添加模型" }));
    await user.type(screen.getByLabelText("API Key"), "draft-key");
    await user.click(screen.getByRole("button", { name: "返回AI 设置" }));

    expect(
      screen.getByRole("heading", { name: /^AI 设置(?:（实验功能）|\s*实验功能)?$/ }),
    ).toBeDefined();
    await user.click(screen.getByRole("button", { name: "添加模型" }));
    expect(screen.getByLabelText("API Key")).toHaveProperty("value", "draft-key");
  });
});
