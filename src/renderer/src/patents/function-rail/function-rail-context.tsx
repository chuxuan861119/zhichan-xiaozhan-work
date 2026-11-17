import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type FunctionRailPresentation,
  type FunctionRailSpace,
  type FunctionRailUserIntent,
  resolveFunctionRailPresentation,
} from "./function-rail-state";

export type PatentFunctionRailController = Readonly<{
  scopeKey: string;
  scopeElement: HTMLElement | null;
  edgeHostElement: HTMLElement | null;
  space: FunctionRailSpace;
  userIntent: FunctionRailUserIntent;
  presentation: FunctionRailPresentation;
  setSpace(space: FunctionRailSpace): void;
  setHovered(active: boolean): void;
  setInteractionActive(active: boolean): void;
  pin(): void;
  collapse(): void;
  releasePin(): void;
  requestTool(toolId: string): () => void;
}>;

type PatentFunctionRailScopeProps = Readonly<{
  scopeKey: string;
  externalToolIds?: readonly string[];
  initialSpace?: FunctionRailSpace;
  /** 作用域初始意图；需要默认展开并钉住的常驻工具使用 "pinned"。 */
  initialUserIntent?: FunctionRailUserIntent;
  /** Only explicit pin/collapse actions are persisted; responsive layout changes are not. */
  userIntentStorageKey?: string;
  children: ReactNode;
}>;

const FunctionRailContext = createContext<PatentFunctionRailController | null>(null);

export function PatentFunctionRailScope({
  scopeKey,
  externalToolIds = [],
  initialSpace = "constrained",
  initialUserIntent = "auto",
  userIntentStorageKey,
  children,
}: PatentFunctionRailScopeProps) {
  const [scopeElement, setScopeElement] = useState<HTMLElement | null>(null);
  const [edgeHostElement, setEdgeHostElement] = useState<HTMLElement | null>(null);
  const [space, setSpace] = useState<FunctionRailSpace>(initialSpace);
  const [userIntent, setUserIntent] = useState<FunctionRailUserIntent>(() => {
    if (userIntentStorageKey) {
      try {
        const stored = window.localStorage.getItem(userIntentStorageKey);
        if (stored === "pinned" || stored === "auto" || stored === "collapsed") return stored;
      } catch {
        // Storage restrictions must not prevent opening the workspace.
      }
    }
    return initialUserIntent;
  });
  const [hovered, setHovered] = useState(false);
  const latestSpace = useRef(space);
  const latestUserIntent = useRef(userIntent);
  latestSpace.current = space;
  latestUserIntent.current = userIntent;
  const [interactionActive, setInteractionActiveState] = useState(false);
  const [localToolRequestCount, setLocalToolRequestCount] = useState(0);
  const localToolRequests = useRef(new Set<symbol>());
  const mounted = useRef(true);
  const focusInteraction = useRef(false);
  const focusInteractionTarget = useRef<Element | null>(null);
  const pointerInteraction = useRef(false);
  const pointerInteractionTarget = useRef<Element | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      localToolRequests.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!scopeElement) return undefined;
    let focusReleaseFrame: number | null = null;
    const belongsToScope = (candidate: EventTarget | null): boolean => {
      if (!(candidate instanceof Element)) return false;
      const rail = candidate.closest(".patent-global-function-rail");
      if (rail && scopeElement.contains(rail)) return true;
      const owner = candidate.closest("[data-function-rail-owner]");
      return owner?.getAttribute("data-function-rail-owner") === scopeKey;
    };
    const updateInteraction = () => {
      setInteractionActiveState(focusInteraction.current || pointerInteraction.current);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (focusReleaseFrame !== null) cancelAnimationFrame(focusReleaseFrame);
      focusReleaseFrame = null;
      focusInteraction.current = belongsToScope(event.target);
      focusInteractionTarget.current =
        focusInteraction.current && event.target instanceof Element ? event.target : null;
      updateInteraction();
    };
    const handleFocusOut = () => {
      if (focusReleaseFrame !== null) cancelAnimationFrame(focusReleaseFrame);
      focusReleaseFrame = requestAnimationFrame(() => {
        focusReleaseFrame = null;
        focusInteraction.current = belongsToScope(document.activeElement);
        focusInteractionTarget.current = focusInteraction.current ? document.activeElement : null;
        updateInteraction();
      });
    };
    const handlePointerOver = (event: PointerEvent) => {
      if (!belongsToScope(event.target) || belongsToScope(event.relatedTarget)) return;
      pointerInteractionTarget.current = event.target instanceof Element ? event.target : null;
      pointerInteraction.current = true;
      updateInteraction();
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (!belongsToScope(event.target) || belongsToScope(event.relatedTarget)) return;
      pointerInteractionTarget.current = null;
      pointerInteraction.current = false;
      updateInteraction();
    };
    const releaseDetachedInteractions = () => {
      let released = false;
      if (focusInteractionTarget.current?.isConnected === false) {
        focusInteractionTarget.current = null;
        focusInteraction.current = false;
        released = true;
      }
      if (pointerInteractionTarget.current?.isConnected === false) {
        pointerInteractionTarget.current = null;
        pointerInteraction.current = false;
        released = true;
      }
      if (released) updateInteraction();
    };
    const observer = new MutationObserver(releaseDetachedInteractions);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    return () => {
      if (focusReleaseFrame !== null) cancelAnimationFrame(focusReleaseFrame);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      observer.disconnect();
      focusInteraction.current = false;
      focusInteractionTarget.current = null;
      pointerInteraction.current = false;
      pointerInteractionTarget.current = null;
    };
  }, [scopeElement, scopeKey]);

  const setInteractionActive = useCallback((active: boolean) => {
    if (!active) {
      focusInteraction.current = false;
      focusInteractionTarget.current = null;
      pointerInteraction.current = false;
      pointerInteractionTarget.current = null;
    }
    setInteractionActiveState(active);
  }, []);

  const rememberUserIntent = useCallback(
    (intent: FunctionRailUserIntent) => {
      latestUserIntent.current = intent;
      setUserIntent(intent);
      if (!userIntentStorageKey) return;
      try {
        window.localStorage.setItem(userIntentStorageKey, intent);
      } catch {
        // Keep the current-session choice usable when storage is unavailable.
      }
    },
    [userIntentStorageKey],
  );
  const updateSpace = useCallback(
    (nextSpace: FunctionRailSpace) => {
      const recovered = latestSpace.current === "constrained" && nextSpace === "fits";
      latestSpace.current = nextSpace;
      setSpace(nextSpace);
      if (recovered && latestUserIntent.current === "collapsed") rememberUserIntent("auto");
    },
    [rememberUserIntent],
  );
  const pin = useCallback(() => rememberUserIntent("pinned"), [rememberUserIntent]);
  const collapse = useCallback(() => {
    rememberUserIntent("collapsed");
  }, [rememberUserIntent]);
  const releasePin = useCallback(() => {
    rememberUserIntent("auto");
  }, [rememberUserIntent]);
  const requestTool = useCallback((toolId: string) => {
    const token = Symbol(toolId);
    localToolRequests.current.add(token);
    setLocalToolRequestCount(localToolRequests.current.size);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      if (!localToolRequests.current.delete(token) || !mounted.current) return;
      setLocalToolRequestCount(localToolRequests.current.size);
    };
  }, []);

  const toolRequestCount = externalToolIds.length + localToolRequestCount;

  const presentation = resolveFunctionRailPresentation({
    space,
    userIntent,
    hovered,
    interactionActive,
    toolRequestCount,
    edgeAnchored: space === "constrained" || userIntent === "collapsed",
  });
  const controller = useMemo<PatentFunctionRailController>(
    () => ({
      scopeKey,
      scopeElement,
      edgeHostElement,
      space,
      userIntent,
      presentation,
      setSpace: updateSpace,
      setHovered,
      setInteractionActive,
      pin,
      collapse,
      releasePin,
      requestTool,
    }),
    [
      scopeKey,
      scopeElement,
      edgeHostElement,
      space,
      userIntent,
      presentation,
      updateSpace,
      setInteractionActive,
      pin,
      collapse,
      releasePin,
      requestTool,
    ],
  );

  return (
    <FunctionRailContext.Provider value={controller}>
      <div
        ref={setScopeElement}
        className="patent-function-rail-scope"
        data-function-rail-scope={scopeKey}
      >
        <div
          ref={setEdgeHostElement}
          className="patent-function-rail-edge-host"
          data-function-rail-edge-host={scopeKey}
        />
        {children}
      </div>
    </FunctionRailContext.Provider>
  );
}

export function usePatentFunctionRail(): PatentFunctionRailController {
  const controller = useContext(FunctionRailContext);
  if (!controller) {
    throw new Error("usePatentFunctionRail must be used inside PatentFunctionRailScope");
  }
  return controller;
}

export function useOptionalPatentFunctionRail(): PatentFunctionRailController | null {
  return useContext(FunctionRailContext);
}
