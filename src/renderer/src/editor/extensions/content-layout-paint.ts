import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Mapping } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { contentEditMotionTiming, synchronizePaintTimings } from "../../shared/spatial-motion";
import { textEdits } from "../../shared/text-diff";

export const CONTENT_PAINT_FRAME = "editor-content-motion-frame";

type Glyph = { from: number; to: number; rect: DOMRect; paint: HTMLElement };
type Block = {
  pos: number;
  element: HTMLElement;
  node: ProseMirrorNode;
  rect: DOMRect;
  zoom: number;
  glyphs: Glyph[] | null;
};
export type ContentPaint = { blocks: Block[]; mapping: Mapping; rootRect: DOMRect };
export type ContentPaintPlayback = { stop(): void; syncScroll(): void };
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_GLYPHS = 2400;

function isPaintBlock(node: ProseMirrorNode) {
  return node.isTextblock || (node.isBlock && node.isAtom) || node.type.name === "table";
}

function visible(rect: DOMRect) {
  return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= innerHeight;
}

function textRect(view: EditorView, from: number, to: number): DOMRect | null {
  const start = view.domAtPos(from, 1);
  const end = view.domAtPos(to, -1);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function captureGlyphs(
  view: EditorView,
  node: ProseMirrorNode,
  pos: number,
  zoom: number,
  budget: { remaining: number },
) {
  // Rich inline objects keep their native rendering and use block translation.
  if (node.content.content.some((child) => !child.isText)) return null;
  const glyphs: Glyph[] = [];
  node.forEach((child, offset) => {
    if (budget.remaining <= 0) return;
    const from = pos + 1 + offset;
    const dom = view.domAtPos(from, 1).node;
    const parent = dom.nodeType === Node.TEXT_NODE ? dom.parentElement : (dom as HTMLElement);
    if (!parent) return;
    const style = getComputedStyle(parent);
    for (const part of segments.segment(child.text ?? "")) {
      // Count offscreen measurements too: a very long paragraph may start far
      // above the viewport. Animation must not delay the actual editing action.
      if (budget.remaining-- <= 0) break;
      const start = from + part.index;
      const end = start + part.segment.length;
      const rect = textRect(view, start, end);
      if (!rect || !visible(rect)) continue;
      const paint = document.createElement("span");
      paint.textContent = part.segment;
      Object.assign(paint.style, {
        position: "absolute",
        whiteSpace: "pre",
        margin: "0",
        padding: "0",
        fontFamily: style.fontFamily,
        fontSize: `${Number.parseFloat(style.fontSize) * zoom}px`,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        fontStretch: style.fontStretch,
        fontVariant: style.fontVariant,
        color: style.color,
        textDecoration: child.marks.some((mark) => mark.type.name === "underline")
          ? "underline"
          : style.textDecoration,
        backgroundColor: style.backgroundColor,
        lineHeight: `${rect.height}px`,
        height: `${rect.height}px`,
      });
      glyphs.push({ from: start, to: end, rect, paint });
    }
  });
  return budget.remaining > 0 ? glyphs : null;
}

export function captureContentPaint(view: EditorView, mapping: Mapping): ContentPaint {
  const blocks: Block[] = [];
  const budget = { remaining: MAX_GLYPHS };
  view.state.doc.descendants((node, pos) => {
    if (!isPaintBlock(node)) return true;
    const element = view.nodeDOM(pos);
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (!visible(rect) || blocks.length >= 40) return false;
    const zoom = element.offsetWidth ? rect.width / element.offsetWidth : 1;
    const glyphs =
      node.isTextblock && budget.remaining > 0
        ? captureGlyphs(view, node, pos, zoom, budget)
        : null;
    // Partial capture must never hide uncaptured text.
    blocks.push({ pos, element, node, rect, zoom, glyphs });
    return false;
  });
  return { blocks, mapping, rootRect: view.dom.getBoundingClientRect() };
}

function viewport(element: HTMLElement) {
  const box = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      box.left = Math.max(box.left, rect.left);
      box.right = Math.min(box.right, rect.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      box.top = Math.max(box.top, rect.top);
      box.bottom = Math.min(box.bottom, rect.bottom);
    }
  }
  return box;
}

type EqualRange = { before: number; after: number; size: number };

function equalRanges(before: string, after: string): EqualRange[] | null {
  // Animation has a smaller budget than an explicit AI text operation.
  const edits = textEdits(before, after, 120_000);
  if (!edits) return null;
  const ranges: EqualRange[] = [];
  let from = 0;
  let to = 0;
  for (const edit of edits) {
    const size = edit.from - from;
    if (size) ranges.push({ before: from, after: to, size });
    from = edit.to;
    to += size + edit.text.length;
  }
  if (from < before.length) ranges.push({ before: from, after: to, size: before.length - from });
  return ranges;
}

/** Measure the deleted gaps without changing the editable DOM or its history. */
function collapsedRects(
  element: HTMLElement,
  ranges: EqualRange[],
  glyphs: Glyph[],
  pos: number,
  zoom: number,
): Map<number, DOMRect> {
  const rects = new Map<number, DOMRect>();
  const clone = element.cloneNode(true) as HTMLElement;
  const originals = [element, ...element.querySelectorAll<HTMLElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  originals.forEach((original, index) => {
    const copy = copies[index];
    if (!copy) return;
    const style = getComputedStyle(original);
    for (const property of style)
      copy.style.setProperty(property, style.getPropertyValue(property));
    copy.style.visibility = "hidden";
    copy.removeAttribute("id");
  });
  const texts: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const original = node.data;
    node.data = ranges
      .map((range) =>
        original.slice(
          Math.max(0, range.after - offset),
          Math.max(0, Math.min(original.length, range.after + range.size - offset)),
        ),
      )
      .join("");
    offset += original.length;
    const start = texts.at(-1)?.end ?? 0;
    texts.push({ node, start, end: start + node.length });
  }
  const box = element.getBoundingClientRect();
  const host = document.createElement("div");
  host.inert = true;
  host.setAttribute("aria-hidden", "true");
  host.className = "editor-content-motion-measure";
  Object.assign(host.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    visibility: "hidden",
    pointerEvents: "none",
    transform: `scale(${zoom})`,
    transformOrigin: "top left",
    width: `${box.width / zoom}px`,
  });
  Object.assign(clone.style, {
    position: "relative",
    inset: "auto",
    margin: "0",
    transform: "none",
    zoom: "1",
    width: `${box.width / zoom}px`,
    boxSizing: "border-box",
    height: "auto",
    minHeight: "0",
    maxHeight: "none",
    opacity: "1",
    contentVisibility: "visible",
  });
  host.append(clone);
  document.body.append(host);
  try {
    for (const glyph of glyphs) {
      const from = glyph.from - pos - 1;
      const equal = ranges.find(
        (range) => from >= range.after && glyph.to - pos - 1 <= range.after + range.size,
      );
      if (!equal) continue;
      const start =
        ranges.slice(0, ranges.indexOf(equal)).reduce((sum, range) => sum + range.size, 0) +
        from -
        equal.after;
      const end = start + glyph.to - glyph.from;
      const first = texts.find((text) => text.start <= start && text.end > start);
      const last = texts.find((text) => text.start < end && text.end >= end);
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      const rect = range.getBoundingClientRect();
      if (rect.width && rect.height) rects.set(glyph.from, rect);
    }
  } finally {
    host.remove();
  }
  return rects;
}

/** Animate paint only. The editable document, selection and history are already final. */
export function playContentPaint(view: EditorView, saved: ContentPaint): ContentPaintPlayback {
  const animations: Animation[] = [];
  const layer = document.createElement("div");
  layer.className = "editor-content-motion-paint";
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");
  const origin = view.dom.getBoundingClientRect();
  // A shorter document can clamp scrollTop before the first paint. Preserve
  // the old screen positions in that case so the whole visible text moves
  // with the edit, instead of jumping to the new scroll position immediately.
  const startDx = origin.left - saved.rootRect.left;
  const scrollShift = origin.top - saved.rootRect.top;
  const shrinking = origin.height < saved.rootRect.height - 0.1;
  const shrinkingScrollClamp = shrinking && scrollShift > 0.1;
  const startDy = shrinkingScrollClamp ? 0 : scrollShift;
  const scrollHosts: { element: HTMLElement; top: number; height: number; zoom: number }[] = [];
  if (shrinking) {
    for (let element = view.dom.parentElement; element; element = element.parentElement) {
      if (!/(auto|scroll|hidden)/u.test(getComputedStyle(element).overflowY)) continue;
      scrollHosts.push({
        element,
        top: element.scrollTop,
        height: element.clientHeight,
        zoom: element.offsetHeight
          ? element.getBoundingClientRect().height / element.offsetHeight
          : 1,
      });
    }
  }
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "10",
    overflow: "hidden",
  });
  const glyphLayer = document.createElement("div");
  Object.assign(glyphLayer.style, { position: "absolute", inset: "0" });
  layer.append(glyphLayer);
  let active = true;
  let compensateScroll = () => {};
  const syncViewport = () => {
    compensateScroll();
    const rect = view.dom.getBoundingClientRect();
    glyphLayer.style.transform = `translate(${rect.left - origin.left}px, ${rect.top - origin.top}px)`;
    const clip = viewport(view.dom);
    layer.style.clipPath = `inset(${clip.top}px ${Math.max(0, innerWidth - clip.right)}px ${Math.max(0, innerHeight - clip.bottom)}px ${clip.left}px)`;
  };
  syncViewport();
  const budgetExceeded = saved.blocks.some(
    (block) =>
      block.node.isTextblock &&
      !block.glyphs &&
      block.node.content.content.every((child) => child.isText),
  );
  const timing = contentEditMotionTiming();
  const groupDuration = timing.duration;
  const animate = (element: HTMLElement, frames: Keyframe[]) => {
    const animation = element.animate(frames, timing);
    animation.id = "editor-content-motion";
    animations.push(animation);
  };
  const currentBudget = { remaining: MAX_GLYPHS };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resize: ResizeObserver | null = null;
  let frame: number | null = null;
  let scrollAnimation: Animation | null = null;
  let scrollOffset = 0;
  compensateScroll = () => {
    let shift = 0;
    for (const host of scrollHosts) {
      const maximum = Math.max(0, host.element.scrollHeight - host.element.clientHeight);
      const top = host.element.scrollTop;
      // Only absorb a shrinking extent's automatic bottom clamp, never an
      // ordinary caret/programmatic scroll or a viewport resize.
      if (
        host.element.clientHeight === host.height &&
        host.top > maximum + 0.1 &&
        Math.abs(top - maximum) < 1
      )
        shift += (host.top - top) * host.zoom;
      host.top = top;
    }
    if (shift <= 0.1 || !animations.length) return;
    const elapsed = Number(animations[0]?.currentTime ?? 0);
    const remaining = groupDuration - elapsed;
    if (remaining <= 0) return;
    const progress = scrollAnimation?.effect?.getComputedTiming().progress ?? 0;
    scrollOffset = scrollOffset * (1 - progress) - shift;
    scrollAnimation?.cancel();
    const zoom = view.dom.offsetWidth ? origin.width / view.dom.offsetWidth : 1;
    // Translate the native root as well as its inert glyphs. Unedited blocks
    // and the ruler's hidden paragraph anchors must not jump either. Additive
    // translate preserves the root's existing layout/dual-column transforms.
    scrollAnimation = view.dom.animate(
      [{ translate: `0 ${scrollOffset / zoom}px` }, { translate: "0 0" }],
      { duration: remaining, easing: timing.easing, composite: "add" },
    );
    scrollAnimation.id = "editor-content-motion";
    animations.push(scrollAnimation);
  };
  const notifyGeometry = () =>
    view.dom.dispatchEvent(new Event(CONTENT_PAINT_FRAME, { bubbles: true }));
  const cleanup = () => {
    active = false;
    clearTimeout(timer);
    resize?.disconnect();
    for (const animation of animations) {
      animation.onfinish = null;
      animation.cancel();
    }
    layer.remove();
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
      notifyGeometry();
    }
  };
  const playback = {
    stop: cleanup,
    syncScroll() {
      if (!active) return;
      try {
        syncViewport();
      } catch {
        // Late resize/scroll callbacks have the same native-paint fallback
        // as initial geometry capture; they must never leave text hidden.
        cleanup();
      }
    },
  };
  try {
    // Joining paragraphs can retain text from several old blocks in one new block.
    const mappedGlyphs = new Map<number, Glyph>();
    for (const block of saved.blocks) {
      for (const glyph of block.glyphs ?? []) {
        const from = saved.mapping.mapResult(glyph.from, 1);
        const to = saved.mapping.mapResult(glyph.to, -1);
        if (!from.deleted && !to.deleted && to.pos - from.pos === glyph.to - glyph.from)
          mappedGlyphs.set(from.pos, glyph);
      }
    }
    view.state.doc.descendants((node, pos) => {
      if (!isPaintBlock(node)) return true;
      const element = view.nodeDOM(pos);
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      if (!visible(rect)) return false;
      const old =
        saved.blocks.find(
          (block) =>
            block.node.type === node.type &&
            saved.mapping.map(block.pos + 1, 1) === pos + 1 &&
            saved.mapping.map(block.pos + block.node.nodeSize - 1, -1) === pos + node.nodeSize - 1,
        ) ??
        saved.blocks.find((block) => {
          const from = saved.mapping.mapResult(block.pos + 1, 1);
          const to = saved.mapping.mapResult(block.pos + block.node.nodeSize - 1, -1);
          // ProseMirror can reuse the old element for a newly pasted paragraph.
          // Do not borrow its text when the old content survives in another block.
          if (
            !from.deleted &&
            !to.deleted &&
            (from.pos > pos + node.nodeSize - 1 || to.pos < pos + 1)
          )
            return false;
          return (
            block.element === element ||
            (node.attrs.nodeId && block.node.attrs.nodeId === node.attrs.nodeId)
          );
        });
      const dx = old ? old.rect.left + startDx - rect.left : 0;
      const dy = old ? old.rect.top + startDy - rect.top : 0;
      const moved = Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1;
      if (old?.node.eq(node)) {
        if (moved)
          animate(element, [
            { transform: `translate(${dx / old.zoom}px, ${dy / old.zoom}px)` },
            { transform: "translate(0, 0)" },
          ]);
        return false;
      }
      if (
        budgetExceeded ||
        !node.isTextblock ||
        node.content.content.some((child) => !child.isText) ||
        (old && !old.glyphs)
      ) {
        if (old && moved)
          animate(element, [
            { transform: `translate(${dx / old.zoom}px, ${dy / old.zoom}px)` },
            { transform: "translate(0, 0)" },
          ]);
        return false;
      }
      const ranges = old ? equalRanges(old.node.textContent, node.textContent) : [];
      if (!ranges) return false;
      const glyphs = captureGlyphs(view, node, pos, old?.zoom ?? 1, currentBudget);
      if (!glyphs?.length) return false;
      const retained = new Map<number, Glyph>();
      const mapped = new Set<Glyph>();
      // Real transaction mapping takes precedence (notably repeated-character deletions).
      for (const glyph of glyphs) {
        const previous = mappedGlyphs.get(glyph.from);
        if (
          previous &&
          previous.to - previous.from === glyph.to - glyph.from &&
          previous.paint.textContent === glyph.paint.textContent
        ) {
          retained.set(glyph.from, previous);
          mapped.add(previous);
        }
      }
      // A canonical update may replace the entire interval between several edits.
      // Recover equal text inside that interval instead of dropping it as deleted.
      for (const glyph of old?.glyphs ?? []) {
        if (mapped.has(glyph) || !old) continue;
        const offset = glyph.from - old.pos - 1;
        const equal = ranges.find(
          (range) => offset >= range.before && glyph.to - old.pos - 1 <= range.before + range.size,
        );
        if (!equal) continue;
        const from = pos + 1 + equal.after + offset - equal.before;
        if (!retained.has(from)) retained.set(from, glyph);
      }
      const surviving = glyphs.filter((glyph) => retained.has(glyph.from));
      // A new/mostly replaced paragraph must never spend a frame as an empty layer.
      // Keep its native paint visible and use a gentle reveal when correspondence is weak.
      if (!surviving.length || surviving.length < glyphs.length * 0.3) {
        animate(element, [
          { opacity: 0.65, transform: `translate(0, ${2 / (old?.zoom ?? 1)}px)` },
          { opacity: 1, transform: "translate(0, 0)" },
        ]);
        return false;
      }
      const inserted = glyphs.length > surviving.length;
      const deleted =
        old && ranges.reduce((size, range) => size + range.size, 0) < old.node.textContent.length;
      const collapsed =
        inserted && deleted
          ? collapsedRects(element, ranges, surviving, pos, old?.zoom ?? 1)
          : new Map<number, DOMRect>();
      for (const glyph of glyphs) {
        const { paint, rect } = glyph;
        const previous = retained.get(glyph.from);
        paint.dataset.motionKind = previous ? "retained" : "inserted";
        Object.assign(paint.style, { left: `${rect.left}px`, top: `${rect.top}px` });
        glyphLayer.append(paint);
        if (previous) {
          const start = {
            transform: `translate(${previous.rect.left + startDx - rect.left}px, ${previous.rect.top + startDy - rect.top}px)`,
          };
          const joined = collapsed.get(glyph.from);
          animate(
            paint,
            joined
              ? [
                  { ...start, offset: 0 },
                  {
                    transform: `translate(${joined.left - rect.left}px, ${joined.top - rect.top}px)`,
                    offset: 0.45,
                  },
                  { transform: "translate(0, 0)", offset: 1 },
                ]
              : [start, { transform: "translate(0, 0)" }],
          );
        } else {
          animate(paint, [
            { opacity: 0, transform: "translate(0, 2px)", offset: 0 },
            { opacity: 0, transform: "translate(0, 2px)", offset: 0.45 },
            { opacity: 1, transform: "translate(0, 0)", offset: 1 },
          ]);
        }
      }
      // Hide native text only after every visible final glyph has a replacement paint.
      if (shrinkingScrollClamp && old && moved) {
        // Keep the hidden block's ruler anchor in step with its replacement glyphs.
        animate(element, [
          { opacity: 0, transform: `translate(${dx / old.zoom}px, ${dy / old.zoom}px)` },
          { opacity: 0, transform: "translate(0, 0)" },
        ]);
      } else animate(element, [{ opacity: 0 }, { opacity: 0 }]);
      return false;
    });
    if (glyphLayer.childNodes.length) document.body.append(layer);
    // A shrinking native-only block still needs a timing owner if its scroll
    // extent settles later (for example while the ruler holds the old height).
    if (shrinking && !animations.length)
      animate(view.dom, [{ translate: "0 0" }, { translate: "0 0" }]);
    if (glyphLayer.childNodes.length || (shrinking && animations.length)) {
      // A shrinking scroll extent can clamp scrollTop before the next scroll event.
      // Resize callbacks run before paint, keeping the glyphs aligned in that frame.
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(playback.syncScroll);
        for (let element: HTMLElement | null = view.dom; element; element = element.parentElement)
          resize.observe(element);
      }
    }
    // Glyphs and the native-paint switch finish together.
    synchronizePaintTimings(animations, groupDuration);
    const startTime = document.timeline?.currentTime;
    if (typeof startTime === "number")
      for (const animation of animations) animation.startTime = startTime;
  } catch {
    // Geometry/animation support must never leave the editable paragraph hidden.
    cleanup();
    return playback;
  }
  const last = animations.at(-1);
  if (last) {
    last.onfinish = cleanup;
    timer = setTimeout(cleanup, groupDuration + 100);
    if (shrinking) {
      // The ruler reads painted block positions. Refresh them while automatic
      // scroll compensation moves, and once more after native paint is restored.
      const tick = () => {
        playback.syncScroll();
        if (!active) return;
        notifyGeometry();
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }
  } else cleanup();
  return playback;
}
