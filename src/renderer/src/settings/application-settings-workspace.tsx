import { useRef, useState } from "react";
import { isAgentCliAvailable, isNetworkAiAvailable } from "../../../shared/platform";
import type { CustomDualViewPreset } from "../../../shared/settings/custom-dual-view";
import type { PageMargins } from "../../../shared/settings/page-margins";
import type { ShortcutSettings } from "../../../shared/settings/shortcuts";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";
import { SoftwareUpdateSettings } from "../updates/software-update-settings";
import { AiConnectionSettings } from "./ai-connection-settings";
import { AiCorrectionSettingsDialog } from "./ai-correction-settings-dialog";
import { AutomationSettings } from "./automation-settings";
import { BackupManager } from "./backup-manager";
import { ContentSearchSettings } from "./content-search-settings";
import { DataSafetyDialog } from "./data-safety-dialog";
import { DataTransferSettings } from "./data-transfer-settings";
import { EditorAssistanceSettings } from "./editor-assistance-settings";
import { GeneralSettings, type PreferenceProps, StorageOverview } from "./general-settings";
import { PageMarginDialog } from "./page-margin-dialog";
import { PatentTemplateCatalogSettings } from "./patent-template-catalog-settings";
import { ShortcutSettingsDialog } from "./shortcut-settings-dialog";
import { SnapshotManager } from "./snapshot-manager";
import { StartupSettings } from "./startup-settings";

export type SettingsRoute =
  | "automation"
  | "content-search"
  | "software-updates"
  | "startup"
  | "display"
  | "storage"
  | "templates"
  | "page-margins"
  | "editor-assistance"
  | "shortcuts"
  | "ai-models"
  | "ai-model-editor"
  | "data-safety"
  | "snapshot-settings"
  | "data-transfer"
  | "backups"
  | "snapshots";

export type SettingsRouteState = {
  current: SettingsRoute;
  visited: ReadonlySet<SettingsRoute>;
  returnTo: Partial<Record<"ai-model-editor", SettingsRoute>>;
};

type NavigationItem = {
  route: SettingsRoute;
  label: string;
};

type NavigationGroup = {
  label: string;
  items: readonly NavigationItem[];
};

const NAVIGATION_GROUPS: readonly NavigationGroup[] = [
  {
    label: "文档与写作",
    items: [
      { route: "templates", label: "默认模板" },
      { route: "page-margins", label: "页边距" },
      { route: "editor-assistance", label: "编辑辅助" },
      { route: "shortcuts", label: "快捷键" },
    ],
  },
  {
    label: "界面与启动",
    items: [
      { route: "display", label: "显示偏好" },
      { route: "startup", label: "启动与关闭" },
      { route: "software-updates", label: "软件更新" },
    ],
  },
  {
    label: "智能辅助",
    items: [
      { route: "ai-models", label: "AI 设置" },
      { route: "automation", label: "Agent CLI" },
    ],
  },
  {
    label: "数据与安全",
    items: [
      { route: "content-search", label: "内容搜索" },
      { route: "storage", label: "存储与备份" },
      { route: "data-transfer", label: "数据迁移" },
    ],
  },
];

const STORAGE_ROUTES: readonly NavigationItem[] = [
  { route: "storage", label: "存储位置" },
  { route: "data-safety", label: "定时备份" },
  { route: "snapshot-settings", label: "快照设置" },
  { route: "backups", label: "备份文件" },
  { route: "snapshots", label: "快照版本" },
];

const ROUTE_LABELS: Record<SettingsRoute, string> = {
  automation: "Agent CLI",
  "content-search": "内容搜索",
  "software-updates": "软件更新",
  startup: "启动与关闭",
  display: "显示偏好",
  storage: "存储概览",
  templates: "默认模板",
  "page-margins": "页边距",
  "editor-assistance": "编辑辅助",
  shortcuts: "快捷键",
  "ai-models": "AI 设置",
  "ai-model-editor": "编辑模型",
  "data-safety": "定时备份",
  "snapshot-settings": "快照设置",
  "data-transfer": "数据迁移",
  backups: "备份文件",
  snapshots: "快照版本",
};

const PARENT_ROUTES: Partial<Record<SettingsRoute, SettingsRoute>> = {
  "ai-model-editor": "ai-models",
};

function createInitialRouteState(initialRoute: SettingsRoute): SettingsRouteState {
  return {
    current: initialRoute,
    visited: new Set([initialRoute]),
    returnTo: {},
  };
}

export type ApplicationSettingsWorkspaceProps = PreferenceProps & {
  preferences?: PreferenceProps["preferences"] & { autoCheckUpdates?: boolean };
  initialRoute?: SettingsRoute;
  prepareCurrentPatentTemplate?: () => Promise<{
    patentId: string;
    expectedRevision: number;
  } | null>;
  pageMarginContext?: {
    hasEditableDocument: boolean;
    pageWidthMm: number;
    pageHeightMm: number;
    onSaved(margins: PageMargins): void;
    validateChange?(margins: PageMargins): string | null;
  };
  onCloseWorkspace?: () => void;
  shortcutSettings?: ShortcutSettings;
  customDualViewPresets?: readonly CustomDualViewPreset[];
  onSaveShortcutSettings?: (settings: ShortcutSettings) => Promise<boolean>;
  onOpenCustomDualView?: () => void;
  onOpenInventionContentSettings?: () => void;
  onAiCorrectionSettingsChanged?: () => void;
  onBackupRestored?: () => unknown | Promise<unknown>;
  onSnapshotRestored?: (documentId: string) => unknown | Promise<unknown>;
  prepareSnapshot?: (patentId: string) => Promise<boolean>;
  referenceMarkLocatorEnabled?: boolean;
  onReferenceMarkLocatorEnabledChange?: (enabled: boolean) => void;
};

export function ApplicationSettingsWorkspace({
  initialRoute = "templates",
  prepareCurrentPatentTemplate,
  pageMarginContext,
  onCloseWorkspace,
  shortcutSettings,
  customDualViewPresets,
  onSaveShortcutSettings,
  onOpenCustomDualView,
  onOpenInventionContentSettings,
  onAiCorrectionSettingsChanged,
  onBackupRestored,
  onSnapshotRestored,
  prepareSnapshot,
  referenceMarkLocatorEnabled = true,
  onReferenceMarkLocatorEnabledChange = () => undefined,
  preferences,
  onSavePreferences,
}: ApplicationSettingsWorkspaceProps) {
  const agentCliAvailable = isAgentCliAvailable();
  const routeAvailable = (route: SettingsRoute) =>
    (route !== "automation" || agentCliAvailable) &&
    (!route.startsWith("ai-model") || isNetworkAiAvailable());
  const [routeState, setRouteState] = useState<SettingsRouteState>(() =>
    createInitialRouteState(!routeAvailable(initialRoute) ? "templates" : initialRoute),
  );
  const contentRef = useRef<HTMLDivElement>(null);
  useSpatialViewMotion(contentRef, routeState.current);
  const [addingAiModel, setAddingAiModel] = useState(false);
  const parentRoute = PARENT_ROUTES[routeState.current];
  const storageActive = STORAGE_ROUTES.some((item) => item.route === routeState.current);
  const navigationRoute = storageActive ? "storage" : (parentRoute ?? routeState.current);
  const currentGroup = NAVIGATION_GROUPS.find((group) =>
    group.items.some((item) => item.route === navigationRoute),
  );
  const currentRouteLabel =
    routeState.current === "ai-model-editor" && addingAiModel
      ? "添加新模型"
      : ROUTE_LABELS[routeState.current];

  const navigate = (route: SettingsRoute) => {
    if (!routeAvailable(route)) return;
    setRouteState((current) => ({
      ...current,
      current: route,
      visited: new Set([...current.visited, route]),
      returnTo:
        route === "ai-model-editor"
          ? { ...current.returnTo, [route]: current.current }
          : current.returnTo,
    }));
  };

  const returnToParent = () => {
    const detailReturn =
      routeState.current === "ai-model-editor"
        ? routeState.returnTo[routeState.current]
        : undefined;
    if (detailReturn) navigate(detailReturn);
    else if (parentRoute) navigate(parentRoute);
  };

  return (
    <div className="application-settings-dialog__body application-settings-dialog__body--workspace">
      <nav
        className="settings-workspace-navigation"
        aria-label="设置分类"
        data-testid="settings-workspace-navigation"
      >
        {NAVIGATION_GROUPS.map((group) => (
          <section className="settings-workspace-navigation__group" key={group.label}>
            <h3 className="settings-workspace-navigation__group-title">{group.label}</h3>
            {group.items
              .filter((item) => routeAvailable(item.route))
              .map((item) => (
                <button
                  key={item.route}
                  className="settings-workspace-navigation__item"
                  type="button"
                  aria-label={
                    ["automation", "ai-models"].includes(item.route)
                      ? `${item.label}（实验功能）`
                      : undefined
                  }
                  aria-current={navigationRoute === item.route ? "page" : undefined}
                  onClick={() => navigate(item.route)}
                >
                  {item.label}
                  {["automation", "ai-models"].includes(item.route) ? (
                    <span className="agent-experimental-badge">实验功能</span>
                  ) : null}
                </button>
              ))}
          </section>
        ))}
      </nav>
      <section
        className={`settings-workspace-content application-settings-dialog__content${
          routeState.current === "templates" ? " settings-workspace-content--templates" : ""
        }${routeState.current === "shortcuts" ? " settings-workspace-content--shortcuts" : ""}${
          routeState.current === "data-safety" || routeState.current === "snapshot-settings"
            ? " settings-workspace-content--protection"
            : ""
        }`}
        aria-label={`${currentRouteLabel}内容`}
        data-testid="settings-workspace-content"
      >
        <div className="settings-workspace-content__header">
          <div className="settings-workspace-content__category">{currentGroup?.label}</div>
          {parentRoute ? (
            <nav className="settings-workspace-breadcrumb" aria-label="返回路径">
              <button type="button" onClick={returnToParent}>
                返回{ROUTE_LABELS[parentRoute]}
              </button>
              <span aria-hidden="true"> / </span>
              <span>{currentRouteLabel}</span>
            </nav>
          ) : null}
          <h3 className="settings-workspace-content__title">
            {storageActive ? "存储与备份" : currentRouteLabel}
            {["automation", "ai-models"].includes(routeState.current) ? (
              <span className="agent-experimental-badge">实验功能</span>
            ) : null}
          </h3>
          {storageActive && (
            <nav className="settings-storage-tabs" aria-label="存储与备份页面">
              {STORAGE_ROUTES.map((item) => (
                <button
                  key={item.route}
                  type="button"
                  aria-current={routeState.current === item.route ? "page" : undefined}
                  onClick={() => navigate(item.route)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          )}
        </div>
        <div
          ref={contentRef}
          className={`settings-workspace-content__route${
            routeState.current === "templates"
              ? " settings-workspace-content__route--templates settings-workspace-content__route--standard"
              : " settings-workspace-content__route--standard"
          }`}
        >
          {Array.from(routeState.visited)
            .filter((route) => route !== "ai-models" && route !== "ai-model-editor")
            .map((route) => (
              <div
                key={route}
                hidden={route !== routeState.current}
                aria-hidden={route !== routeState.current}
              >
                {route === "shortcuts" && shortcutSettings && onSaveShortcutSettings ? (
                  <ShortcutSettingsDialog
                    embedded
                    open
                    value={shortcutSettings}
                    {...(customDualViewPresets ? { customDualViewPresets } : {})}
                    onClose={() => onCloseWorkspace?.()}
                    onSave={onSaveShortcutSettings}
                  />
                ) : route === "software-updates" ? (
                  <SoftwareUpdateSettings
                    enabled={preferences?.autoCheckUpdates ?? true}
                    {...(onSavePreferences ? { onSave: onSavePreferences } : {})}
                  />
                ) : route === "startup" ? (
                  <StartupSettings
                    closeToTray={preferences?.closeToTray ?? true}
                    {...(onSavePreferences ? { onSave: onSavePreferences } : {})}
                  />
                ) : route === "display" ? (
                  <GeneralSettings
                    kind={route}
                    {...(preferences ? { preferences } : {})}
                    {...(onSavePreferences ? { onSavePreferences } : {})}
                  />
                ) : route === "storage" ? (
                  <StorageOverview />
                ) : (
                  <WorkspaceRouteContent
                    route={route}
                    onOpenBackupSettings={() => navigate("data-safety")}
                    onReturnToParent={returnToParent}
                    prepareCurrentPatentTemplate={prepareCurrentPatentTemplate}
                    pageMarginContext={pageMarginContext}
                    onCloseWorkspace={onCloseWorkspace}
                    onBackupRestored={onBackupRestored}
                    onSnapshotRestored={onSnapshotRestored}
                    prepareSnapshot={prepareSnapshot}
                    active={route === routeState.current}
                    referenceMarkLocatorEnabled={referenceMarkLocatorEnabled}
                    onReferenceMarkLocatorEnabledChange={onReferenceMarkLocatorEnabledChange}
                    onOpenCustomDualView={onOpenCustomDualView}
                    onOpenInventionContentSettings={onOpenInventionContentSettings}
                  />
                )}
              </div>
            ))}
          {routeState.visited.has("ai-models") ? (
            <div
              hidden={
                routeState.current !== "ai-models" && routeState.current !== "ai-model-editor"
              }
              aria-hidden={
                routeState.current !== "ai-models" && routeState.current !== "ai-model-editor"
              }
            >
              <div hidden={routeState.current === "ai-model-editor"}>
                <AiConnectionSettings
                  {...(preferences ? { preferences } : {})}
                  {...(onSavePreferences ? { onSavePreferences } : {})}
                />
              </div>
              <AiCorrectionSettingsDialog
                embedded
                open
                mode={routeState.current === "ai-model-editor" ? "editor" : "models"}
                onClose={() => onCloseWorkspace?.()}
                {...(onAiCorrectionSettingsChanged
                  ? { onSettingsChanged: onAiCorrectionSettingsChanged }
                  : {})}
                onOpenModelEditor={(isNew) => {
                  setAddingAiModel(isNew);
                  navigate("ai-model-editor");
                }}
                onBack={returnToParent}
              />
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function WorkspaceRouteContent({
  route,
  onOpenBackupSettings,
  onReturnToParent,
  prepareCurrentPatentTemplate,
  pageMarginContext,
  onCloseWorkspace,
  onBackupRestored,
  onSnapshotRestored,
  prepareSnapshot,
  active,
  referenceMarkLocatorEnabled,
  onReferenceMarkLocatorEnabledChange,
  onOpenCustomDualView,
  onOpenInventionContentSettings,
}: {
  route: SettingsRoute;
  onOpenBackupSettings(): void;
  onReturnToParent(): void;
  prepareCurrentPatentTemplate?: ApplicationSettingsWorkspaceProps["prepareCurrentPatentTemplate"];
  pageMarginContext?: ApplicationSettingsWorkspaceProps["pageMarginContext"] | undefined;
  onCloseWorkspace?: (() => void) | undefined;
  onBackupRestored?: (() => unknown | Promise<unknown>) | undefined;
  onSnapshotRestored?: ((documentId: string) => unknown | Promise<unknown>) | undefined;
  prepareSnapshot?: ApplicationSettingsWorkspaceProps["prepareSnapshot"];
  active: boolean;
  referenceMarkLocatorEnabled: boolean;
  onReferenceMarkLocatorEnabledChange(enabled: boolean): void;
  onOpenCustomDualView?: (() => void) | undefined;
  onOpenInventionContentSettings?: (() => void) | undefined;
}) {
  if (route === "automation") return <AutomationSettings active={active} />;
  if (route === "content-search") return <ContentSearchSettings active={active} />;
  if (route === "templates") {
    return (
      <PatentTemplateCatalogSettings
        {...(prepareCurrentPatentTemplate
          ? { prepareCurrentPatent: prepareCurrentPatentTemplate }
          : {})}
      />
    );
  }
  if (route === "page-margins" && pageMarginContext) {
    return (
      <PageMarginDialog
        embedded
        open
        onClose={onReturnToParent}
        onSaved={pageMarginContext.onSaved}
        validateChange={pageMarginContext.validateChange}
        pageWidthMm={pageMarginContext.pageWidthMm}
        pageHeightMm={pageMarginContext.pageHeightMm}
        hasEditableDocument={pageMarginContext.hasEditableDocument}
      />
    );
  }
  if (route === "editor-assistance") {
    return (
      <EditorAssistanceSettings
        referenceMarkLocatorEnabled={referenceMarkLocatorEnabled}
        onReferenceMarkLocatorEnabledChange={onReferenceMarkLocatorEnabledChange}
        {...(onOpenCustomDualView ? { onOpenCustomDualView } : {})}
        {...(onOpenInventionContentSettings ? { onOpenInventionContentSettings } : {})}
      />
    );
  }
  if (route === "snapshots") {
    return (
      <SnapshotManager
        embedded
        open
        onClose={() => onCloseWorkspace?.()}
        onRestored={onSnapshotRestored ?? (() => undefined)}
        active={active}
        {...(prepareSnapshot ? { prepareSnapshot } : {})}
      />
    );
  }
  if (route === "data-safety") {
    return <DataSafetyDialog embedded open section="backup" onClose={() => onCloseWorkspace?.()} />;
  }
  if (route === "snapshot-settings") {
    return (
      <DataSafetyDialog embedded open section="snapshot" onClose={() => onCloseWorkspace?.()} />
    );
  }
  if (route === "data-transfer") {
    return <DataTransferSettings open />;
  }
  if (route === "backups") {
    return (
      <BackupManager
        onOpenSettings={onOpenBackupSettings}
        embedded
        open
        onClose={() => onCloseWorkspace?.()}
        onRestored={onBackupRestored ?? (() => undefined)}
      />
    );
  }
  return <p>{ROUTE_LABELS[route]}将在此设置工作台中管理。</p>;
}
