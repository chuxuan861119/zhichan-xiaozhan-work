import { type RefObject, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { DocumentStructureRulerMarker } from "../../../shared/patent/document-structure-ruler";
import { SpatialPresence } from "../shared/spatial-presence";
import { type RulerPopoverAnchor, rulerPopoverPosition } from "./ruler-popover-position";
import "./ruler-navigation-popover.css";

export function RulerNavigationPopover({
  open = true,
  anchor,
  markers,
  currentId,
  onActivate,
  onEnter,
  onLeave,
  selectionNavigationRef,
  selectionTargetId,
}: {
  open?: boolean;
  anchor: RulerPopoverAnchor;
  markers: readonly DocumentStructureRulerMarker[];
  currentId: string | null;
  onActivate(marker: DocumentStructureRulerMarker): void;
  onEnter(): void;
  onLeave(): void;
  selectionNavigationRef?: RefObject<HTMLElement | null>;
  selectionTargetId?: string | null;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const active = Array.from(
      list.current?.querySelectorAll<HTMLElement>("[data-ruler-marker-id]") ?? [],
    ).find((element) => element.dataset.rulerMarkerId === currentId);
    if (active && list.current)
      list.current.scrollTop =
        active.offsetTop - list.current.clientHeight / 2 + active.offsetHeight / 2;
  }, [currentId]);
  return createPortal(
    <SpatialPresence>
      {open ? (
        <nav
          ref={selectionNavigationRef}
          className="ruler-navigation-popover"
          data-selection-navigation={selectionNavigationRef ? "true" : undefined}
          aria-label="文档导航"
          style={rulerPopoverPosition(anchor, window.innerWidth, window.innerHeight)}
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="ruler-navigation-popover__list" ref={list}>
            {markers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                data-kind={marker.kind}
                data-ruler-marker-id={marker.id}
                aria-current={
                  marker.id === (selectionTargetId ?? currentId) ? "location" : undefined
                }
                data-warning={marker.warning || Boolean(marker.error)}
                onClick={() => onActivate(marker)}
              >
                {marker.label}
              </button>
            ))}
          </div>
        </nav>
      ) : null}
    </SpatialPresence>,
    document.body,
  );
}
