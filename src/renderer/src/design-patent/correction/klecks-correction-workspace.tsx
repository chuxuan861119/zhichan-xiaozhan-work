import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isAssignedDesignView } from "../../../../shared/patent/design-patent";
import type { AutoTrimOptions } from "../../../../shared/settings/design-auto-trim";
import { usePatents } from "../../patents/patent-context";
import type { PatentSession } from "../../patents/patent-reducer";
import { SixViewPreview } from "../six-view-preview";
import { activateKlecksView } from "./klecks-activate-view";
import type { KlecksCaseDocuments } from "./klecks-case-documents";
import { KlecksEditorPanels } from "./klecks-editor-panels";
import type { KlecksFrameClient } from "./klecks-frame-client";
import { KlecksIdleRecovery } from "./klecks-idle-recovery";
import { bindKlecksPreferences } from "./klecks-preferences-binding";
import { createSharedKlecksFrame } from "./klecks-shared-frame";
import type { KlecksEditorState } from "./klecks-state-port";
import { useKlecksTemporaryImages } from "./use-klecks-temporary-images";

/** Its parent retains this workspace while switching steps, cases and the library. */
export function KlecksCorrectionWorkspace({
  session,
  onAddImages,
  initialViewId,
  autoTrimDefaults,
  active = true,
}: {
  session: PatentSession;
  onAddImages(): void;
  initialViewId?: string | undefined;
  autoTrimDefaults?: AutoTrimOptions | undefined;
  active?: boolean;
}) {
  const patents = usePatents();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<KlecksFrameClient | null>(null),
    [state, setState] = useState<KlecksEditorState | null>(null);
  const [preferencesReady, setPreferencesReady] = useState(false),
    [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [controller, setController] = useState<KlecksCaseDocuments | null>(null),
    [, changed] = useState(0),
    [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  const currentController = useRef(controller);
  currentController.current = controller;
  const attach = patents.attachDesignEditorFrame,
    release = patents.releaseDesignEditorFrame;
  const checkpoint = patents.checkpointDesignEditor,
    idleRecovery = useRef<KlecksIdleRecovery | null>(null),
    [recoveryError, setRecoveryError] = useState<string | null>(null);
  const hasImages = session.patent.designPatent?.views.some(isAssignedDesignView) ?? false;
  const [temporaryStart, setTemporaryStart] = useState(false);
  const temporary = useKlecksTemporaryImages(controller, frame, () => setTemporaryStart(true));
  // Once initialized, retain the empty frame too; removing the last picture is handled by document sync.
  const initialized = useRef(false);
  if (hasImages || temporaryStart) initialized.current = true;
  const start = initialized.current;
  const hasContainer = !!container;
  const ownerRef = useRef<ReturnType<typeof createSharedKlecksFrame> | null>(null);
  const bindContainer = useCallback((node: HTMLDivElement | null) => {
    if (!node) ownerRef.current?.park();
    setContainer(node);
  }, []);
  const activeRef = useRef(active);
  activeRef.current = active;
  const initialRequest = useRef<{ controller: KlecksCaseDocuments | null; id: string | undefined }>(
    { controller: null, id: undefined },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry or container availability starts the owner; container replacement moves the retained frame below.
  useEffect(() => {
    if (!start || !container) return;
    let live = true,
      client: KlecksFrameClient | null = null;
    setError(null);
    setFrame(null);
    setController(null);
    setState(null);
    setPreferencesReady(false);
    setPreferencesError(null);
    const owner = createSharedKlecksFrame({
      active: activeRef.current,
      container,
      sessionId: session.sessionId,
      platform: /Mac/i.test(navigator.platform)
        ? "mac"
        : /Harmony|OpenHarmony/i.test(navigator.userAgent)
          ? "harmony"
          : "windows",
      api: window.patentApi.assets,
      connected: (value) => {
        client = value;
        const preferences = bindKlecksPreferences(value, window.patentApi.settings, {
          ready: () => {
            if (live) setPreferencesReady(true);
          },
          error: (message) => {
            if (live) setPreferencesError(message);
          },
        });
        const binding = attach(session.patentId, value, () => {
          if (live) changed((n) => n + 1);
        });
        const recovery = new KlecksIdleRecovery({
          shouldTrack: (identity) => !binding.controller.isTemporary(identity.viewId),
          save: (targets) => checkpoint(session.patentId, targets),
          error: (failure) => {
            if (live)
              setRecoveryError(
                typeof failure === "object" && failure !== null && "message" in failure
                  ? String(failure.message)
                  : "自动恢复检查点未保存，编辑仍保留在内存中。",
              );
          },
          saved: () => {
            if (live) setRecoveryError(null);
          },
        });
        idleRecovery.current = recovery;
        const unsubscribe = value.state.subscribe((snapshot) => {
          if (live) {
            setState(snapshot);
            recovery.notify(snapshot);
          }
        });
        if (live) {
          setFrame(value);
          setController(binding.controller);
        }
        return () => {
          preferences();
          recovery.dispose();
          if (idleRecovery.current === recovery) idleRecovery.current = null;
          unsubscribe();
          binding.unsubscribe();
          release(session.patentId, value);
        };
      },
    });
    ownerRef.current = owner;
    void owner.ready.catch((failure) => {
      if (live) setError(failure instanceof Error ? failure.message : "图片编辑器启动失败。");
    });
    return () => {
      live = false;
      if (ownerRef.current === owner) ownerRef.current = null;
      if (client) release(session.patentId, client);
      void owner
        .dispose()
        .catch((failure) => console.error("Editor resource release failed", failure));
    };
  }, [
    session.patentId,
    session.sessionId,
    attach,
    release,
    checkpoint,
    start,
    attempt,
    hasContainer,
  ]);
  useEffect(() => {
    if (container) ownerRef.current?.setContainer(container);
  }, [container]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The frame snapshot only guards an activation requested by the case or view, not by frame publication.
  useEffect(() => {
    let live = true;
    try {
      ownerRef.current?.setActive(active);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "案件切换未完成，原编辑内容仍保留。");
      return;
    }
    const explicit =
      initialRequest.current.controller !== controller ||
      initialRequest.current.id !== initialViewId;
    const target =
      (explicit ? initialViewId : null) ??
      controller?.snapshot().activeId ??
      initialViewId ??
      controller?.snapshot().ids[0];
    if (active) initialRequest.current = { controller, id: initialViewId };
    const retained = frame?.state.snapshot();
    if (
      active &&
      retained &&
      target === retained.activeId &&
      (retained.pending || retained.locked)
    ) {
      setError(null);
      return;
    }
    if (active && controller && target)
      void controller
        .activate(target)
        .then((opened) => {
          if (live && opened) setError(null);
        })
        .catch((failure) => {
          if (live) setError(failure instanceof Error ? failure.message : "图片加载失败。");
        });
    return () => {
      live = false;
    };
  }, [active, controller, initialViewId]);
  const snapshot = controller?.snapshot(),
    documents = [
      ...(session.patent.designPatent?.views.filter(isAssignedDesignView).map((view) => ({
        viewId: view.viewId,
        label: view.label,
        name:
          session.patent.assets.find((asset) => asset.assetId === view.assetId)?.originalName ??
          view.label,
      })) ?? []),
      ...(controller?.temporaryDocuments().map((item) => ({
        ...item,
        label: "临时图片",
        temporary: true,
        dirty: temporary.dirty(item.viewId),
      })) ?? []),
    ];
  const activateView = (id: string, fit = false) => {
    if (!controller) return;
    const selectedController = controller;
    setError(null);
    void activateKlecksView(
      selectedController,
      frame,
      id,
      () => currentController.current === selectedController,
      fit,
    ).catch((failure) => {
      if (currentController.current === selectedController)
        setError(failure instanceof Error ? failure.message : "图片加载失败。");
    });
  };
  const previewHost = frame?.canvasOverlayHost ?? container?.closest(".klecks-panels__canvas");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: This wrapper delegates file drops; the import button is the keyboard-accessible alternative.
    <div
      style={{ display: "contents" }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          event.stopPropagation();
          temporary.importFiles(Array.from(event.dataTransfer.files));
        }
      }}
    >
      {temporary.dialogs}
      {preferencesError ? <p role="status">{preferencesError}</p> : null}
      {error ? (
        <p role="alert">
          {error}{" "}
          {frame ? (
            <button
              type="button"
              onClick={() => {
                const id = snapshot?.requestedId ?? state?.activeId;
                if (id)
                  void controller
                    ?.activate(id)
                    .then(() => setError(null))
                    .catch(() => {});
              }}
            >
              重试当前图片
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setFrame(null);
                setController(null);
                setState(null);
                setAttempt((n) => n + 1);
              }}
            >
              重试加载
            </button>
          )}
        </p>
      ) : null}
      {recoveryError ? (
        <p role="alert">
          恢复检查点未保存：{recoveryError}{" "}
          <button
            type="button"
            disabled={!!state?.pending}
            onClick={() => void idleRecovery.current?.retry()}
          >
            重试检查点
          </button>
        </p>
      ) : null}
      <KlecksEditorPanels
        autoTrimDefaults={autoTrimDefaults}
        notice={
          temporary.busy || temporary.message ? (
            <div className="klecks-temporary-message">
              {temporary.busy && !temporary.batchActive ? (
                <span role="status">正在处理临时图片…</span>
              ) : temporary.message ? (
                <details>
                  <summary title={temporary.message}>
                    <span role="status">{temporary.message}</span>
                  </summary>
                  <div>{temporary.message}</div>
                </details>
              ) : null}
              {temporary.batchActive ? (
                <button
                  type="button"
                  disabled={temporary.batchCancelRequested}
                  onClick={temporary.cancelBatch}
                >
                  {temporary.batchCancelRequested ? "正在停止…" : "停止批量导出"}
                </button>
              ) : null}
            </div>
          ) : null
        }
        frame={frame}
        state={state}
        documents={documents}
        canvas={<div ref={bindContainer} style={{ width: "100%", height: "100%", minHeight: 0 }} />}
        onActivate={activateView}
        onAddImages={onAddImages}
        temporaryFiles={{
          busy: temporary.busy,
          active: !!state?.activeId && !!controller?.isTemporary(state.activeId),
          import: temporary.chooseImport,
          export: () => {
            if (state?.activeId) void temporary.exportOne(state.activeId);
          },
          exportAll: () => {
            void temporary.exportAll();
          },
          close: (id) => {
            void temporary.closeOne(id);
          },
        }}
        onSave={() =>
          state?.identity && controller?.isTemporary(state.identity.viewId)
            ? controller.saveTemporary(state.identity)
            : patents.saveDesignEditorEdits(
                session.patentId,
                state?.activeId ? [state.activeId] : [],
              )
        }
        {...(state?.activeId && controller?.isTemporary(state.activeId)
          ? {}
          : {
              onApply: () =>
                patents.applyDesignEditorImages(
                  session.patentId,
                  state?.activeId ? [state.activeId] : [],
                ),
            })}
        onApplyAll={() => patents.applyDesignEditorImages(session.patentId)}
        onFocusCanvas={() => {
          const identity = frame?.state.snapshot()?.identity;
          if (identity) void frame?.tools.send(identity, { action: "focus" }).catch(() => {});
        }}
        loadingId={
          snapshot?.loadingId ??
          (frame && hasImages && !preferencesReady ? "tool-preferences" : null) ??
          (!frame && start && !error ? "starting" : null)
        }
        loadError={
          snapshot?.syncError ??
          (snapshot?.requestedId ? (snapshot.errors[snapshot.requestedId] ?? null) : null)
        }
      />
      {active &&
      previewHost &&
      session.patent.designPatent?.imageMode !== "multi-image" &&
      !(state?.activeId && controller?.isTemporary(state.activeId))
        ? createPortal(
            <div className="six-view-canvas-overlay">
              <SixViewPreview
                activeViewId={state?.activeId ?? null}
                onActivate={(id) => activateView(id, true)}
              />
            </div>,
            previewHost,
          )
        : null}
    </div>
  );
}
