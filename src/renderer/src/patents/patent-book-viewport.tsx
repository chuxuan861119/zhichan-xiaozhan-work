import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PatentBookKind } from "../../../shared/patent/model";

export type PatentBookViewportKey = `${string}:${PatentBookKind}` | `${string}:auxiliary:${string}`;

export class PatentBookViewportStore {
  readonly #positions = new Map<PatentBookViewportKey, number>();
  readonly #coordinates = new Map<PatentBookViewportKey, number>();

  read(key: PatentBookViewportKey): number {
    return this.#positions.get(key) ?? 0;
  }

  write(key: PatentBookViewportKey, scrollTop: number, scale = 1, origin = 0): void {
    if (Number.isFinite(scrollTop) && scrollTop >= 0) {
      this.#positions.set(key, scrollTop);
      this.#coordinates.set(key, scrollTop === 0 ? 0 : (scrollTop - origin) / scale);
    }
  }

  readAtScale(key: PatentBookViewportKey, scale: number, origin: number): number {
    if (this.read(key) === 0) return 0;
    return origin + (this.#coordinates.get(key) ?? this.read(key)) * scale;
  }

  removePatent(patentId: string): void {
    for (const key of this.#positions.keys()) {
      if (key.startsWith(`${patentId}:`)) {
        this.#positions.delete(key);
        this.#coordinates.delete(key);
      }
    }
  }
}

type PatentBookViewportContextValue = {
  store: PatentBookViewportStore;
};

const PatentBookViewportContext = createContext<PatentBookViewportContextValue | null>(null);

export function PatentBookViewportProvider({
  store,
  children,
}: PropsWithChildren<{ store?: PatentBookViewportStore }>) {
  const ownedStore = useMemo(() => store ?? new PatentBookViewportStore(), [store]);
  return (
    <PatentBookViewportContext.Provider value={{ store: ownedStore }}>
      {children}
    </PatentBookViewportContext.Provider>
  );
}

export function usePatentBookViewportRegistration(key: PatentBookViewportKey) {
  const context = useContext(PatentBookViewportContext);
  if (!context) {
    throw new Error(
      "usePatentBookViewportRegistration must be used inside PatentBookViewportProvider",
    );
  }
  const cleanupRef = useRef<(() => void) | null>(null);
  const [node, setNode] = useState<HTMLElement | null>(null);

  const register = useCallback((nextNode: HTMLElement | null) => {
    setNode(nextNode);
  }, []);

  useLayoutEffect(() => {
    if (!node) return;
    cleanupRef.current = registerViewportNode(context.store, key, node);
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [context.store, key, node]);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  return register;
}

function registerViewportNode(
  store: PatentBookViewportStore,
  key: PatentBookViewportKey,
  node: HTMLElement,
): () => void {
  let active = true;
  const geometry = () => {
    const layout = node.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = layout?.querySelector<HTMLElement>(".patent-page-zoom-frame");
    const rect = page?.getBoundingClientRect();
    return {
      scale: layout
        ? Number.parseFloat(getComputedStyle(layout).getPropertyValue("--patent-page-zoom")) || 1
        : 1,
      origin:
        rect && rect.height > 0 ? rect.top + node.scrollTop - node.getBoundingClientRect().top : 0,
    };
  };
  let restored = false;
  const save = () => {
    if (!restored) return;
    const { scale, origin } = geometry();
    store.write(key, node.scrollTop, scale, origin);
  };
  const restore = () => {
    if (!active) return;
    const { scale, origin } = geometry();
    node.scrollTop = clampScrollTop(node, store.readAtScale(key, scale, origin));
    restored = true;
  };
  node.addEventListener("scroll", save, { passive: true });
  requestAnimationFrame(restore);
  return () => {
    active = false;
    save();
    node.removeEventListener("scroll", save);
  };
}

function clampScrollTop(node: HTMLElement, value: number): number {
  const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
  return Math.min(value, maximum);
}
