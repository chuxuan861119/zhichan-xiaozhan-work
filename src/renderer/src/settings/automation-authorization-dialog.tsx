import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AutomationScope,
  AutomationUiRequest,
  AutomationUiState,
} from "../../../shared/automation/protocol";
import { AUTOMATION_CREATE_BATCH } from "../../../shared/automation/protocol";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { useApplicationClosing } from "../app/application-close-coordinator";
import { StandardDialog } from "../shared/standard-dialog";
import { useRetainedTransientVisibility } from "../shared/transient-function-rail-slot";
import {
  AuthorizationNotice,
  AuthorizationPatentPicker,
  AuthorizationScopeEditor,
  CreationPermissionRequest,
} from "./authorization-scope-editor";
import { listAuthorizationPatents } from "./automation-patent-list";
import "./automation-authorization-dialog.css";

let activeModal: HTMLDialogElement | null = null;

/** Install before the workbench mounts: its window capture shortcuts must not run behind this modal. */
export function installAuthorizationKeyboardGuard() {
  const guard = (event: KeyboardEvent) => {
    if (!activeModal?.open) return;
    event.stopImmediatePropagation();
    const key = event.key.toLowerCase();
    if ((event.metaKey && (key === "q" || key === "w")) || (event.altKey && key === "f4")) {
      event.preventDefault();
      window.close();
      return;
    }
    // Retain native text editing and focus navigation, but never dispatch app shortcuts.
    if (
      key === "escape" ||
      /^f\d+$/u.test(key) ||
      ((event.ctrlKey || event.metaKey) &&
        !["a", "c", "v", "x", "z", "y", "arrowleft", "arrowright", "home", "end"].includes(key))
    )
      event.preventDefault();
  };
  const blockDrop = (event: Event) => {
    if (!activeModal?.open) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", guard, true);
  window.addEventListener("drop", blockDrop, true);
  window.addEventListener("dragover", blockDrop, true);
  return () => {
    window.removeEventListener("keydown", guard, true);
    window.removeEventListener("drop", blockDrop, true);
    window.removeEventListener("dragover", blockDrop, true);
  };
}

export function AutomationAuthorizationDialog() {
  const [state, setState] = useState<AutomationUiState | null>(null);
  const [patents, setPatents] = useState<LibraryPatentSummary[] | null>(null);
  const [error, setError] = useState("");
  const version = useRef(0);
  // Pair IDs are never reused. A confirmed decision must win over late status snapshots.
  const resolvedPairs = useRef(new Set<string>());
  const resolvePair = useCallback((pairId: string) => {
    resolvedPairs.current.add(pairId);
    setState((current) =>
      current
        ? {
            ...current,
            pendingPairs: current.pendingPairs.filter((pair) => pair.pairId !== pairId),
          }
        : current,
    );
  }, []);
  const closing = useApplicationClosing();
  const refresh = useCallback(async () => {
    const generation = ++version.current;
    try {
      const result = await window.patentApi.automation?.control({ action: "status" });
      if (generation !== version.current) return;
      if (!result?.ok) throw new Error("status");
      const next = result.value as AutomationUiState;
      setState({
        ...next,
        pendingPairs: next.pendingPairs.filter((pair) => !resolvedPairs.current.has(pair.pairId)),
      });
      if (!next.enabled || !next.pendingPairs.length) {
        setError("");
        return;
      }
      const listed = await listAuthorizationPatents();
      if (generation !== version.current) return;
      setPatents(listed);
      setError("");
    } catch {
      if (generation === version.current) {
        setPatents(null);
        setError("无法读取授权范围，请重试；也可拒绝请求或关闭软件。");
      }
    }
  }, []);
  useEffect(() => {
    if (!window.patentApi.automation) return;
    const unsubscribe = window.patentApi.automation.onEvent((event) => {
      if (event.type === "stateChanged") void refresh();
    });
    void refresh();
    return () => {
      version.current++;
      unsubscribe();
    };
  }, [refresh]);
  const pair = state?.enabled ? state.pendingPairs[0] : undefined;
  const expiresAt = pair?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = window.setTimeout(() => void refresh(), Math.max(0, expiresAt - Date.now()) + 30);
    return () => window.clearTimeout(timer);
  }, [expiresAt, refresh]);
  if (!pair) return null;
  return (
    <AuthorizationRequest
      key={pair.pairId}
      active={!closing}
      pair={pair}
      patents={patents}
      error={error}
      refresh={refresh}
      resolvePair={resolvePair}
    />
  );
}

function AuthorizationRequest({
  active,
  pair,
  patents,
  error,
  refresh,
  resolvePair,
}: {
  active: boolean;
  pair: AutomationUiState["pendingPairs"][number];
  patents: LibraryPatentSummary[] | null;
  error: string;
  refresh(): Promise<void>;
  resolvePair(pairId: string): void;
}) {
  const modal = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<AutomationScope>({
    patents: {},
    createLimit:
      pair.creationRenewal || (pair.requested?.createLimit ?? 0) > 0 ? AUTOMATION_CREATE_BATCH : 0,
    workspace: {},
  });
  const [consent, setConsent] = useState(false);
  const [subpage, setSubpage] = useState<"notice" | "patents" | null>(null);
  const noticeVisible = useRetainedTransientVisibility(active && subpage === "notice");
  const pickerVisible = useRetainedTransientVisibility(active && subpage === "patents");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [actionError, setActionError] = useState("");
  useLayoutEffect(() => {
    const element = modal.current;
    if (!element || !active) return;
    const previous = document.activeElement;
    element.showModal();
    activeModal = element;
    return () => {
      if (activeModal === element) activeModal = null;
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [active]);
  async function run(request: AutomationUiRequest) {
    if (running.current || (request.action === "approvePair" && !consent)) return;
    running.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await window.patentApi.automation?.control(request);
      if (!result?.ok) throw new Error("control");
      if (request.action === "chooseDirectory") {
        if (typeof result.value === "string")
          setScope((current) => ({
            ...current,
            workspace: {
              ...current.workspace,
              [request.kind === "import" ? "importDirectory" : "exportDirectory"]: result.value,
            },
          }));
      } else {
        if (request.action === "approvePair" || request.action === "rejectPair")
          resolvePair(request.pairId);
        await refresh();
      }
    } catch {
      setActionError("操作未完成，请重试。授权范围未扩大。");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={modal}
      className="automation-authorization-shell"
      aria-label="授权锁定层"
      onCancel={(event) => event.preventDefault()}
    >
      <div inert={subpage ? true : undefined}>
        <StandardDialog
          open={active}
          title={`${pair.label}请求操作授权`}
          headerActions={<span className="automation-authorization__connection">本地操作</span>}
          size="m"
          className="automation-authorization"
          dialogRole="alertdialog"
          showClose={false}
          closeDisabled
          onCancel={() => {}}
          footer={
            <>
              <div className="authorization-consent">
                <label>
                  <input
                    type="checkbox"
                    aria-label="我已阅读并同意授权须知"
                    checked={consent}
                    disabled={busy}
                    onChange={(e) => {
                      setConsent(e.target.checked);
                    }}
                  />
                  我已阅读并同意
                </label>
                <button
                  type="button"
                  disabled={busy}
                  className="authorization-text-button"
                  onClick={() => setSubpage("notice")}
                >
                  用户授权须知
                </button>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run({ action: "rejectPair", pairId: pair.pairId })}
              >
                拒绝
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  busy ||
                  patents === null ||
                  !!error ||
                  !consent ||
                  (pair.creationRenewal && !scope.createLimit)
                }
                onClick={() => void run({ action: "approvePair", pairId: pair.pairId, scope })}
              >
                授权
              </button>
            </>
          }
        >
          {error || actionError ? <p role="alert">{error || actionError}</p> : null}
          {error ? (
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              重试
            </button>
          ) : null}
          <fieldset disabled={busy || patents === null}>
            {patents ? (
              pair.creationRenewal ? (
                <div className="authorization-scope">
                  <CreationPermissionRequest />
                </div>
              ) : (
                <AuthorizationScopeEditor
                  scope={scope}
                  patents={patents}
                  requested={pair.requested}
                  onChange={setScope}
                  onChoosePatents={() => setSubpage("patents")}
                />
              )
            ) : (
              <p>正在读取专利列表…</p>
            )}
          </fieldset>
        </StandardDialog>
      </div>
      {noticeVisible ? (
        <AuthorizationNotice
          open={active && subpage === "notice"}
          agreed={consent}
          onCancel={() => setSubpage(null)}
          onAgree={() => {
            setConsent(true);
            setSubpage(null);
          }}
        />
      ) : null}
      {pickerVisible && patents ? (
        <AuthorizationPatentPicker
          open={active && subpage === "patents"}
          patents={patents}
          selected={scope.patents}
          requested={pair.requested}
          onCancel={() => setSubpage(null)}
          onConfirm={(selected) => {
            setScope({ ...scope, patents: selected });
            setSubpage(null);
          }}
        />
      ) : null}
    </dialog>,
    document.body,
  );
}
