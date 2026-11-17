import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetDescriptor } from "../../../shared/document/model";
import type { PatentType } from "../../../shared/patent/model";
import {
  isFilledPatentTemplateSlot,
  PATENT_TEMPLATE_NAME_MAX_LENGTH,
  type PatentTemplateCatalog,
  type PatentTemplateEditorSnapshot,
  type PatentTemplateLauncherSummary,
  type PatentTemplateSlot,
} from "../../../shared/patent/template-catalog";
import { createFactoryPatentTemplates } from "../../../shared/patent/templates";
import { createSettingsId } from "../../../shared/settings/model";
import { useApplicationCloseGuard } from "../app/application-close-coordinator";
import { MotionPresence, useMotionPresenceClosing } from "../app/motion-presence";
import { confirmAppAction } from "../shared/app-dialog";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { SpatialView } from "../shared/spatial-view";
import { StandardDialog } from "../shared/standard-dialog";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";
import { TemplateBookEditor } from "./template-book-editor";
import { TemplateViewTransition } from "./template-view-transition";

type TextBookKind = "claims" | "description" | "abstract";
type ExitChoice = "continue" | "discard" | "save";
type PendingExit = {
  target: "dialog" | "application";
  resolve(choice: ExitChoice): void;
};

type PatentTemplateCatalogSettingsProps = {
  prepareCurrentPatent?(): Promise<{
    patentId: string;
    expectedRevision: number;
  } | null>;
};

const TYPE_LABELS: Record<PatentType, string> = {
  invention: "发明",
  "utility-model": "实用新型",
};
const BOOK_LABELS: Record<TextBookKind, string> = {
  claims: "权利要求书",
  description: "说明书",
  abstract: "说明书摘要",
};

export function PatentTemplateCatalogSettings({
  prepareCurrentPatent,
}: PatentTemplateCatalogSettingsProps) {
  const [summary, setSummary] = useState<PatentTemplateLauncherSummary | null>(null);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [editorGeneration, setEditorGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const templateApi = window.patentApi?.patentTemplates;
    if (!templateApi) {
      setSummaryLoaded(true);
      return;
    }
    void templateApi.readSummary().then((result) => {
      if (cancelled) return;
      if (result.ok) setSummary(result.value);
      setSummaryLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-page template-catalog-launcher" aria-label="默认模板">
      <div className="preference-group">
        <h4>模板方案</h4>
        <div className="template-catalog-launcher__summary preference-card">
          {(["invention", "utility-model"] as const).map((type) => (
            <div className="preference-row" key={type}>
              <span className="preference-copy">
                {TYPE_LABELS[type]}专利
                <small>
                  {summary?.separatePatentTypes === false && type === "utility-model"
                    ? "与发明专利共用模板"
                    : "权利要求书、说明书及摘要等文档"}
                </small>
              </span>
              <span className="template-catalog-launcher__selection">
                <strong>
                  {summary
                    ? selectionLabel(summary, type)
                    : summaryLoaded
                      ? "暂时无法读取"
                      : "正在读取…"}
                </strong>
                {summary ? <small>使用中</small> : null}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="template-catalog-launcher__actions">
        <button
          type="button"
          className="primary-button"
          aria-label="打开默认模板设置"
          onClick={() => {
            // A closing view may still be painted, but its editor session is retired.
            setEditorGeneration((current) => current + 1);
            setOpen(true);
          }}
        >
          管理默认模板
        </button>
        <span>更改模板不会自动重写已有文档</span>
      </div>
      <MotionPresence>
        {open ? (
          <PatentTemplateCatalogDialog
            key={editorGeneration}
            prepareCurrentPatent={prepareCurrentPatent}
            onSaved={(catalog) => {
              setSummary(toLauncherSummary(catalog));
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </MotionPresence>
    </section>
  );
}

function PatentTemplateCatalogDialog({
  prepareCurrentPatent,
  onSaved,
  onClose,
}: {
  prepareCurrentPatent?: PatentTemplateCatalogSettingsProps["prepareCurrentPatent"];
  onSaved(catalog: PatentTemplateCatalog): void;
  onClose(): void;
}) {
  const closing = useMotionPresenceClosing();
  const [snapshot, setSnapshot] = useState<PatentTemplateEditorSnapshot | null>(null);
  const [draft, setDraft] = useState<PatentTemplateCatalog | null>(null);
  const [auxiliaryDraft, setAuxiliaryDraft] = useState<
    PatentTemplateEditorSnapshot["auxiliary"] | null
  >(null);
  const [templateAssets, setTemplateAssets] = useState<AssetDescriptor[]>([]);
  const [patentType, setPatentType] = useState<PatentType>("invention");
  const [bookKind, setBookKind] = useState<TextBookKind>("claims");
  const [selectedSource, setSelectedSource] = useState<string>("system");
  const sourceStage = useRef<HTMLElement>(null);
  const headerStage = useRef<HTMLDivElement>(null);
  useSpatialViewMotion(sourceStage, patentType);
  useSpatialViewMotion(headerStage, `${patentType}:${selectedSource}`);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingExit, setPendingExit] = useState<PendingExit | null>(null);
  const sessionRef = useRef<string | null>(null);
  const retiredRef = useRef(false);
  const systemTemplates = useMemo(() => createFactoryPatentTemplates(createSettingsId), []);

  const retireSession = useCallback(async () => {
    const sessionId = sessionRef.current;
    if (!sessionId || retiredRef.current) return;
    retiredRef.current = true;
    await window.patentApi.patentTemplates.closeEditor({ sessionId });
  }, []);
  useEffect(() => {
    let cancelled = false;
    void window.patentApi.patentTemplates.openEditor({ patentType: "invention" }).then((result) => {
      if (cancelled) {
        if (result.ok)
          void window.patentApi.patentTemplates.closeEditor({ sessionId: result.value.sessionId });
        return;
      }
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      sessionRef.current = result.value.sessionId;
      setSnapshot(result.value);
      setDraft(structuredClone(result.value.catalog));
      setAuxiliaryDraft(structuredClone(result.value.auxiliary));
      setTemplateAssets(structuredClone(result.value.assets ?? []));
      setSelectedSource(sourceKey(result.value.catalog.invention.selection));
    });
    return () => {
      cancelled = true;
      void retireSession();
    };
  }, [retireSession]);

  const group = draft?.[patentType] ?? null;
  const currentSource = group ? sourceKey(group.selection) : "system";
  const visibleSlots =
    group?.slots.filter(
      (slot) =>
        slot.claims !== null ||
        slot.description !== null ||
        slot.abstract !== null ||
        slot.unavailableReason !== null,
    ) ?? [];
  const nextSlot = group?.slots.find((slot) => !visibleSlots.includes(slot));
  const selectedSlot = group?.slots.find((slot) => slot.templateId === selectedSource) ?? null;
  const selectedTemplate =
    selectedSlot && isFilledPatentTemplateSlot(selectedSlot)
      ? selectedSlot[bookKind]
      : selectedSource === "system"
        ? systemTemplates[patentType][bookKind]
        : null;

  const updateDraft = (updater: (catalog: PatentTemplateCatalog) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      updater(next);
      return next;
    });
    setDirty(true);
    setError(null);
  };

  const selectSource = (key: string) => {
    setSelectedSource(key);
    setRenamingId(null);
  };

  const addCustomTemplate = () => {
    if (!nextSlot || busy) return;
    updateDraft((catalog) => {
      const target = catalog[patentType].slots.find(
        (slot) => slot.templateId === nextSlot.templateId,
      );
      if (!target) return;
      target.name = `自定义模板 ${target.slotIndex}`;
      for (const kind of ["claims", "description", "abstract"] as const) {
        target[kind] = {
          page: structuredClone(systemTemplates[patentType][kind].page),
          content: [],
        };
      }
      target.unavailableReason = null;
    });
    selectSource(nextSlot.templateId);
    setBookKind("claims");
  };

  const activateSource = (key: string) => {
    updateDraft((catalog) => {
      if (key === "blank" || key === "system") {
        catalog[patentType].selection = { kind: key };
        return;
      }
      const slot = catalog[patentType].slots.find((candidate) => candidate.templateId === key);
      if (slot && isFilledPatentTemplateSlot(slot)) {
        catalog[patentType].selection = { kind: "custom", templateId: key };
      }
    });
  };

  const switchPatentType = (nextType: PatentType) => {
    setPatentType(nextType);
    const selection = draft?.[nextType].selection;
    setSelectedSource(selection ? sourceKey(selection) : "system");
    setBookKind("claims");
    setRenamingId(null);
  };

  const fillCurrent = async (slot: PatentTemplateSlot | null) => {
    if (!snapshot || !slot || !prepareCurrentPatent) return;
    if (
      isFilledPatentTemplateSlot(slot) &&
      !(await confirmAppAction(`“${slot.name}”已有内容，确定用当前三书覆盖吗？`))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const current = await prepareCurrentPatent();
      if (!current) {
        setError("请先打开一件专利，再填入当前文档内容。");
        return;
      }
      const result = await window.patentApi.patentTemplates.captureCurrent({
        sessionId: snapshot.sessionId,
        patentId: current.patentId,
        expectedPatentRevision: current.expectedRevision,
        targetPatentType: patentType,
        targetTemplateId: slot.templateId,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (
        result.value.omittedOrdinaryImageCount > 0 &&
        !(await confirmAppAction(
          `当前三书含 ${result.value.omittedOrdinaryImageCount} 张普通图片，这些图片不会保存到默认模板，来源专利不会改变。是否继续？`,
        ))
      ) {
        return;
      }
      updateDraft((catalog) => {
        const target = catalog[patentType].slots.find(
          (candidate) => candidate.templateId === slot.templateId,
        );
        if (!target) return;
        target.claims = result.value.claims;
        target.description = result.value.description;
        target.abstract = result.value.abstract;
        target.unavailableReason = null;
      });
      setSelectedSource(slot.templateId);
      setTemplateAssets((current) =>
        mergeAssetDescriptors(current, result.value.referencedChemicalPreviewAssets ?? []),
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteSlot = async (slot: PatentTemplateSlot) => {
    const isCurrent =
      draft?.[patentType].selection.kind === "custom" &&
      draft[patentType].selection.templateId === slot.templateId;
    if (
      !(await confirmAppAction(
        `删除“${slot.name}”？保存设置后生效，不影响已创建的专利文档。${isCurrent ? "删除后将使用系统默认模板。" : ""}`,
      ))
    )
      return;
    updateDraft((catalog) => {
      const target = catalog[patentType].slots.find(
        (candidate) => candidate.templateId === slot.templateId,
      );
      if (!target) return;
      target.claims = null;
      target.description = null;
      target.abstract = null;
      target.unavailableReason = null;
      target.name = `自定义模板 ${target.slotIndex}`;
      if (
        catalog[patentType].selection.kind === "custom" &&
        catalog[patentType].selection.templateId === slot.templateId
      ) {
        catalog[patentType].selection = { kind: "system" };
      }
    });
    if (selectedSource === slot.templateId) setSelectedSource("system");
    if (renamingId === slot.templateId) setRenamingId(null);
  };

  const saveDraft = useCallback(async (): Promise<PatentTemplateCatalog | null> => {
    if (!snapshot || !draft || !auxiliaryDraft) return null;
    setBusy(true);
    setError(null);
    try {
      const result = await window.patentApi.patentTemplates.saveEditor({
        sessionId: snapshot.sessionId,
        expectedRevision: snapshot.catalog.revision,
        catalog: draft,
        auxiliary: auxiliaryDraft,
      });
      if (!result.ok) {
        setError(result.error.message);
        return null;
      }
      setDirty(false);
      return result.value.catalog;
    } finally {
      setBusy(false);
    }
  }, [auxiliaryDraft, draft, snapshot]);

  const requestExit = useCallback(
    (target: PendingExit["target"]) =>
      new Promise<ExitChoice>((resolve) => setPendingExit({ target, resolve })),
    [],
  );
  const guardApplicationClose = useCallback(async () => {
    if (closing) return true;
    if (dirty) {
      const choice = await requestExit("application");
      if (choice === "continue") return false;
      if (choice === "save" && !(await saveDraft())) return false;
    }
    await retireSession();
    return true;
  }, [closing, dirty, requestExit, retireSession, saveDraft]);
  useApplicationCloseGuard("patent-template-catalog-editor", guardApplicationClose);

  const close = async () => {
    if (pendingExit) return;
    if (dirty) {
      const choice = await requestExit("dialog");
      if (choice === "continue") return;
      if (choice === "save") {
        const saved = await saveDraft();
        if (!saved) return;
        await retireSession();
        onSaved(saved);
        return;
      }
    }
    await retireSession();
    onClose();
  };
  const save = async () => {
    const saved = await saveDraft();
    if (!saved) return;
    await retireSession();
    onSaved(saved);
  };
  return (
    <StandardDialog
      open
      title="默认模板设置"
      size="xl"
      className="template-catalog-dialog"
      bodyClassName="template-catalog-dialog__body"
      onCancel={() => void close()}
      footer={
        <>
          <div className="template-catalog-dialog__footer-status">
            {<SpatialPresence>{error ? <span role="alert">{error}</span> : null}</SpatialPresence>}
          </div>
          <div className="template-catalog-dialog__footer-actions">
            <button type="button" disabled={busy} onClick={() => void close()}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy || !draft || !snapshot}
              onClick={() => void save()}
            >
              保存设置
            </button>
          </div>
        </>
      }
    >
      <section className="template-catalog-dialog__content">
        <div className="template-catalog-dialog__workspace">
          <aside
            ref={sourceStage}
            className="template-catalog-dialog__sources"
            aria-label="模板列表"
          >
            <div className="template-catalog-dialog__sharing">
              <div>
                <strong>发明与实用新型分别设置</strong>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="发明与实用新型分别设置"
                aria-checked={draft?.separatePatentTypes !== false}
                disabled={!draft || busy}
                className="editor-assistance-settings__switch"
                onClick={async () => {
                  if (!draft) return;
                  const separate = draft.separatePatentTypes === false;
                  if (
                    !separate &&
                    !(await confirmAppAction(
                      "关闭后共用发明页的模板。实用新型的模板和当前选择会保留，重新开启后会恢复原来的选择。",
                    ))
                  )
                    return;
                  updateDraft((catalog) => {
                    catalog.separatePatentTypes = separate;
                  });
                  switchPatentType("invention");
                }}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            {
              <SpatialCollapse open={Boolean(draft?.separatePatentTypes !== false)}>
                {draft?.separatePatentTypes !== false ? (
                  <div
                    className="template-catalog-dialog__type-tabs"
                    role="tablist"
                    aria-label="专利类型"
                  >
                    {(["invention", "utility-model"] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        role="tab"
                        aria-selected={patentType === type}
                        onClick={() => switchPatentType(type)}
                      >
                        {TYPE_LABELS[type]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </SpatialCollapse>
            }
            <SourceCard
              title="空白模板"
              selected={selectedSource === "blank"}
              current={currentSource === "blank"}
              onSelect={() => selectSource("blank")}
              onActivate={() => activateSource("blank")}
            />
            <SourceCard
              title="系统默认模板"
              selected={selectedSource === "system"}
              current={currentSource === "system"}
              onSelect={() => selectSource("system")}
              onActivate={() => activateSource("system")}
            />
            {visibleSlots.map((slot) => (
              <article
                key={slot.templateId}
                className={`template-catalog-card${selectedSource === slot.templateId ? " is-selected" : ""}${currentSource === slot.templateId ? " is-current" : ""}`}
              >
                <SpatialView viewKey={String(renamingId === slot.templateId)}>
                  {renamingId === slot.templateId ? (
                    <div className="template-catalog-card__select">
                      <div className="template-catalog-card__heading">
                        <input
                          aria-label={`重命名${slot.name}`}
                          maxLength={PATENT_TEMPLATE_NAME_MAX_LENGTH}
                          value={renameValue}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            setRenameValue(event.currentTarget.value);
                          }}
                        />
                        {currentSource === slot.templateId ? (
                          <span className="template-catalog-card__current">当前使用</span>
                        ) : null}
                      </div>
                      <div className="template-catalog-card__rename-actions">
                        <button
                          type="button"
                          disabled={!renameValue.trim()}
                          onClick={() => {
                            updateDraft((catalog) => {
                              const target = catalog[patentType].slots.find(
                                (candidate) => candidate.templateId === slot.templateId,
                              );
                              if (target) target.name = renameValue.trim();
                            });
                            setRenamingId(null);
                          }}
                        >
                          确认
                        </button>
                        <button type="button" onClick={() => setRenamingId(null)}>
                          取消
                        </button>
                      </div>
                      {slot.unavailableReason ? (
                        <span role="alert">{slot.unavailableReason}</span>
                      ) : null}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="template-catalog-card__select"
                      aria-pressed={selectedSource === slot.templateId}
                      onClick={() => selectSource(slot.templateId)}
                    >
                      <span className="template-catalog-card__heading">
                        <strong>{slot.name}</strong>
                        {currentSource === slot.templateId ? (
                          <span className="template-catalog-card__current">当前使用</span>
                        ) : null}
                      </span>
                      {slot.unavailableReason ? (
                        <span role="alert">{slot.unavailableReason}</span>
                      ) : null}
                    </button>
                  )}
                </SpatialView>
                <div className="template-catalog-card__footer-actions">
                  {currentSource !== slot.templateId && isFilledPatentTemplateSlot(slot) ? (
                    <button
                      type="button"
                      className="template-catalog-card__activate"
                      onClick={() => activateSource(slot.templateId)}
                    >
                      设为当前模板
                    </button>
                  ) : null}
                  <TemplateCardActionsMenu
                    templateName={slot.name}
                    busy={busy}
                    canFill={Boolean(prepareCurrentPatent)}
                    canDelete={isFilledPatentTemplateSlot(slot) || slot.unavailableReason !== null}
                    renaming={renamingId === slot.templateId}
                    onFill={() => void fillCurrent(slot)}
                    onRename={() => {
                      setRenameValue(slot.name);
                      setRenamingId(slot.templateId);
                    }}
                    onDelete={() => void deleteSlot(slot)}
                  />
                </div>
              </article>
            ))}
            {nextSlot ? (
              <button
                type="button"
                className="template-catalog-dialog__add"
                aria-label="新建自定义模板"
                disabled={busy || !draft}
                onClick={addCustomTemplate}
              >
                <Plus aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>新建自定义模板</span>
              </button>
            ) : null}
          </aside>
          <main className="template-catalog-dialog__editor">
            <div ref={headerStage} className="template-catalog-dialog__editor-header">
              <div>
                <h3>
                  {selectedSource === "blank"
                    ? "空白模板"
                    : selectedSource === "system"
                      ? `${TYPE_LABELS[patentType]}系统模板`
                      : (selectedSlot?.name ?? "自定义模板")}
                </h3>
              </div>
              <button
                type="button"
                className="primary-button template-catalog-dialog__fill-current"
                disabled={!selectedSlot || busy || !prepareCurrentPatent}
                onClick={() => void fillCurrent(selectedSlot)}
              >
                填入当前文档内容
              </button>
              <SpatialPresence>
                {selectedSource !== "blank" ? (
                  <div
                    className="template-catalog-dialog__book-tabs"
                    role="tablist"
                    aria-label="三书"
                  >
                    {(Object.keys(BOOK_LABELS) as TextBookKind[]).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        role="tab"
                        aria-selected={bookKind === kind}
                        onClick={() => setBookKind(kind)}
                      >
                        {BOOK_LABELS[kind]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </SpatialPresence>
            </div>
            <div className="template-catalog-dialog__editor-content">
              <TemplateViewTransition
                viewKey={`${Boolean(snapshot && draft && auxiliaryDraft)}:${patentType}:${selectedSource}:${bookKind}:${selectedSlot?.unavailableReason ?? ""}`}
              >
                {!snapshot || !draft || !auxiliaryDraft ? (
                  <p className="template-catalog-dialog__empty">正在加载模板…</p>
                ) : selectedSource === "blank" ? (
                  <div className="template-catalog-dialog__empty" />
                ) : selectedSource === "system" && selectedTemplate ? (
                  <TemplateBookEditor
                    key={`system:${patentType}:${bookKind}`}
                    sessionId={snapshot.sessionId}
                    bookKind={bookKind}
                    template={selectedTemplate}
                    assetDescriptors={templateAssets}
                    readOnly
                    onChange={() => undefined}
                  />
                ) : selectedSlot && isFilledPatentTemplateSlot(selectedSlot) && selectedTemplate ? (
                  <TemplateBookEditor
                    key={`${snapshot.sessionId}:${selectedSlot.templateId}:${bookKind}`}
                    sessionId={snapshot.sessionId}
                    bookKind={bookKind}
                    template={selectedTemplate}
                    assetDescriptors={templateAssets}
                    onAssetAdded={(descriptor) =>
                      setTemplateAssets((current) => mergeAssetDescriptors(current, [descriptor]))
                    }
                    onChange={(template) =>
                      updateDraft((catalog) => {
                        const target = catalog[patentType].slots.find(
                          (candidate) => candidate.templateId === selectedSlot.templateId,
                        );
                        if (target) target[bookKind] = template;
                      })
                    }
                  />
                ) : selectedSlot?.unavailableReason ? (
                  <div className="template-catalog-dialog__empty template-catalog-dialog__empty--warning">
                    <strong>此模板暂时无法读取</strong>
                    <p>{selectedSlot.unavailableReason}</p>
                    <p>可删除此模板后重新创建，或填入当前文档内容进行恢复。</p>
                  </div>
                ) : (
                  <div className="template-catalog-dialog__empty">
                    <p>这个模板位还没有内容。</p>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!prepareCurrentPatent || busy}
                      onClick={() => void fillCurrent(selectedSlot)}
                    >
                      填入当前文档内容
                    </button>
                  </div>
                )}
              </TemplateViewTransition>
            </div>
          </main>
        </div>
        {
          <MotionPresence>
            {pendingExit ? (
              <StandardDialog
                open
                title="模板修改尚未保存"
                size="s"
                dialogRole="alertdialog"
                onCancel={() => {
                  const pending = pendingExit;
                  setPendingExit(null);
                  pending.resolve("continue");
                }}
                footer={
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        const pending = pendingExit;
                        setPendingExit(null);
                        pending.resolve("continue");
                      }}
                    >
                      继续编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const pending = pendingExit;
                        setPendingExit(null);
                        pending.resolve("discard");
                      }}
                    >
                      放弃修改
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => {
                        const pending = pendingExit;
                        setPendingExit(null);
                        pending.resolve("save");
                      }}
                    >
                      保存并退出
                    </button>
                  </>
                }
              >
                <p>您可以保存后退出、放弃本次修改，或继续编辑。</p>
              </StandardDialog>
            ) : null}
          </MotionPresence>
        }
      </section>
    </StandardDialog>
  );
}

function SourceCard({
  title,
  selected,
  current,
  onSelect,
  onActivate,
}: {
  title: string;
  selected: boolean;
  current: boolean;
  onSelect(): void;
  onActivate?(): void;
}) {
  return (
    <article
      className={`template-catalog-card template-catalog-card--simple${selected ? " is-selected" : ""}${current ? " is-current" : ""}`}
    >
      <button
        type="button"
        className="template-catalog-card__select"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="template-catalog-card__heading">
          <strong>{title}</strong>
          {current ? <span className="template-catalog-card__current">当前使用</span> : null}
        </span>
      </button>
      {onActivate && !current ? (
        <button type="button" className="template-catalog-card__activate" onClick={onActivate}>
          设为当前模板
        </button>
      ) : null}
    </article>
  );
}

function TemplateCardActionsMenu({
  templateName,
  busy,
  canFill,
  canDelete,
  renaming,
  onFill,
  onRename,
  onDelete,
}: {
  templateName: string;
  busy: boolean;
  canFill: boolean;
  canDelete: boolean;
  renaming: boolean;
  onFill(): void;
  onRename(): void;
  onDelete(): void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  if (renaming) return null;

  return (
    <div className="template-catalog-card__overflow" ref={containerRef}>
      <button
        type="button"
        className="template-catalog-card__overflow-trigger"
        aria-label={`${templateName}更多操作`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      <SpatialPresence>
        {open ? (
          <div
            className="template-catalog-card__overflow-menu"
            role="menu"
            aria-label={`${templateName}操作`}
          >
            <button
              type="button"
              role="menuitem"
              disabled={busy || !canFill}
              onClick={() => run(onFill)}
            >
              填入当前文档内容
            </button>
            <button type="button" role="menuitem" onClick={() => run(onRename)}>
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canDelete}
              onClick={() => run(onDelete)}
            >
              删除
            </button>
          </div>
        ) : null}
      </SpatialPresence>
    </div>
  );
}

function mergeAssetDescriptors(
  current: readonly AssetDescriptor[],
  incoming: readonly AssetDescriptor[],
): AssetDescriptor[] {
  const byId = new Map(current.map((descriptor) => [descriptor.assetId, descriptor]));
  for (const descriptor of incoming) byId.set(descriptor.assetId, descriptor);
  return [...byId.values()];
}

function sourceKey(selection: PatentTemplateCatalog[PatentType]["selection"]): string {
  return selection.kind === "custom" ? selection.templateId : selection.kind;
}

function selectionLabel(summary: PatentTemplateLauncherSummary | null, type: PatentType): string {
  if (!summary) return "暂时无法读取";
  const selection = summary[type].selection;
  if (selection.kind === "blank") return "空白模板";
  if (selection.kind === "system") return "系统默认模板";
  return summary[type].selectedTemplateName ?? "自定义模板";
}

function toLauncherSummary(catalog: PatentTemplateCatalog): PatentTemplateLauncherSummary {
  const group = (patentType: PatentType): PatentTemplateLauncherSummary[PatentType] => {
    const selection = catalog[patentType].selection;
    if (selection.kind !== "custom") return { selection, selectedTemplateName: null };
    const selected = catalog[patentType].slots.find(
      (slot) => slot.templateId === selection.templateId,
    );
    return { selection, selectedTemplateName: selected?.name ?? "自定义模板" };
  };
  return {
    ...(catalog.separatePatentTypes !== undefined
      ? { separatePatentTypes: catalog.separatePatentTypes }
      : {}),
    invention: group("invention"),
    "utility-model": group(catalog.separatePatentTypes === false ? "invention" : "utility-model"),
  };
}
