import { cloneElement, type ReactElement, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import type { PatentLibraryViewMode } from "../../../shared/settings/model";
import type { PatentLibraryFocusRequest } from "./document-library";

type Range = {
  start: number;
  end: number;
  columns: number;
  height: number;
  gap: number;
  measured: ReadonlyMap<number, number>;
};

/** Window only the presentation. Filtering, search and batch operations retain the full collection. */
export function VirtualPatentCards({
  patents,
  mode,
  id,
  renderCard,
  focus,
  virtual,
  onFocusReady,
}: {
  patents: readonly LibraryPatentSummary[];
  mode: PatentLibraryViewMode;
  id: string;
  renderCard(patent: LibraryPatentSummary): ReactElement;
  focus: PatentLibraryFocusRequest | null;
  virtual: boolean;
  onFocusReady(requestKey: number): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const measuredLayout = useRef({ patents, mode, width: 0 });
  const [range, setRange] = useState<Range>(() => ({
    start: 0,
    end: 20,
    columns: 1,
    height: mode === "illustrated" ? 360 : 112,
    gap: mode === "illustrated" ? 18 : 12,
    measured: new Map(),
  }));
  const lastFocus = useRef<number | undefined>(undefined);
  const rowCount = Math.ceil(patents.length / range.columns);
  const offsets = useMemo(() => {
    const values = [0];
    for (let row = 0; row < rowCount; row++)
      values.push(values[row]! + (range.measured.get(row) ?? range.height) + range.gap);
    return values;
  }, [range.measured, range.height, range.gap, rowCount]);
  const focusIndex = focus ? patents.findIndex((patent) => patent.patentId === focus.patentId) : -1;
  const pendingFocus = focusIndex >= 0 && focus?.requestKey !== lastFocus.current;
  const start = pendingFocus
    ? Math.max(0, Math.floor(focusIndex / range.columns) - 2)
    : Math.min(range.start, rowCount);
  const end = pendingFocus ? Math.min(rowCount, start + 20) : Math.min(range.end, rowCount);
  const state = useRef({ offsets, range, start, end, rowCount });
  state.current = { offsets, range, start, end, rowCount };

  useLayoutEffect(() => {
    if (!virtual || !container.current) return;
    const node = container.current;
    const view = node.closest<HTMLElement>(".library-view");
    if (!view) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const current = state.current;
      const style = getComputedStyle(node);
      const bounds = node.getBoundingClientRect();
      const layout = measuredLayout.current;
      const layoutChanged =
        layout.patents !== patents || layout.mode !== mode || layout.width !== bounds.width;
      measuredLayout.current = { patents, mode, width: bounds.width };
      const columns = Math.max(
        1,
        style.gridTemplateColumns.split(/\s+/u).filter((value) => value && value !== "none").length,
      );
      const gap = Number.parseFloat(style.rowGap) || (mode === "illustrated" ? 18 : 12);
      const measured =
        !layoutChanged && columns === current.range.columns
          ? new Map(current.range.measured)
          : new Map<number, number>();
      const heights = new Map<number, number>();
      for (const card of node.querySelectorAll<HTMLElement>("[data-library-virtual-index]")) {
        const height = card.getBoundingClientRect().height;
        const index = Number(card.dataset.libraryVirtualIndex);
        if (height > 0)
          heights.set(
            Math.floor(index / columns),
            Math.max(height, heights.get(Math.floor(index / columns)) ?? 0),
          );
      }
      for (const [row, height] of heights) measured.set(row, height);
      // Keep estimates stable while scrolling; changing the first visible row
      // must not resize every unmeasured row and move the scrollbar underneath it.
      const estimate =
        layoutChanged || columns !== current.range.columns || current.range.measured.size === 0
          ? (heights.values().next().value ?? current.range.height)
          : current.range.height;
      const count = Math.ceil(patents.length / columns);
      const positions = [0];
      for (let row = 0; row < count; row++)
        positions.push(positions[row]! + (measured.get(row) ?? estimate) + gap);
      const viewport = view.getBoundingClientRect();
      const top = viewport.top - bounds.top;
      const bottom = top + Math.min(viewport.height || 800, window.innerHeight || 800);
      let first = 0;
      while (first < count && positions[first + 1]! < top) first++;
      let last = first;
      while (last < count && positions[last]! < bottom) last++;
      const next = {
        start: Math.max(0, first - 2),
        end: Math.min(count, last + 2),
        columns,
        height: estimate,
        gap,
        measured,
      };
      setRange((previous) =>
        previous.start === next.start &&
        previous.end === next.end &&
        previous.columns === columns &&
        previous.height === estimate &&
        previous.gap === gap &&
        previous.measured.size === measured.size &&
        [...measured].every(([row, height]) => previous.measured.get(row) === height)
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(node);
    observer?.observe(view);
    view.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      view.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [virtual, mode, patents]);

  useLayoutEffect(() => {
    if (!pendingFocus || !focus) return;
    const actualColumns = Math.max(
      1,
      getComputedStyle(container.current!)
        .gridTemplateColumns.split(/\s+/u)
        .filter((value) => value && value !== "none").length,
    );
    if (virtual && actualColumns !== range.columns) return;
    lastFocus.current = focus.requestKey;
    setRange((previous) => ({ ...previous, start, end }));
    onFocusReady(focus.requestKey);
  }, [pendingFocus, focus, start, end, virtual, range.columns, onFocusReady]);

  const cards = useMemo(
    () =>
      (virtual ? patents.slice(start * range.columns, end * range.columns) : patents).map(
        (patent, index) =>
          cloneElement(renderCard(patent) as ReactElement<Record<string, unknown>>, {
            "data-library-virtual-index": virtual ? start * range.columns + index : index,
          }),
      ),
    [virtual, patents, start, end, range.columns, renderCard],
  );
  const total = Math.max(0, offsets[rowCount]! - range.gap);
  return (
    <div ref={container} className="patent-library-month-cards" data-view-mode={mode} id={id}>
      {virtual && start > 0 ? (
        <div
          aria-hidden="true"
          style={{
            gridColumn: "1 / -1",
            height: Math.max(0, offsets[start]! - range.gap),
            pointerEvents: "none",
          }}
        />
      ) : null}
      {cards}
      {virtual && end < rowCount ? (
        <div
          aria-hidden="true"
          style={{
            gridColumn: "1 / -1",
            height: Math.max(0, total - offsets[end]!),
            pointerEvents: "none",
          }}
        />
      ) : null}
    </div>
  );
}
