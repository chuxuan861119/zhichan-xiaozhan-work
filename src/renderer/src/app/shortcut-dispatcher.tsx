import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { ignoreApplicationKeyEvent } from "../../../shared/platform";
import {
  type ConfigurableShortcutActionId,
  normalizeShortcutInput,
  type ShortcutSettings,
  shortcutConflicts,
  shortcutMatchesInput,
} from "../../../shared/settings/shortcuts";
import { hasVisibleElement } from "../shared/focusable-elements";

type ShortcutHandler = () => boolean;

type ShortcutRegistry = {
  register(actionId: ConfigurableShortcutActionId, handler: ShortcutHandler): () => void;
  shortcutFor(actionId: ConfigurableShortcutActionId): string | null;
};

const ShortcutContext = createContext<ShortcutRegistry | null>(null);

function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || ignoreApplicationKeyEvent(event)) return true;
  if (hasVisibleElement("[role='dialog'][aria-modal='true']")) return true;
  if (!(event.target instanceof Element)) return false;
  if (event.target.closest("input, textarea, select, math-field, [data-shortcut-input]"))
    return true;
  const editable = event.target.closest("[contenteditable='true']");
  return editable !== null && !editable.classList.contains("patent-prosemirror");
}

export function ShortcutProvider({
  children,
  settings,
}: PropsWithChildren<{ settings: ShortcutSettings }>): ReactNode {
  const handlers = useRef(new Map<ConfigurableShortcutActionId, ShortcutHandler>());
  const registry = useMemo<ShortcutRegistry>(
    () => ({
      register(actionId, handler) {
        handlers.current.set(actionId, handler);
        return () => {
          if (handlers.current.get(actionId) === handler) handlers.current.delete(actionId);
        };
      },
      shortcutFor(actionId) {
        const shortcut = settings[actionId] ?? null;
        return shortcutConflicts(settings, actionId, shortcut) ? null : shortcut;
      },
    }),
    [settings],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      const normalized = normalizeShortcutInput(event);
      if (!normalized.ok) return;
      const actionId = [...handlers.current.keys()].find((candidateId) => {
        const shortcut = settings[candidateId];
        return shortcut !== null && shortcut !== undefined && shortcutMatchesInput(shortcut, event);
      });
      if (!actionId) return;
      // Preserve old settings, but let built-in commands own conflicting keys.
      if (shortcutConflicts(settings, actionId, settings[actionId] ?? null)) return;
      const handler = handlers.current.get(actionId);
      if (!handler?.()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [settings]);

  return <ShortcutContext.Provider value={registry}>{children}</ShortcutContext.Provider>;
}

export function useConfiguredShortcut(actionId: ConfigurableShortcutActionId): string | null {
  return useContext(ShortcutContext)?.shortcutFor(actionId) ?? null;
}

export function useShortcutAction(
  actionId: ConfigurableShortcutActionId,
  enabled: boolean,
  handler: ShortcutHandler,
): void {
  const registry = useContext(ShortcutContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!registry || !enabled) return;
    return registry.register(actionId, () => handlerRef.current());
  }, [actionId, enabled, registry]);
}
