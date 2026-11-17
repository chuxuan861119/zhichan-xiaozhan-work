import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { prefersReducedMotion as isMotionReduced } from "../../shared/motion-preference";
import { spatialMotionTiming } from "../../shared/spatial-motion";
import { moveReferenceOrder, reconcileReferenceOrder } from "./reference-mark-order";

export function useReferenceMarkOrder(
  ids: readonly string[],
  onCommit: ((ids: string[]) => { ok: boolean; message: string }) | undefined,
  enabled = true,
) {
  const [preview, setPreview] = useState<string[] | null>(null);
  const [ghost, setGhost] = useState<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const cancelRef = useRef<(() => void) | null>(null);
  const order = reconcileReferenceOrder(ids, preview ?? ids);
  const orderKey = order.join(",");
  const sourceKey = ids.join(",");
  useEffect(() => {
    void sourceKey;
    void enabled;
    cancelRef.current?.();
  }, [sourceKey, enabled]);
  useEffect(() => () => cancelRef.current?.(), []);
  useLayoutEffect(() => {
    if (!orderKey) return;
    for (const row of listRef.current?.children ?? []) {
      const element = row as HTMLElement;
      const id = element.dataset.referenceListId ?? "";
      const oldTop = positions.current.get(id);
      const top = element.getBoundingClientRect().top;
      if (oldTop !== undefined && oldTop !== top && !isMotionReduced()) {
        element.getAnimations?.().forEach((animation) => {
          animation.cancel();
        });
        element.animate?.(
          [{ transform: `translateY(${oldTop - top}px)` }, { transform: "translateY(0)" }],
          spatialMotionTiming(Math.abs(oldTop - top)),
        );
      }
    }
    positions.current.clear();
  }, [orderKey]);

  const rememberPositions = () => {
    for (const row of listRef.current?.children ?? []) {
      const element = row as HTMLElement;
      positions.current.set(
        element.dataset.referenceListId ?? "",
        element.getBoundingClientRect().top,
      );
    }
  };
  const persist = (next: string[]) => {
    try {
      const result = onCommit?.(next);
      setNotice(
        result?.ok
          ? "关键词位置已调整，复制按新顺序生成"
          : (result?.message ?? "无法保存排列顺序，已恢复原位置"),
      );
    } catch {
      setNotice("无法保存排列顺序，已恢复原位置");
    }
  };

  const start = (event: ReactPointerEvent<HTMLButtonElement>, id: string, label: string) => {
    if (event.button !== 0 || !enabled) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const row = handle.closest<HTMLElement>("[data-reference-list-id]");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const initialY = event.clientY;
    const offset = initialY - rect.top;
    let active = false;
    let next = [...order];
    let clientY = initialY;
    let frame = 0;
    const scroll = row.closest<HTMLElement>(".patent-global-function-rail");
    const update = () => {
      if (!active) return;
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        const direction = clientY < bounds.top + 32 ? -1 : clientY > bounds.bottom - 32 ? 1 : 0;
        scroll.scrollTop += direction * 7;
      }
      const rows = [...(listRef.current?.children ?? [])] as HTMLElement[];
      const listTop = listRef.current?.getBoundingClientRect().top ?? 0;
      const currentIndex = next.indexOf(id);
      const target = rows.find((el) => {
        // Layout coordinates ignore FLIP transforms, so stationary pointers cannot oscillate.
        const top = listTop + el.offsetTop;
        const middle = top + el.offsetHeight / 2;
        const index = next.indexOf(el.dataset.referenceListId ?? "");
        return (
          index !== currentIndex &&
          clientY >= top &&
          clientY <= top + el.offsetHeight &&
          (index > currentIndex ? clientY >= middle : clientY <= middle)
        );
      });
      const targetId = target?.dataset.referenceListId;
      if (targetId && targetId !== id) {
        rememberPositions();
        next = moveReferenceOrder(next, id, targetId);
        setPreview(next);
      }
      frame = requestAnimationFrame(update);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      clientY = e.clientY;
      if (!active && Math.abs(clientY - initialY) < 5) return;
      if (!active) {
        active = true;
        document.documentElement.dataset.referenceMarkDragging = "true";
        frame = requestAnimationFrame(update);
      }
      setGhost({
        id,
        label,
        x: rect.left,
        y: clientY - offset,
        width: rect.width,
        height: rect.height,
      });
    };
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", cancelOnEscape, true);
      window.removeEventListener("blur", cancel);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      cancelRef.current = null;
      delete document.documentElement.dataset.referenceMarkDragging;
      if (commit && active) persist(next);
      else if (active) {
        rememberPositions();
        setNotice("已取消调整位置");
      }
      setPreview(null);
      setGhost(null);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === event.pointerId) finish(true);
    };
    const cancel = () => finish(false);
    const cancelOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    cancelRef.current?.();
    cancelRef.current = cancel;
    handle.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", cancelOnEscape, true);
    window.addEventListener("blur", cancel);
  };
  const moveByKeyboard = (id: string, delta: number) => {
    if (!enabled) return;
    const target = order[order.indexOf(id) + delta];
    if (!target) return;
    rememberPositions();
    persist(moveReferenceOrder(order, id, target));
  };
  return { order, listRef, ghost, notice, start, moveByKeyboard };
}
