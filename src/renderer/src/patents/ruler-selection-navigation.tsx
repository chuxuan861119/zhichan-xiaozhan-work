import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { DocumentStructureRulerMarker } from "../../../shared/patent/document-structure-ruler";
import type { EditorCommandBus } from "../app/command-bus";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";
import { RulerNavigationPopover } from "./ruler-navigation-popover";
import type { RulerPopoverAnchor } from "./ruler-popover-position";
import { DOCUMENT_ZOOM_FRAME } from "./use-smooth-document-zoom";

type LocatedBlock = { position: number; element: HTMLElement };
type Point = { x: number; y: number };
type Navigation = { anchor: RulerPopoverAnchor; currentId: string | null };

/** A drag belongs to one editor for its entire lifetime, including portal and mirror hits. */
export function RulerSelectionNavigation(props: {
  host: RefObject<HTMLElement | null>;
  blocks: RefObject<Map<string, LocatedBlock>>;
  markers: readonly DocumentStructureRulerMarker[];
  editorId: string;
  commandBus: EditorCommandBus;
  dualColumn: boolean;
  mode: string;
}) {
  const current = useRef(props);
  current.current = props;
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const frozenMarkers = useRef<readonly DocumentStructureRulerMarker[]>([]);
  const popup = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing ruler mode must end an in-progress gesture.
  useEffect(() => {
    const host = current.current.host.current;
    const editor = props.commandBus.getEditor(props.editorId);
    const layout = host?.closest<HTMLElement>(".patent-page-with-rail");
    const workspace = host?.closest<HTMLElement>(".editor-workspace");
    if (!host || !editor || !layout || !workspace) return;
    let anchor: number | null = null;
    let active = false;
    let cancelled = false;
    let ownedSelection: { anchor: number; head: number } | null = null;
    let point: Point = { x: 0, y: 0 };
    let side = 0;
    let overRuler = false;
    let origin: Point | null = null;
    let dwell: ReturnType<typeof setTimeout> | undefined;
    let targetTimer: ReturnType<typeof setTimeout> | undefined;
    let hovered: string | null = null;
    let applied: string | null = null;
    let motion = 0;
    let edgeFrame = 0;
    let documentEdgeFrame = 0;
    let blockClick = false;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;

    const columnEvent = (detail: Record<string, unknown>) =>
      layout.dispatchEvent(new CustomEvent("dual-column-selection-navigation", { detail }));
    const stopDocumentEdge = () => {
      cancelAnimationFrame(documentEdgeFrame);
      documentEdgeFrame = 0;
    };
    const cancelMotion = () => {
      cancelAnimationFrame(motion);
      motion = 0;
      if (props.dualColumn) columnEvent({ kind: "cancel" });
    };
    const clearTarget = () => {
      clearTimeout(targetTimer);
      targetTimer = undefined;
      hovered = null;
      cancelAnimationFrame(edgeFrame);
      edgeFrame = 0;
      stopDocumentEdge();
    };
    const closePopup = () => {
      setNavigation(null);
      setTargetId(null);
      clearTarget();
      applied = null;
    };
    const finish = () => {
      if (active) cancelled = true;
      clearTimeout(dwell);
      dwell = undefined;
      cancelMotion();
      closePopup();
      anchor = null;
      active = false;
      overRuler = false;
      origin = null;
      delete layout.dataset.rulerSelectionPending;
      delete layout.dataset.rulerSelectionDrag;
    };
    const unlock = () => {
      cancelled = false;
      ownedSelection = null;
      delete layout.dataset.rulerSelectionLocked;
    };
    const available = () =>
      host.isConnected &&
      !workspace.closest("[hidden]") &&
      workspace.getBoundingClientRect().height > 0 &&
      getComputedStyle(workspace).visibility !== "hidden";
    const hit = (p: Point) => {
      const viewport = workspace.getBoundingClientRect();
      if (p.y < viewport.top || p.y > viewport.bottom) return null;
      if (props.dualColumn) {
        const r = layout.getBoundingClientRect();
        const width = Number.parseFloat(layout.style.getPropertyValue("--column-width"));
        const slot = Number.parseFloat(layout.style.getPropertyValue("--column-ruler-slot"));
        const height = Number(layout.dataset.columnHeight);
        for (const s of [0, 1]) {
          const left = r.left + s * (width + 20);
          const top = r.top + s * 20;
          if (p.y < top || p.y > top + height || p.x < left || p.x > left + width) continue;
          return {
            side: s,
            ruler: p.x < left + slot,
            left,
            right: left + slot,
            top,
            bottom: top + height,
          };
        }
        return null;
      }
      const r = host.getBoundingClientRect();
      const page = editor.view.dom.getBoundingClientRect();
      if (p.x >= r.left && p.x <= r.right)
        return {
          side: 0,
          ruler: true,
          left: r.left,
          right: r.right,
          top: viewport.top,
          bottom: viewport.bottom,
        };
      if (p.x >= page.left && p.x <= page.right && p.y >= page.top && p.y <= page.bottom)
        return {
          side: 0,
          ruler: false,
          left: r.left,
          right: r.right,
          top: viewport.top,
          bottom: viewport.bottom,
        };
      return null;
    };
    const select = (head: number) => {
      if (anchor === null || editor.isDestroyed) return;
      const doc = editor.state.doc;
      const selection = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
      ownedSelection = { anchor: selection.anchor, head: selection.head };
      if (!selection.eq(editor.state.selection))
        editor.view.dispatch(editor.state.tr.setSelection(selection));
      // During a held native drag the editor can defer DOM-selection synchronization.
      // Keep the painted range and model range identical before navigating away.
      restoreSelection();
    };
    const navigate = (markerId: string) => {
      const marker = frozenMarkers.current.find((item) => item.id === markerId);
      const block = marker && current.current.blocks.current.get(marker.targetBlockId);
      if (!active || anchor === null || !block || !block.element.isConnected) return;
      const node = editor.state.doc.nodeAt(block.position);
      if (!node) return;
      cancelMotion();
      const from = TextSelection.near(editor.state.doc.resolve(block.position + 1), 1).from;
      const to = TextSelection.near(
        editor.state.doc.resolve(block.position + node.nodeSize - 1),
        -1,
      ).to;
      select(from < anchor ? from : to);
      setTargetId(markerId);
      if (props.dualColumn) {
        const page = layout.querySelector<HTMLElement>(":scope > .patent-page-zoom-frame");
        if (page)
          columnEvent({
            kind: "navigate",
            side,
            documentY: block.element.getBoundingClientRect().top - page.getBoundingClientRect().top,
          });
        return;
      }
      const start = workspace.scrollTop;
      const bounds = workspace.getBoundingClientRect();
      const target = Math.max(
        0,
        Math.min(
          workspace.scrollHeight - workspace.clientHeight,
          start + block.element.getBoundingClientRect().top - bounds.top - bounds.height / 3,
        ),
      );
      const began = performance.now();
      const tick = (now: number) => {
        const progress = isMotionReduced() ? 1 : Math.min(1, (now - began) / 360);
        workspace.scrollTop = start + (target - start) * (1 - (1 - progress) ** 3);
        motion = progress < 1 ? requestAnimationFrame(tick) : 0;
      };
      if (isMotionReduced()) tick(performance.now());
      else motion = requestAnimationFrame(tick);
    };
    const hoverTarget = () => {
      const element = document.elementFromPoint(point.x, point.y);
      const button = element?.closest<HTMLElement>("[data-ruler-marker-id]");
      const id =
        button && popup.current?.contains(button) ? (button.dataset.rulerMarkerId ?? null) : null;
      if (id === hovered) return;
      clearTimeout(targetTimer);
      hovered = id;
      if (id && id !== applied)
        targetTimer = setTimeout(() => {
          if (!active || hovered !== id) return;
          applied = id;
          navigate(id);
        }, 100);
    };
    const edgeScroll = () => {
      if (edgeFrame) return;
      let previous = performance.now();
      const tick = (now: number) => {
        edgeFrame = 0;
        const list = popup.current?.querySelector<HTMLElement>(".ruler-navigation-popover__list");
        if (!active || !list) return;
        const bounds = list.getBoundingClientRect();
        if (
          point.x < bounds.left ||
          point.x > bounds.right ||
          point.y < bounds.top ||
          point.y > bounds.bottom
        )
          return;
        const direction = point.y < bounds.top + 24 ? -1 : point.y > bounds.bottom - 24 ? 1 : 0;
        if (!direction) return;
        const before = list.scrollTop;
        list.scrollTop += direction * Math.min(40, now - previous) * 0.3;
        previous = now;
        hoverTarget();
        if (list.scrollTop !== before) edgeFrame = requestAnimationFrame(tick);
      };
      edgeFrame = requestAnimationFrame(tick);
    };
    const scrollDocumentEdge = () => {
      let previous = performance.now();
      const tick = (now: number) => {
        documentEdgeFrame = 0;
        if (!active || !available()) return;
        const area = hit(point);
        if (!area || area.ruler) return;
        const viewport = workspace.getBoundingClientRect();
        const top = Math.max(area.top, viewport.top);
        const bottom = Math.min(area.bottom, viewport.bottom);
        const direction = point.y < top + 24 ? -1 : point.y > bottom - 24 ? 1 : 0;
        if (!direction) return;
        const delta = direction * Math.min(40, now - previous) * 0.6;
        previous = now;
        const before = props.dualColumn
          ? Number(layout.dataset.columnPosition)
          : workspace.scrollTop;
        if (props.dualColumn) columnEvent({ kind: "scroll", side: area.side, delta });
        else
          workspace.scrollTop = Math.max(
            0,
            Math.min(workspace.scrollHeight - workspace.clientHeight, before + delta),
          );
        const after = props.dualColumn
          ? Number(layout.dataset.columnPosition)
          : workspace.scrollTop;
        if (after === before) return;
        const resolved = editor.view.posAtCoords({ left: point.x, top: point.y });
        if (resolved) select(resolved.pos);
        documentEdgeFrame = requestAnimationFrame(tick);
      };
      documentEdgeFrame = requestAnimationFrame(tick);
    };
    const open = (area: NonNullable<ReturnType<typeof hit>>) => {
      if (anchor === null) return;
      if (!available()) {
        finish();
        unlock();
        return;
      }
      // Native word/paragraph dragging can snap the anchor after pointerdown.
      // Capture that range only on takeover, not when reopening during the same drag.
      if (!active) anchor = editor.state.selection.anchor;
      active = true;
      side = area.side;
      layout.dataset.rulerSelectionDrag = "true";
      layout.dataset.rulerSelectionLocked = "true";
      if (props.dualColumn) columnEvent({ kind: "activate", side });
      // Freeze both ordering and initial centering. Selection updates must not move the list.
      frozenMarkers.current = current.current.markers.filter((m) =>
        current.current.blocks.current.has(m.targetBlockId),
      );
      const head = editor.state.selection.head;
      let nearest: DocumentStructureRulerMarker | undefined;
      let distance = Infinity;
      for (const marker of frozenMarkers.current) {
        const pos = current.current.blocks.current.get(marker.targetBlockId)?.position ?? 0;
        if (Math.abs(pos - head) < distance) {
          distance = Math.abs(pos - head);
          nearest = marker;
        }
      }
      document.dispatchEvent(new CustomEvent("ruler-selection-start"));
      setNavigation({ anchor: area, currentId: nearest?.id ?? null });
      editor.view.focus();
      select(head);
    };
    const down = (event: PointerEvent) => {
      finish();
      unlock();
      if (
        event.button !== 0 ||
        (event.pointerType && event.pointerType !== "mouse") ||
        editor.isDestroyed ||
        editor.view.composing
      )
        return;
      const area = hit({ x: event.clientX, y: event.clientY });
      if (!area || area.ruler) return;
      const element = event.target instanceof Element ? event.target : null;
      if (
        !element ||
        !layout.contains(element) ||
        element.closest(
          "button,input,img,[draggable=true],.column-resize-handle,.table-controls,.ProseMirror-selectednode",
        )
      )
        return;
      if (!editor.view.dom.contains(element) && !element.closest(".dual-column-paper")) return;
      const resolved = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!resolved || !editor.state.doc.resolve(resolved.pos).parent.isTextblock) return;
      const selection = editor.state.selection;
      // Pressing inside an existing selection may begin a native text drag, not a new range.
      if (
        !event.shiftKey &&
        !selection.empty &&
        resolved.pos >= selection.from &&
        resolved.pos < selection.to
      )
        return;
      anchor = event.shiftKey ? selection.anchor : resolved.pos;
      side = area.side;
      point = { x: event.clientX, y: event.clientY };
      layout.dataset.rulerSelectionPending = "true";
    };
    const move = (event: PointerEvent) => {
      if ((anchor !== null || cancelled) && !available()) {
        finish();
        unlock();
        return;
      }
      if (cancelled) {
        if (event.buttons === 0) unlock();
        else {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (anchor === null) return;
      if (event.buttons !== 1) {
        finish();
        return;
      }
      point = { x: event.clientX, y: event.clientY };
      const inPopup = popup.current?.contains(document.elementFromPoint(point.x, point.y));
      const area = hit(point);
      if (active) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (inPopup) {
          stopDocumentEdge();
          hoverTarget();
          edgeScroll();
          return;
        }
        clearTarget();
        if (area?.ruler) {
          if (!popup.current || side !== area.side) {
            cancelMotion();
            closePopup();
            open(area);
          }
          return;
        }
        // Leaving the navigation can interrupt an unfinished scroll. The same
        // marker must be eligible again when the pointer comes back.
        applied = null;
        cancelMotion();
        if (area) {
          closePopup();
          if (props.dualColumn) columnEvent({ kind: "activate", side: area.side });
          const resolved = editor.view.posAtCoords({ left: point.x, top: point.y });
          if (resolved) select(resolved.pos);
          scrollDocumentEdge();
        }
        return;
      }
      if (!area?.ruler) {
        clearTimeout(dwell);
        dwell = undefined;
        origin = null;
        overRuler = false;
        return;
      }
      // Stay within a small tolerance for a full second, rather than sweeping over the rail.
      if (
        !overRuler ||
        side !== area.side ||
        (origin && Math.hypot(point.x - origin.x, point.y - origin.y) > 6)
      ) {
        clearTimeout(dwell);
        side = area.side;
        origin = point;
        overRuler = true;
        dwell = setTimeout(() => {
          dwell = undefined;
          if (anchor !== null && overRuler) open(area);
        }, 1000);
      }
    };
    const mouseMove = (event: MouseEvent) => {
      if (!active && !cancelled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const up = () => {
      if (active) {
        blockClick = true;
      }
      finish();
      // Keep ownership through native mouseup/click handling in this input task.
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        restoreSelection();
        unlock();
        blockClick = false;
      }, 0);
    };
    const click = (event: MouseEvent) => {
      if (!blockClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      blockClick = false;
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    const changed = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) {
        finish();
        unlock();
      }
    };
    const preventNative = (event: Event) => {
      if (active || cancelled) event.preventDefault();
    };
    const restoreSelection = (event?: Event) => {
      if ((!active && !cancelled) || !ownedSelection || editor.isDestroyed) return;
      if (!available()) {
        finish();
        unlock();
        return;
      }
      const native = window.getSelection();
      if (!native) return;
      const { anchor: fixedAnchor, head } = ownedSelection;
      // A document-changing transaction ends ownership before these positions become stale.
      if (Math.max(fixedAnchor, head) > editor.state.doc.content.size) {
        unlock();
        return;
      }
      const a = editor.view.domAtPos(fixedAnchor);
      const h = editor.view.domAtPos(head);
      if (
        native.anchorNode !== a.node ||
        native.anchorOffset !== a.offset ||
        native.focusNode !== h.node ||
        native.focusOffset !== h.offset
      ) {
        event?.stopImmediatePropagation();
        native.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
      }
      if (editor.state.selection.anchor !== fixedAnchor || editor.state.selection.head !== head)
        editor.view.dispatch(
          editor.state.tr.setSelection(
            TextSelection.between(
              editor.state.doc.resolve(fixedAnchor),
              editor.state.doc.resolve(head),
            ),
          ),
        );
    };
    const lostVisibility = () => {
      if (document.hidden) finish();
    };
    // Observe after the existing dual-column handler has moved the live editor.
    // Activating early would make that handler miss its side-switch selection setup.
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("mousemove", mouseMove, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("click", click, true);
    window.addEventListener("blur", finish);
    window.addEventListener("resize", finish);
    window.addEventListener("keydown", onEscape, true);
    document.addEventListener("visibilitychange", lostVisibility);
    document.addEventListener("dragstart", finish, true);
    document.addEventListener("selectstart", preventNative, true);
    document.addEventListener("selectionchange", restoreSelection, true);
    document.addEventListener(DOCUMENT_ZOOM_FRAME, finish);
    editor.on("transaction", changed);
    editor.on("blur", finish);
    return () => {
      finish();
      unlock();
      clearTimeout(clickTimer);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("mousemove", mouseMove, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("blur", finish);
      window.removeEventListener("resize", finish);
      window.removeEventListener("keydown", onEscape, true);
      document.removeEventListener("visibilitychange", lostVisibility);
      document.removeEventListener("dragstart", finish, true);
      document.removeEventListener("selectstart", preventNative, true);
      document.removeEventListener("selectionchange", restoreSelection, true);
      document.removeEventListener(DOCUMENT_ZOOM_FRAME, finish);
      editor.off("transaction", changed);
      editor.off("blur", finish);
    };
  }, [props.commandBus, props.editorId, props.dualColumn, props.mode]);

  return navigation ? (
    <RulerNavigationPopover
      anchor={navigation.anchor}
      markers={frozenMarkers.current}
      currentId={navigation.currentId}
      selectionTargetId={targetId}
      selectionNavigationRef={popup}
      onEnter={() => {}}
      onLeave={() => {}}
      onActivate={() => {}}
    />
  ) : null;
}
