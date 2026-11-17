import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { MotionPresence } from "../app/motion-presence";
import { StandardDialog } from "../shared/standard-dialog";

type Draft = { label: string; dirty: boolean; save(): Promise<boolean>; discard(): void };
export type SettingsCloseRegistrar = {
  registerCloseGuard(id: string, guard: () => Promise<boolean>): () => void;
};
const DraftContext = createContext<Map<symbol, { current: Draft }> | null>(null);
const CloseContext = createContext<() => void>(() => {});

export function useSettingsDraft(draft: Draft) {
  const registry = useContext(DraftContext);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    const id = Symbol();
    registry?.set(id, latest);
    return () => {
      registry?.delete(id);
    };
  }, [registry]);
}

export function useSettingsClose() {
  return useContext(CloseContext);
}

export function SettingsDraftProvider({
  children,
  onClose,
  closeGuardRegistrar,
}: {
  children: ReactNode;
  onClose(): void;
  closeGuardRegistrar?: SettingsCloseRegistrar;
}) {
  const registry = useRef(new Map<symbol, { current: Draft }>());
  const [pending, setPending] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completion = useRef<((proceed: boolean) => void) | null>(null);
  const request = useCallback((finish: (proceed: boolean) => void) => {
    if (completion.current) {
      finish(false);
      return;
    }
    const dirty = [...registry.current.values()]
      .map((item) => item.current)
      .filter((item) => item.dirty);
    if (!dirty.length) {
      finish(true);
      return;
    }
    completion.current = finish;
    setError(null);
    setPending(dirty);
  }, []);
  const finish = (proceed: boolean) => {
    const callback = completion.current;
    completion.current = null;
    setPending(null);
    callback?.(proceed);
  };
  useEffect(
    () =>
      closeGuardRegistrar?.registerCloseGuard(
        "settings-drafts",
        () => new Promise<boolean>((resolve) => request(resolve)),
      ),
    [closeGuardRegistrar, request],
  );
  useEffect(
    () => () => {
      completion.current?.(false);
      completion.current = null;
    },
    [],
  );
  const close = () =>
    request((proceed) => {
      if (proceed) onClose();
    });
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      for (const draft of pending ?? []) {
        if (!(await draft.save())) {
          setError(`“${draft.label}”未保存，请继续编辑并检查设置。`);
          return;
        }
      }
      finish(true);
    } catch {
      setError("保存失败，修改仍然保留，请重试或继续编辑。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <DraftContext.Provider value={registry.current}>
      <CloseContext.Provider value={close}>
        <div className="settings-draft-boundary" inert={pending !== null}>
          {children}
        </div>
        <MotionPresence>
          {pending !== null ? (
            <StandardDialog
              open
              title="未保存设置"
              size="s"
              onCancel={() => finish(false)}
              closeDisabled={busy}
              footer={
                <>
                  <button type="button" disabled={busy} onClick={() => finish(false)}>
                    继续编辑
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      for (const draft of pending) draft.discard();
                      finish(true);
                    }}
                  >
                    放弃修改
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void save()}
                  >
                    {busy ? "保存中…" : "保存并关闭"}
                  </button>
                </>
              }
            >
              <p>以下设置有未保存的修改：{pending.map((draft) => draft.label).join("、")}。</p>
              {error ? <p role="alert">{error}</p> : null}
            </StandardDialog>
          ) : null}
        </MotionPresence>
      </CloseContext.Provider>
    </DraftContext.Provider>
  );
}
