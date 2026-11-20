import { type RefObject, useLayoutEffect, useRef } from "react";
import { DRAWIO_FRAME_ORIGIN } from "./drawio-frame-bridge";

type Attachment = { slot: HTMLDivElement; ready: () => void };
type Runtime = {
  frame: HTMLIFrameElement;
  parking: HTMLDivElement;
  loaded: boolean;
  owner: Attachment | null;
  clients: number;
};
const runtimes = new WeakMap<Document, Runtime>();

function runtimeFor(doc: Document, firstSlot: HTMLDivElement): Runtime {
  const existing = runtimes.get(doc);
  if (existing) return existing;
  const parking = doc.createElement("div");
  const view = doc.defaultView ?? window;
  Object.assign(parking.style, {
    position: "fixed",
    left: "-100000px",
    top: "0px",
    width: `${view.innerWidth}px`,
    height: `${view.innerHeight}px`,
    visibility: "hidden",
  });
  doc.body.append(parking);
  const frame = doc.createElement("iframe");
  frame.src = "patent-diagram://editor/adapter.html";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.className = "flowchart-workspace__frame";
  const runtime: Runtime = { frame, parking, loaded: false, owner: null, clients: 0 };
  frame.addEventListener("load", () => {
    runtime.loaded = true;
    runtime.owner?.ready();
  });
  // Never detach this frame while any patent still owns a flowchart session.
  frame.style.visibility = "hidden";
  if (typeof firstSlot.moveBefore !== "function") {
    Object.assign(frame.style, {
      position: "fixed",
      width: `${view.innerWidth}px`,
      height: `${view.innerHeight}px`,
      visibility: "hidden",
    });
  }
  parking.append(frame);
  runtimes.set(doc, runtime);
  return runtime;
}

export function SharedDrawioFrame({
  enabled,
  visible,
  sessionId,
  frameRef,
  onReady,
  interactive,
}: {
  enabled: boolean;
  visible: boolean;
  sessionId: string;
  frameRef: RefObject<HTMLIFrameElement | null>;
  onReady(): void;
  interactive: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const latest = useRef({ onReady, visible, interactive });
  latest.current = { onReady, visible, interactive };
  const runtimeRef = useRef<Runtime | null>(null);
  const placeRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const target = slot.current;
    if (!target) return;
    const doc = target.ownerDocument;
    const runtime = runtimeFor(doc, target);
    runtimeRef.current = runtime;
    runtime.clients++;
    return () => {
      runtime.clients--;
      if (!runtime.clients) {
        runtime.frame.remove();
        runtime.parking.remove();
        runtimes.delete(doc);
      }
      runtimeRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    return () => {
      // Release just this closed project; no content or history is shared with
      // a later reopening, even if the patent/project IDs are reused.
      if (runtime.frame.isConnected)
        runtime.frame.contentWindow?.postMessage(
          { type: "release-session", sessionId },
          DRAWIO_FRAME_ORIGIN,
        );
    };
  }, [sessionId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Project changes/retries must hand off the same iframe to the new native session.
  useLayoutEffect(() => {
    if (!enabled) return;
    const runtime = runtimeRef.current;
    const target = slot.current;
    if (!runtime || !target) return;
    const attachment = { slot: target, ready: () => latest.current.onReady() };
    runtime.owner = attachment;
    const frame = runtime.frame;
    frameRef.current = frame;
    frame.title = "流程图编辑器";
    let observer: ResizeObserver | undefined;
    const atomicMove = typeof target.moveBefore === "function";
    const place = () => {
      if (runtime.owner !== attachment) return;
      const bounds = target.getBoundingClientRect();
      const hasArea = bounds.width > 0 && bounds.height > 0;
      if (hasArea) {
        runtime.parking.style.width = `${bounds.width}px`;
        runtime.parking.style.height = `${bounds.height}px`;
      }
      if (atomicMove) {
        const parent = latest.current.visible && hasArea ? target : runtime.parking;
        if (frame.parentElement !== parent) parent.moveBefore(frame, null);
      }
      if (!atomicMove) {
        // Older webviews keep the iframe in its original DOM location. A fixed
        // surface tracks the slot rather than reparenting/reloading the editor.
        // Parking/hidden slots can report 0x0 while a load is still fitting the graph.
        // Retain the last real viewport rather than saving a near-zero camera scale.
        if (hasArea)
          Object.assign(frame.style, {
            position: "fixed",
            left: `${bounds.left}px`,
            top: `${bounds.top}px`,
            width: `${bounds.width}px`,
            height: `${bounds.height}px`,
            zIndex: "1",
          });
      }
      frame.style.visibility = latest.current.visible && hasArea ? "visible" : "hidden";
      frame.inert = !latest.current.interactive || !latest.current.visible || !hasArea;
    };
    placeRef.current = place;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(place);
      observer.observe(target);
    }
    if (!atomicMove) {
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, true);
    }
    place();
    if (runtime.loaded) attachment.ready();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      placeRef.current = null;
      frameRef.current = null;
      if (runtime.owner !== attachment) return;
      runtime.owner = null;
      frame.removeAttribute("title");
      frame.style.visibility = "hidden";
      frame.inert = true;
      if (atomicMove && frame.isConnected) runtime.parking.moveBefore(frame, null);
    };
  }, [enabled, sessionId, frameRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: these changes re-place the retained iframe using the latest ref.
  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.owner?.slot !== slot.current) return;
    placeRef.current?.();
  }, [visible, interactive]);
  return <div ref={slot} className="flowchart-workspace__frame-slot" />;
}
