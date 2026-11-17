const isDocument = (root: Document | ShadowRoot): root is Document => root.nodeType === 9;
const query = "(prefers-reduced-motion: reduce)";
export function prefersReducedMotion(): boolean {
  const preference = document.documentElement.dataset.reducedMotion;
  if (preference === "true") return true;
  if (preference === "false") return false;
  return Boolean(window.matchMedia?.(query).matches);
}

export function subscribeMotionPreference(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-reduced-motion"],
  });
  const media = window.matchMedia?.(query);
  media?.addEventListener?.("change", listener);
  return () => {
    observer.disconnect();
    media?.removeEventListener?.("change", listener);
  };
}

// Embedded editors and open shadow roots have their own stylesheets.
const disabledCss = `*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }`;

/** Finish committed results rather than cancelling paint that temporarily hides real text. */
export function installMotionPreference(): () => void {
  const styles = new Map<Document | ShadowRoot, HTMLStyleElement>();
  const observed = new Set<Document | ShadowRoot>();
  const observers: MutationObserver[] = [];
  const frameListeners = new Map<HTMLIFrameElement, () => void>();
  let disposed = false;
  const finish = (doc: Document) => {
    for (const animation of doc.getAnimations?.() ?? []) {
      if (animation.playState === "finished" || animation.playState === "idle") continue;
      try {
        animation.finish();
      } catch {
        animation.cancel();
      }
    }
    // Explicit smooth scrolling is independent of the CSS scroll-behavior property.
    for (const el of doc.querySelectorAll<HTMLElement>("*")) {
      if (el.scrollTop || el.scrollLeft)
        el.scrollTo?.({ top: el.scrollTop, left: el.scrollLeft, behavior: "instant" });
    }
  };
  const syncRoot = (root: Document | ShadowRoot, reduced: boolean) => {
    if (disposed) return;
    if (isDocument(root)) root.documentElement.dataset.motionDisabled = String(reduced);
    let style = styles.get(root);
    if (!style) {
      style =
        root.ownerDocument?.createElement("style") ?? (root as Document).createElement("style");
      style.dataset.motionPolicy = "true";
      styles.set(root, style);
      (isDocument(root) ? root.head : root).append(style);
    }
    const css = reduced ? disabledCss : "";
    const restoring = !reduced && style.textContent === disabledCss;
    if (style.textContent !== css) style.textContent = css;
    if (restoring) {
      // Removing animation:none recreates CSS entrance effects on existing surfaces.
      // Resolve and finish them before paint; future openings and looping indicators
      // retain their normal animation policy.
      for (const animation of root.getAnimations?.() ?? []) {
        const view = (isDocument(root) ? root : root.ownerDocument).defaultView;
        if (
          view &&
          animation instanceof view.CSSAnimation &&
          animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY
        ) {
          try {
            animation.finish();
          } catch {
            animation.cancel();
          }
        }
      }
    }
    if (reduced && isDocument(root)) finish(root);
    for (const svg of root.querySelectorAll("svg")) {
      if (reduced) svg.pauseAnimations?.();
      else svg.unpauseAnimations?.();
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) syncRoot(el.shadowRoot, reduced);
      if (el.tagName === "IFRAME") {
        const frame = el as HTMLIFrameElement;
        if (!frameListeners.has(frame)) {
          const listener = () => sync();
          frame.addEventListener("load", listener);
          frameListeners.set(frame, listener);
        }
        // Remote content is sandboxed; local drawing editors share our origin.
        try {
          if (frame.contentDocument?.documentElement) syncRoot(frame.contentDocument, reduced);
        } catch {
          /* Cross-origin frame. */
        }
      }
    }
    if (!observed.has(root)) {
      observed.add(root);
      const observer = new MutationObserver((records) => {
        // Only new editor surfaces need policy propagation; ordinary typing stays cheap.
        if (
          records.some((record) =>
            Array.from(record.addedNodes).some(
              (node) =>
                node.nodeType === 1 &&
                ((node as Element).shadowRoot ||
                  (node as Element).matches("iframe") ||
                  (node as Element).querySelector("iframe") ||
                  Array.from((node as Element).querySelectorAll("*")).some((el) => el.shadowRoot)),
            ),
          )
        )
          sync();
      });
      observer.observe(root, { childList: true, subtree: true });
      observers.push(observer);
    }
  };
  const sync = () => syncRoot(document, prefersReducedMotion());
  const unsubscribe = subscribeMotionPreference(sync);
  sync();
  return () => {
    disposed = true;
    unsubscribe();
    for (const observer of observers) observer.disconnect();
    for (const [frame, listener] of frameListeners) frame.removeEventListener("load", listener);
    for (const [root, style] of styles) {
      style.remove();
      if (isDocument(root)) delete root.documentElement.dataset.motionDisabled;
    }
  };
}
