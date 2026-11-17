import { useCallback, useEffect, useRef, useState } from "react";
import type { DrawingPoint } from "../../../shared/drawing-markup/model";

// Keep pointer geometry outside workspace state; only changed hit feedback needs React.
export function useRangePreview() {
  const ref = useRef<SVGPolygonElement>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<{
    points: DrawingPoint[];
    crossing: boolean;
    ids: string[] | (() => string[]);
  } | null>(null);
  const [feedback, setFeedback] = useState<{ active: boolean; ids: string[] }>({
    active: false,
    ids: [],
  });
  const last = useRef(feedback);
  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  function clear() {
    cancel();
    ref.current?.setAttribute("points", "");
    if (last.current.active) {
      last.current = { active: false, ids: [] };
      setFeedback(last.current);
    }
  }
  function update(points: DrawingPoint[], crossing: boolean, ids: string[] | (() => string[])) {
    pending.current = { points: [...points], crossing, ids };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const next = pending.current;
      pending.current = null;
      if (!next) return;
      ref.current?.setAttribute("points", next.points.map((p) => `${p.x},${p.y}`).join(" "));
      ref.current?.setAttribute("stroke", next.crossing ? "#169447" : "#2563eb");
      ref.current?.setAttribute("fill", next.crossing ? "#16944711" : "#2563eb11");
      const ids = typeof next.ids === "function" ? next.ids() : next.ids;
      const previous = last.current;
      if (
        !previous.active ||
        previous.ids.length !== ids.length ||
        previous.ids.some((id, i) => id !== ids[i])
      ) {
        last.current = { active: true, ids };
        setFeedback(last.current);
      }
    });
  }
  return { ref, update, clear, active: feedback.active, ids: feedback.ids };
}
