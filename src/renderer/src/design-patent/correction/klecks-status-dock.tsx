import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./klecks-status-dock.css";

/** Keep commands owned by the editor; only their display location changes. */
export function KlecksStatusDock({ children }: { children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const update = () => {
      const owner = anchor.current?.parentElement;
      const visible = owner && !owner.closest("[hidden]");
      setTarget(visible ? document.querySelector(".status-bar__design-editor") : null);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <span ref={anchor} style={{ display: "none" }} aria-hidden="true" />
      {target ? (
        createPortal(
          <div className="klecks-panels klecks-status-dock">
            <div className="klecks-panels__status">{children}</div>
          </div>,
          target,
        )
      ) : (
        <footer className="klecks-panels__status">{children}</footer>
      )}
    </>
  );
}
