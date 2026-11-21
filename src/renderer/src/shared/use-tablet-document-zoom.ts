import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { isTabletInteraction } from "./tablet-input";

export const defaultDocumentZoom = () => {
  if (!isTabletInteraction()) return 100;
  // A4 reading default: leave room for the compact ruler and page gutter.
  // This changes only the initial view, never the saved font or paper size.
  return Math.min(80, Math.max(35, Math.floor(((window.innerWidth - 80) / 794) * 20) * 5));
};

/** Native classification can arrive late. Fit the reading default on rotation,
 * never over a manual zoom or a restored PATDOC view. */
export function useTabletDocumentZoom() {
  const [zoom, setZoom] = useState(defaultDocumentZoom);
  const chosen = useRef(false);
  useEffect(() => {
    const classify = () => {
      if (!chosen.current && isTabletInteraction()) setZoom(defaultDocumentZoom());
    };
    classify();
    window.addEventListener("workbench-tablet-metrics", classify);
    window.addEventListener("resize", classify);
    return () => {
      window.removeEventListener("workbench-tablet-metrics", classify);
      window.removeEventListener("resize", classify);
    };
  }, []);
  const chooseZoom = useCallback((next: SetStateAction<number>) => {
    chosen.current = true;
    setZoom(next);
  }, []);
  return [zoom, chooseZoom] as const;
}
