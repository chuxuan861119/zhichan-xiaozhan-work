import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { prefersReducedMotion as isMotionReduced } from "../../shared/motion-preference";
import {
  type ContentPaint,
  type ContentPaintPlayback,
  captureContentPaint,
  playContentPaint,
} from "./content-layout-paint";

function sameEditingContent(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  if (before === after) return true;
  if (before.content.size !== after.content.size) return false;
  if (before.isTextblock && after.isTextblock) {
    // Marks split/merge text nodes. Fragment.from merges adjacent unmarked text,
    // while retaining inline atoms and their attributes (formulas, images, etc.).
    const unmarked = (node: ProseMirrorNode) =>
      Fragment.from(node.content.content.map((child) => child.mark([])));
    return unmarked(before).eq(unmarked(after));
  }
  if (!before.sameMarkup(after) || before.childCount !== after.childCount) return false;
  for (let index = 0; index < before.childCount; index += 1) {
    if (!sameEditingContent(before.child(index), after.child(index))) return false;
  }
  return true;
}

/** Ordinary typing stays immediate; discrete edits may animate their paint. */
export function shouldAnimateContentEdit(
  transaction: Transaction,
  before: EditorState,
  typing = false,
): boolean {
  if (!transaction.docChanged || transaction.getMeta("composition") !== undefined) return false;
  // Formatting (including undo/redo) must never cross-fade a paragraph to zero
  // opacity. Only edits to content/structure participate in retained paint.
  if (sameEditingContent(before.doc, transaction.doc)) return false;
  if (transaction.getMeta("uiEvent") === "paste" || transaction.getMeta("uiEvent") === "drop")
    return true;
  if (isHistoryTransaction(transaction)) return true;
  if (typing) return false;
  if (!before.selection.empty) return true;
  return transaction.steps.some((step) => {
    const value = step.toJSON();
    if (value.stepType !== "replace") return true;
    if (value.to - value.from > 1) return true;
    return (value.slice?.content ?? []).some(
      (node: { type: string; text?: string }) =>
        node.type !== "text" || (node.text?.length ?? 0) > 1,
    );
  });
}

export const ContentLayoutMotion = Extension.create({
  name: "contentLayoutMotion",
  addProseMirrorPlugins() {
    let view: EditorView | null = null;
    let paints: ContentPaint | null = null;
    let prepared: { doc: ProseMirrorNode; paint: ContentPaint } | null = null;
    let generation = 0;
    let pointerHeld = false;
    let playback: ContentPaintPlayback | null = null;
    let typingDoc: ProseMirrorNode | null = null;
    let typingTimer: number | undefined;
    const clearTyping = () => {
      window.clearTimeout(typingTimer);
      typingTimer = undefined;
      typingDoc = null;
    };
    const noteTyping = (current: EditorView) => {
      clearTyping();
      typingDoc = current.state.doc;
      // Native DOM changes are observed before the next task. An unhandled or
      // cancelled input must not suppress an unrelated later command.
      typingTimer = window.setTimeout(clearTyping, 0);
      prepared = null;
    };
    const stop = () => {
      playback?.stop();
      playback = null;
    };
    const reduced = () =>
      document.documentElement.dataset.reducedMotion === "true" || isMotionReduced();
    const capture = (current: EditorView, mapping: Mapping): ContentPaint | null => {
      try {
        return captureContentPaint(current, mapping);
      } catch {
        // Native edits may already have changed DOM before the transaction arrives.
        // Geometry is optional; it must never abort the actual document edit.
        return null;
      }
    };
    const prepare = (current: EditorView) => {
      if (
        current.composing ||
        pointerHeld ||
        reduced() ||
        typeof current.dom.animate !== "function"
      )
        return;
      if (prepared?.doc === current.state.doc) return;
      const paint = capture(current, new Mapping());
      prepared = paint ? { doc: current.state.doc, paint } : null;
    };
    return [
      new Plugin({
        props: {
          handleTextInput(current) {
            // Some native/IME text commits omit beforeinput. Observe the source
            // without handling it, so input rules and native editing keep control.
            noteTyping(current);
            return false;
          },
        },
        state: {
          init: () => null,
          apply(transaction, _value, before) {
            if (!transaction.docChanged) return null;
            const typing = typingDoc === before.doc;
            clearTyping();
            // Appended normalization runs before the view is painted. Carry the
            // original positions through every step instead of recapturing stale DOM.
            if (paints) {
              paints.mapping.appendMapping(transaction.mapping);
              return null;
            }
            stop();
            generation += 1;
            paints = null;
            const snapshot = prepared?.doc === before.doc ? prepared.paint : null;
            prepared = null;
            if (
              !view ||
              view.composing ||
              pointerHeld ||
              reduced() ||
              !shouldAnimateContentEdit(transaction, before, typing) ||
              typeof view.dom.animate !== "function"
            )
              return null;
            const mapping = new Mapping(transaction.mapping.maps);
            paints = snapshot ? { ...snapshot, mapping } : capture(view, mapping);
            return null;
          },
        },
        view(current) {
          view = current;
          const cancel = () => {
            generation += 1;
            stop();
          };
          const invalidate = () => {
            clearTyping();
            prepared = null;
            cancel();
          };
          const beforeInput = (event: Event) => {
            cancel();
            clearTyping();
            const input = event as InputEvent;
            if (
              /^(insertText|insertCompositionText|insertFromComposition|insertReplacementText|insertParagraph|insertLineBreak)$/u.test(
                input.inputType,
              )
            ) {
              noteTyping(current);
              return;
            }
            if (
              !current.state.selection.empty ||
              /^(insertFromPaste|insertFromDrop|insertReplacementText|historyUndo|historyRedo|deleteWord|deleteHardLine|deleteSoftLine)/u.test(
                input.inputType,
              )
            )
              prepare(current);
          };
          const keyDown = (event: KeyboardEvent) => {
            cancel();
            clearTyping();
            if (
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              (event.key.length === 1 || event.key === "Enter")
            ) {
              noteTyping(current);
              return;
            }
            if (
              !current.state.selection.empty ||
              ((event.ctrlKey || event.metaKey) && /^(Backspace|Delete|[vxyz])$/iu.test(event.key))
            )
              prepare(current);
          };
          const clipboard = () => {
            cancel();
            clearTyping();
            prepare(current);
          };
          const affectsEditor = (event: Event) =>
            event.target === window ||
            event.target === document ||
            (event.target instanceof Element && event.target.contains(current.dom));
          const scroll = (event: Event) => {
            if (!affectsEditor(event)) return;
            prepared = null;
            // Content-height changes and caret visibility can scroll the editor
            // without user input. Keep its inert paint aligned instead of cancelling.
            playback?.syncScroll();
          };
          const wheel = (event: Event) => {
            if (
              affectsEditor(event) ||
              (event.target instanceof Node && current.dom.contains(event.target))
            )
              invalidate();
          };
          current.dom.addEventListener("beforeinput", beforeInput, true);
          current.dom.addEventListener("keydown", keyDown, true);
          current.dom.addEventListener("paste", clipboard, true);
          current.dom.addEventListener("cut", clipboard, true);
          current.dom.addEventListener("compositionstart", invalidate, true);
          window.addEventListener("scroll", scroll, true);
          window.addEventListener("wheel", wheel, { capture: true, passive: true });
          window.addEventListener("resize", invalidate);
          const pointerDown = () => {
            pointerHeld = true;
            invalidate();
          };
          const pointerUp = () => {
            pointerHeld = false;
            if (!current.state.selection.empty) prepare(current);
          };
          const blur = () => {
            pointerHeld = false;
            invalidate();
          };
          window.addEventListener("pointerdown", pointerDown, true);
          window.addEventListener("pointerup", pointerUp, true);
          window.addEventListener("pointercancel", pointerUp, true);
          window.addEventListener("blur", blur);
          return {
            update() {
              const saved = paints;
              paints = null;
              // Native delete/insertText commands can omit beforeinput entirely.
              // A stable selection update is the last chance to measure old DOM.
              if (!current.state.selection.empty) prepare(current);
              else prepared = null;
              if (!saved?.blocks.length) return;
              const expected = generation;
              queueMicrotask(() => {
                if (expected !== generation || !view || view.isDestroyed || reduced()) return;
                // Dedicated table operations own their established animation.
                if (
                  current.dom
                    .getAnimations({ subtree: true })
                    .some((animation) => animation.id.startsWith("table-"))
                )
                  return;
                if (
                  Array.from(current.dom.querySelectorAll("table")).some((table) =>
                    table
                      .getAnimations({ subtree: true })
                      .some((animation) => animation.id.startsWith("table-")),
                  )
                )
                  return;
                playback = playContentPaint(current, saved);
              });
            },
            destroy() {
              invalidate();
              view = null;
              current.dom.removeEventListener("beforeinput", beforeInput, true);
              current.dom.removeEventListener("keydown", keyDown, true);
              current.dom.removeEventListener("paste", clipboard, true);
              current.dom.removeEventListener("cut", clipboard, true);
              current.dom.removeEventListener("compositionstart", invalidate, true);
              window.removeEventListener("scroll", scroll, true);
              window.removeEventListener("wheel", wheel, true);
              window.removeEventListener("resize", invalidate);
              window.removeEventListener("pointerdown", pointerDown, true);
              window.removeEventListener("pointerup", pointerUp, true);
              window.removeEventListener("pointercancel", pointerUp, true);
              window.removeEventListener("blur", blur);
            },
          };
        },
      }),
    ];
  },
});
