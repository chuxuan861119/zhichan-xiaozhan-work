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
  parking.hidden = true;
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
  if (typeof firstSlot.moveBefore === "function") firstSlot.append(frame);
  else {
    parking.hidden = false;
    frame.style.visibility = "hidden";
    parking.append(frame);
  }
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
      if (!atomicMove) {
        // Older webviews keep the iframe in its original DOM location. A fixed
        // surface tracks the slot rather than reparenting/reloading the editor.
        const bounds = target.getBoundingClientRect();
        Object.assign(frame.style, {
          position: "fixed",
          left: `${bounds.left}px`,
          top: `${bounds.top}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
          zIndex: "1",
        });
      }
      frame.style.visibility = latest.current.visible ? "visible" : "hidden";
      frame.inert = !latest.current.interactive || !latest.current.visible;
    };
    if (atomicMove) {
      if (frame.parentElement !== target) target.moveBefore(frame, null);
    } else {
      runtime.parking.hidden = false;
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(place);
        observer.observe(target);
      }
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, true);
    }
    place();
    if (runtime.loaded) attachment.ready();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      frameRef.current = null;
      if (runtime.owner !== attachment) return;
      runtime.owner = null;
      frame.removeAttribute("title");
      frame.style.visibility = "hidden";
      frame.inert = true;
      if (atomicMove && frame.isConnected) runtime.parking.moveBefore(frame, null);
    };
  }, [enabled, sessionId, frameRef]);
  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.owner?.slot !== slot.current) return;
    runtime.frame.style.visibility = visible ? "visible" : "hidden";
    runtime.frame.inert = !interactive || !visible;
  }, [visible, interactive]);
  return <div ref={slot} className="flowchart-workspace__frame-slot" />;
}
