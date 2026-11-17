import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type {} from "@tiptap/extension-color";
import type {} from "@tiptap/extension-font-family";
import type {} from "@tiptap/extension-subscript";
import type {} from "@tiptap/extension-superscript";
import type {} from "@tiptap/extension-text-align";
import type {} from "@tiptap/starter-kit";
import { build } from "vite";

let fixture = "";
declare global {
  interface Window {
    motionEditor: Editor;
  }
}
test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: {
        entry: path.resolve("tests/fixtures/content-motion-browser.mjs"),
        name: "MotionFixture",
        formats: ["iife"],
      },
      minify: false,
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  fixture = outputs
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((chunk) => chunk.type === "chunk")
    .map((chunk) => chunk.code)
    .join("\n");
});
test.beforeEach(async ({ page }, testInfo) => {
  await page.setContent(
    '<style>#editor{width:450px;margin:40px;font:18px sans-serif}p{margin:0 0 20px}</style><div id="editor"></div>',
  );
  await page.evaluate(
    (platform) => {
      Object.defineProperty(window, "documentFontPlatform", {
        configurable: true,
        value: platform,
      });
    },
    testInfo.title.includes("Mac: native")
      ? "darwin"
      : testInfo.title.includes("Harmony: native")
        ? "openharmony"
        : "win32",
  );
  if (testInfo.title.includes(": native")) {
    const platform = testInfo.title.includes("Windows")
      ? "Win32"
      : testInfo.title.includes("Harmony")
        ? "Linux aarch64"
        : "MacIntel";
    await page.evaluate(
      (platform) =>
        Object.defineProperty(navigator, "platform", { configurable: true, value: platform }),
      platform,
    );
  }
  await page.addScriptTag({ content: fixture });
});
test("format changes and their history keep paragraph paint visible", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const editor = window.motionEditor;
    const samples = [];
    const operations = [
      ["bold", () => editor.commands.toggleBold()],
      ["remove bold", () => editor.commands.toggleBold()],
      ["underline", () => editor.commands.toggleUnderline()],
      ["remove underline", () => editor.commands.toggleUnderline()],
      ["italic", () => editor.commands.toggleItalic()],
      ["superscript", () => editor.commands.toggleSuperscript()],
      ["subscript", () => editor.commands.toggleSubscript()],
      ["font size", () => editor.commands.setMark("textStyle", { fontSizePt: 18 })],
      ["color", () => editor.commands.setColor("#ff0000")],
      ["font family", () => editor.commands.setFontFamily("serif")],
      ["alignment", () => editor.commands.setTextAlign("right")],
      [
        "paragraph spacing",
        () => editor.commands.updateAttributes("paragraph", { spaceAfterPt: 20 }),
      ],
      ["heading", () => editor.commands.setHeading({ level: 2 })],
      ["clear formatting", () => editor.commands.unsetAllMarks()],
      ["undo", () => editor.commands.undo()],
      ["redo", () => editor.commands.redo()],
    ] as const;
    editor.commands.setTextSelection({ from: 2, to: 5 });
    const originalText = editor.getText();
    for (const [name, operation] of operations) {
      const before = JSON.stringify(editor.getJSON());
      operation();
      await Promise.resolve();
      const paragraph = editor.view.dom.firstElementChild;
      if (!paragraph) throw new Error("missing editor paragraph");
      samples.push({
        name,
        changed: JSON.stringify(editor.getJSON()) !== before,
        animations: document.getAnimations().filter((a) => a.id === "editor-content-motion").length,
        layers: document.querySelectorAll(".editor-content-motion-paint").length,
        opacity: getComputedStyle(paragraph).opacity,
        textUnchanged: editor.getText() === originalText,
        selection: { from: editor.state.selection.from, to: editor.state.selection.to },
      });
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
    }
    return samples;
  });
  for (const result of results) {
    expect(result, result.name).toMatchObject({
      changed: true,
      animations: 0,
      layers: 0,
      opacity: "1",
      textUnchanged: true,
      selection: { from: 2, to: 5 },
    });
  }
});

for (const operation of ["delete", "paste"] as const) {
  test(`bottom ${operation} keeps paint aligned through automatic scroll`, async ({ page }) => {
    const result = await page.evaluate(async (operation) => {
      const editor = window.motionEditor;
      const host = document.querySelector<HTMLElement>("#editor");
      if (!host) throw new Error("missing host");
      Object.assign(host.style, { height: "240px", overflow: "auto" });
      editor
        .chain()
        .setMeta("addToHistory", false)
        .setContent(
          Array.from(
            { length: 12 },
            (_, i) => `<p>第${i}段：${"用于测试页面滚动与文字动画。".repeat(6)}</p>`,
          ).join(""),
        )
        .run();
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      const original = editor.getText();
      const end = editor.state.doc.content.size - 1;
      editor.commands.setTextSelection({ from: end - 60, to: end - 10 });
      host.scrollTop = host.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const beforeTop = host.scrollTop;
      if (operation === "delete") editor.commands.deleteSelection();
      else
        editor.commands.insertContent("新文字", { parseOptions: { preserveWhitespace: "full" } });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const layer = document.querySelector<HTMLElement>(".editor-content-motion-paint");
      const animations = document.getAnimations().filter((a) => a.id === "editor-content-motion");
      // Final paint must land at the real glyph position after the browser clamps scrollTop.
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 649;
      }
      const afterTop = host.scrollTop;
      // A later caret/programmatic scroll must also move already playing glyphs.
      host.scrollTop -= 25;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const glyph = layer?.querySelector<HTMLElement>("[data-motion-kind='retained']");
      const last = editor.view.dom.lastElementChild;
      const text = last?.firstChild;
      if (!text) throw new Error("missing final paragraph text");
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const native = range.getBoundingClientRect();
      const painted = glyph?.getBoundingClientRect();
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      editor.commands.undo();
      const restored = editor.getText() === original;
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      return {
        beforeTop,
        afterTop,
        active: animations.length,
        errorX: painted ? Math.abs(painted.left - native.left) : null,
        errorY: painted ? Math.abs(painted.top - native.top) : null,
        restored,
        cleaned: !document.querySelector(".editor-content-motion-paint"),
      };
    }, operation);
    expect(result.afterTop).toBeLessThan(result.beforeTop);
    expect(result.active).toBeGreaterThan(0);
    expect(result.errorX).not.toBeNull();
    expect(result.errorY).not.toBeNull();
    expect(result.errorX).toBeLessThan(1);
    expect(result.errorY).toBeLessThan(1);
    expect(result.restored).toBe(true);
    expect(result.cleaned).toBe(true);
  });
}
for (const bottomGap of [0, 30, 180]) {
  test(`bottom deletion absorbs scroll clamp without a first-frame jump (gap ${bottomGap})`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (bottomGap) => {
      const editor = window.motionEditor;
      const host = document.querySelector<HTMLElement>("#editor");
      if (!host) throw new Error("missing host");
      Object.assign(host.style, { height: "300px", overflow: "auto" });
      const paper = document.createElement("div");
      Object.assign(paper.style, { padding: "28px 12px", background: "white" });
      editor.view.dom.before(paper);
      paper.append(editor.view.dom);
      editor
        .chain()
        .setMeta("addToHistory", false)
        .setContent(
          Array.from(
            { length: 12 },
            (_, i) => `<p>第${i}段：${"检查底部文字删除后的页面位置。".repeat(8)}</p>`,
          ).join(""),
        )
        .run();
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      const original = JSON.stringify(editor.getJSON());
      const end = editor.state.doc.content.size - 1;
      editor.commands.setTextSelection({ from: end - 70, to: end - 10 });
      host.scrollTop = host.scrollHeight - host.clientHeight - bottomGap;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const preceding = editor.view.dom.children[10];
      const last = editor.view.dom.lastElementChild;
      if (!preceding || !last?.firstChild) throw new Error("missing final paragraphs");
      const range = document.createRange();
      range.setStart(last.firstChild, 0);
      range.setEnd(last.firstChild, 1);
      const oldGlyph = range.getBoundingClientRect();
      const oldTop = preceding.getBoundingClientRect().top;
      const oldLastTop = last.getBoundingClientRect().top;
      const oldScroll = host.scrollTop;
      let motionFrames = 0;
      const onMotionFrame = () => {
        motionFrames += 1;
      };
      editor.view.dom.addEventListener("editor-content-motion-frame", onMotionFrame);
      editor.commands.deleteSelection();
      await Promise.resolve();
      const glyph = document.querySelector<HTMLElement>("[data-motion-kind='retained']");
      if (!glyph) throw new Error("missing retained glyph");
      const animations = document.getAnimations().filter((a) => a.id === "editor-content-motion");
      const sample = (time: number) => {
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = time;
        }
        return {
          top: preceding.getBoundingClientRect().top,
          glyphTop: glyph.getBoundingClientRect().top,
          lastTop: last.getBoundingClientRect().top,
        };
      };
      const start = sample(0);
      const middle = sample(325);
      const final = sample(650);
      const finalGlyph = range.getBoundingClientRect().top;
      const newScroll = host.scrollTop;
      const durations = animations.map((a) => a.effect?.getTiming().duration);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      const framesAtStop = motionFrames;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const framesAfterStop = motionFrames;
      editor.view.dom.removeEventListener("editor-content-motion-frame", onMotionFrame);
      const cleaned = !document.querySelector(".editor-content-motion-paint");
      const nativeTop = preceding.getBoundingClientRect().top;
      editor.commands.undo();
      const restored = JSON.stringify(editor.getJSON()) === original;
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      return {
        oldTop,
        oldLastTop,
        oldGlyphTop: oldGlyph.top,
        oldScroll,
        newScroll,
        start,
        middle,
        final,
        finalGlyph,
        nativeTop,
        cleaned,
        restored,
        durations,
        framesAtStop,
        framesAfterStop,
      };
    }, bottomGap);
    const shift = result.oldScroll - result.newScroll;
    if (bottomGap < 100) expect(shift).toBeGreaterThan(0);
    else expect(shift).toBe(0);
    expect(Math.abs(result.start.top - result.oldTop)).toBeLessThan(1);
    expect(Math.abs(result.start.glyphTop - result.oldGlyphTop)).toBeLessThan(1);
    expect(Math.abs(result.start.lastTop - result.oldLastTop)).toBeLessThan(1);
    expect(result.middle.top).toBeCloseTo((result.oldTop + result.final.top) / 2, 0);
    expect(Math.abs(result.final.glyphTop - result.finalGlyph)).toBeLessThan(1);
    expect(Math.abs(result.final.top - result.nativeTop)).toBeLessThan(1);
    expect(result.durations.every((duration) => duration === 650)).toBe(true);
    if (shift > 0) expect(result.framesAtStop).toBeGreaterThan(1);
    expect(result.framesAfterStop).toBe(result.framesAtStop);
    expect(result.cleaned).toBe(true);
    expect(result.restored).toBe(true);
  });
}

for (const [shrinkTime, zoom] of [
  [0, 1],
  [200, 1],
  [200, 1.5],
] as const) {
  test(`late bottom scroll clamp preserves the painted position (${shrinkTime}ms, zoom ${zoom})`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ shrinkTime, zoom }) => {
        const editor = window.motionEditor;
        const host = document.querySelector<HTMLElement>("#editor");
        if (!host) throw new Error("missing host");
        Object.assign(host.style, { height: "300px", overflow: "auto", overflowAnchor: "none" });
        const extent = document.createElement("div");
        extent.style.zoom = String(zoom);
        host.append(extent);
        extent.append(editor.view.dom);
        editor
          .chain()
          .setMeta("addToHistory", false)
          .setContent(
            Array.from(
              { length: 12 },
              (_, i) => `<p>第${i}段：${"检查底部文字删除后的页面位置。".repeat(8)}</p>`,
            ).join(""),
          )
          .run();
        editor.view.dom.dispatchEvent(new Event("beforeinput"));
        const original = JSON.stringify(editor.getJSON());
        extent.style.height = `${editor.view.dom.getBoundingClientRect().height / zoom + 28}px`;
        const end = editor.state.doc.content.size - 1;
        editor.commands.setTextSelection({ from: end - 70, to: end - 10 });
        host.scrollTop = host.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const preceding = editor.view.dom.children[10];
        if (!(preceding instanceof HTMLElement)) throw new Error("missing preceding paragraph");
        const oldTop = preceding.getBoundingClientRect().top;
        const oldScroll = host.scrollTop;
        editor.commands.deleteSelection();
        await Promise.resolve();
        const animations = document.getAnimations().filter((a) => a.id === "editor-content-motion");
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = shrinkTime;
        }
        const glyph = document.querySelector<HTMLElement>("[data-motion-kind='retained']");
        if (!glyph) throw new Error("missing retained glyph");
        const before = {
          top: preceding.getBoundingClientRect().top,
          glyphTop: glyph.getBoundingClientRect().top,
        };
        let motionFrames = 0;
        const notify = () => {
          motionFrames += 1;
        };
        editor.view.dom.addEventListener("editor-content-motion-frame", notify);
        const nextHeight = editor.view.dom.getBoundingClientRect().height + 28 * zoom;
        const after = await new Promise<{ top: number; glyphTop: number; scroll: number }>(
          (resolve) => {
            const probe = new ResizeObserver(() => {
              if (Math.abs(extent.getBoundingClientRect().height - nextHeight) > 1) return;
              probe.disconnect();
              resolve({
                top: preceding.getBoundingClientRect().top,
                glyphTop: glyph.getBoundingClientRect().top,
                scroll: host.scrollTop,
              });
            });
            probe.observe(extent);
            extent.style.height = `${nextHeight / zoom}px`;
          },
        );
        // A second layout owner may release its stale height later in the same
        // edit. Retarget from the currently painted position, not the first one.
        for (const animation of document
          .getAnimations()
          .filter((a) => a.id === "editor-content-motion")) {
          animation.pause();
          if (
            animation.effect instanceof KeyframeEffect &&
            animation.effect.target === editor.view.dom
          )
            animation.currentTime = 80;
        }
        host.dispatchEvent(new Event("scroll"));
        const beforeSecond = {
          top: preceding.getBoundingClientRect().top,
          glyphTop: glyph.getBoundingClientRect().top,
        };
        const afterSecond = await new Promise<{ top: number; glyphTop: number }>((resolve) => {
          const probe = new ResizeObserver(() => {
            if (Math.abs(extent.getBoundingClientRect().height - (nextHeight - 8 * zoom)) > 1)
              return;
            probe.disconnect();
            resolve({
              top: preceding.getBoundingClientRect().top,
              glyphTop: glyph.getBoundingClientRect().top,
            });
          });
          probe.observe(extent);
          extent.style.height = `${nextHeight / zoom - 8}px`;
        });
        const all = document.getAnimations().filter((a) => a.id === "editor-content-motion");
        for (const animation of all) {
          animation.pause();
          animation.currentTime = Number(animation.effect?.getTiming().duration);
        }
        const finalTop = preceding.getBoundingClientRect().top;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        editor.view.dom.dispatchEvent(new Event("beforeinput"));
        const stoppedFrames = motionFrames;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const clean =
          !document.querySelector(".editor-content-motion-paint") &&
          !document.getAnimations().some((a) => a.id === "editor-content-motion");
        const nativeTop = preceding.getBoundingClientRect().top;
        editor.commands.undo();
        const restored = JSON.stringify(editor.getJSON()) === original;
        editor.view.dom.dispatchEvent(new Event("beforeinput"));
        editor.view.dom.removeEventListener("editor-content-motion-frame", notify);
        return {
          oldTop,
          oldScroll,
          before,
          after,
          beforeSecond,
          afterSecond,
          finalTop,
          nativeTop,
          restored,
          clean,
          stoppedFrames,
          finalFrames: motionFrames,
        };
      },
      { shrinkTime, zoom },
    );
    expect(result.oldScroll).toBeGreaterThan(result.after.scroll);
    expect(Math.abs(result.before.top - result.oldTop)).toBeLessThan(1);
    expect(Math.abs(result.after.top - result.before.top)).toBeLessThan(1);
    expect(Math.abs(result.after.glyphTop - result.before.glyphTop)).toBeLessThan(1);
    expect(Math.abs(result.afterSecond.top - result.beforeSecond.top)).toBeLessThan(1);
    expect(Math.abs(result.afterSecond.glyphTop - result.beforeSecond.glyphTop)).toBeLessThan(1);
    expect(Math.abs(result.finalTop - result.nativeTop)).toBeLessThan(1);
    expect(result.stoppedFrames).toBeGreaterThan(0);
    expect(result.finalFrames).toBe(result.stoppedFrames);
    expect(result.restored).toBe(true);
    expect(result.clean).toBe(true);
  });
}

test("wrapped-line deletion keeps paint aligned in the frame that the scroll extent shrinks", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    const host = document.querySelector<HTMLElement>("#editor");
    if (!host) throw new Error("missing host");
    Object.assign(host.style, { height: "240px", overflow: "auto" });
    const extent = document.createElement("div");
    host.append(extent);
    extent.append(editor.view.dom);
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(
        `${"<p>此前段落内容。</p>".repeat(12)}<p>末段${"甲乙丙丁戊己庚辛壬癸".repeat(12)}。</p>`,
      )
      .run();
    editor.view.dom.dispatchEvent(new Event("beforeinput"));
    const original = editor.getJSON();
    // The application scroll extent can settle after the editable DOM has updated.
    extent.style.height = `${editor.view.dom.getBoundingClientRect().height + 60}px`;
    const lastNode = editor.state.doc.lastChild;
    if (!lastNode) throw new Error("missing last node");
    const pos = editor.state.doc.content.size - lastNode.nodeSize;
    editor.commands.setTextSelection({ from: pos + 11, to: pos + 66 });
    host.scrollTop = host.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const oldTop = host.scrollTop;
    const text = editor.view.dom.lastElementChild?.firstChild;
    if (!text) throw new Error("missing last paragraph");
    const range = document.createRange();
    range.setStart(text, 10);
    range.setEnd(text, 11);
    const fromTop = range.getBoundingClientRect().top;
    range.setStart(text, 65);
    range.setEnd(text, 66);
    const toTop = range.getBoundingClientRect().top;
    editor.commands.deleteSelection();
    await Promise.resolve();
    const layer = document.querySelector<HTMLElement>(".editor-content-motion-paint");
    const glyph = Array.from(layer?.querySelectorAll<HTMLElement>("[data-motion-kind]") ?? []).find(
      (glyph) => glyph.textContent === "末",
    );
    if (!glyph) throw new Error("missing retained prefix");
    for (const animation of document.getAnimations()) {
      if (animation.id !== "editor-content-motion") continue;
      animation.pause();
      animation.currentTime = 325;
    }
    const nextHeight = editor.view.dom.getBoundingClientRect().height + 60;
    // Sample before paint, without waiting for the following frame's scroll event.
    const frame = await new Promise<{ error: number; afterTop: number; opacity: string }>(
      (resolve) => {
        const probe = new ResizeObserver(() => {
          if (Math.abs(extent.getBoundingClientRect().height - nextHeight) > 1) return;
          const nativeText = editor.view.dom.lastElementChild?.firstChild;
          if (!nativeText) throw new Error("missing final text");
          range.setStart(nativeText, 0);
          range.setEnd(nativeText, 1);
          const native = range.getBoundingClientRect();
          const paint = glyph.getBoundingClientRect();
          probe.disconnect();
          resolve({
            error: Math.hypot(paint.left - native.left, paint.top - native.top),
            afterTop: host.scrollTop,
            opacity: getComputedStyle(glyph).opacity,
          });
        });
        probe.observe(extent);
        requestAnimationFrame(() => {
          extent.style.height = `${nextHeight}px`;
        });
      },
    );
    editor.view.dom.dispatchEvent(new Event("beforeinput"));
    const cleaned = !document.querySelector(".editor-content-motion-paint");
    editor.commands.undo();
    const restored = JSON.stringify(editor.getJSON()) === JSON.stringify(original);
    editor.view.dom.dispatchEvent(new Event("beforeinput"));
    return { fromTop, toTop, oldTop, frame, cleaned, restored };
  });
  expect(result.toTop).toBeGreaterThan(result.fromTop);
  expect(result.frame.afterTop).toBeLessThan(result.oldTop);
  expect(result.frame.error).toBeLessThan(0.5);
  expect(result.frame.opacity).toBe("1");
  expect(result.cleaned).toBe(true);
  expect(result.restored).toBe(true);
});

for (const action of ["scroll", "resize", "cancel", "animation-error"] as const) {
  test(`late-clamp protection handles ${action} without leaving native text displaced`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const result = await page.evaluate(async (action) => {
      const editor = window.motionEditor;
      const host = document.querySelector<HTMLElement>("#editor");
      if (!host) throw new Error("missing host");
      Object.assign(host.style, { height: "300px", overflow: "auto", overflowAnchor: "none" });
      const extent = document.createElement("div");
      host.append(extent);
      extent.append(editor.view.dom);
      editor.view.dom.style.transform = "translateX(8px)";
      editor
        .chain()
        .setMeta("addToHistory", false)
        .setContent(
          Array.from(
            { length: 12 },
            (_, i) => `<p>第${i}段：${"底部编辑检查。".repeat(20)}</p>`,
          ).join(""),
        )
        .run();
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      const original = JSON.stringify(editor.getJSON());
      extent.style.height = `${editor.view.dom.getBoundingClientRect().height + 28}px`;
      const end = editor.state.doc.content.size - 1;
      editor.commands.setTextSelection({ from: end - 90, to: end - 10 });
      host.scrollTop = host.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      editor.commands.deleteSelection();
      await Promise.resolve();
      for (const a of document.getAnimations().filter((a) => a.id === "editor-content-motion")) {
        a.pause();
        a.currentTime = 200;
      }
      const animate = editor.view.dom.animate;
      try {
        if (action === "scroll") host.scrollTop -= 25;
        else if (action === "resize") host.style.height = "400px";
        else {
          if (action === "animation-error")
            editor.view.dom.animate = () => {
              throw new Error("unavailable");
            };
          extent.style.height = `${editor.view.dom.getBoundingClientRect().height + 28}px`;
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      } finally {
        editor.view.dom.animate = animate;
      }
      const rootAnimations = editor.view.dom
        .getAnimations()
        .filter((a) => a.id === "editor-content-motion").length;
      const errorCleaned =
        action !== "animation-error" || !document.querySelector(".editor-content-motion-paint");
      editor.view.dom.dispatchEvent(
        new InputEvent("beforeinput", { inputType: "insertText", data: "甲" }),
      );
      const native = editor.view.dom.lastElementChild;
      if (!native) throw new Error("missing paragraph");
      const cleaned =
        !document.querySelector(".editor-content-motion-paint") &&
        !document.getAnimations().some((a) => a.id === "editor-content-motion");
      const opacity = getComputedStyle(native).opacity;
      const translate = getComputedStyle(editor.view.dom).translate;
      const transform = getComputedStyle(editor.view.dom).transform;
      editor.commands.undo();
      const restored = JSON.stringify(editor.getJSON()) === original;
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      editor.commands.redo();
      const redone = JSON.stringify(editor.getJSON()) !== original;
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      return {
        rootAnimations,
        cleaned,
        errorCleaned,
        opacity,
        translate,
        transform,
        restored,
        redone,
      };
    }, action);
    expect(errors).toEqual([]);
    if (action === "cancel") expect(result.rootAnimations).toBeGreaterThan(0);
    else expect(result.rootAnimations).toBe(0);
    expect(result.cleaned).toBe(true);
    expect(result.errorCleaned).toBe(true);
    expect(result.opacity).toBe("1");
    expect(result.translate).toBe("none");
    expect(result.transform).toBe("matrix(1, 0, 0, 1, 8, 0)");
    expect(result.restored).toBe(true);
    expect(result.redone).toBe(true);
  });
}

test("selection deletion commits immediately and paint stops before more typing", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.deleteSelection();
    const immediate = editor.getText();
    await Promise.resolve();
    const paint = document.querySelector<HTMLElement>(".editor-content-motion-paint");
    const animations = document
      .getAnimations()
      .filter((animation) => animation.id === "editor-content-motion");
    const timing = animations.map((animation) => animation.effect?.getTiming());
    editor.view.dom.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data: "甲" }),
    );
    editor.commands.insertContent("甲");
    await Promise.resolve();
    const cleaned = !document.querySelector(".editor-content-motion-paint");
    editor.commands.undo();
    return { immediate, inert: paint?.inert, timing, cleaned, undo: editor.getText() };
  });
  expect(result.immediate.startsWith("，用于检查")).toBe(true);
  expect(result.inert).toBe(true);
  expect(result.timing.length).toBeGreaterThan(0);
  expect(
    result.timing.every((timing) => timing?.duration === 650 && timing.easing === "ease-in-out"),
  ).toBe(true);
  expect(result.cleaned).toBe(true);
  expect(result.undo).toContain("第一段文字");
});
test("text alignment stays immediate; reduced motion skips content paint", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    editor.commands.setTextSelection(1);
    editor.commands.setTextAlign("right");
    await Promise.resolve();
    const count = document
      .getAnimations()
      .filter((animation) => animation.id === "editor-content-motion").length;
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    document.documentElement.dataset.reducedMotion = "true";
    editor.commands.insertContent("新增内容");
    await Promise.resolve();
    return {
      count,
      remaining: document.querySelectorAll(".editor-content-motion-paint").length,
      text: editor.getText(),
    };
  });
  expect(result.count).toBe(0);
  expect(result.remaining).toBe(0);
  expect(result.text).toContain("第一段文字");
});

test("delete leaves a gap then slides surviving glyphs to the join without fading", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    const range = document.createRange();
    const text = editor.view.dom.querySelector("p")?.firstChild;
    if (!text) throw new Error("missing text");
    range.setStart(text, 5);
    range.setEnd(text, 6);
    const originalLeft = range.getBoundingClientRect().left;
    editor.commands.setTextSelection({ from: 2, to: 6 });
    editor.commands.deleteSelection();
    await Promise.resolve();
    const layer = document.querySelector<HTMLElement>(".editor-content-motion-paint");
    const glyph = Array.from(layer?.querySelectorAll("[data-motion-kind]") ?? []).find(
      (element) => element.textContent === "，",
    );
    if (!glyph) throw new Error("missing surviving comma");
    const animations = document.getAnimations();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    const start = glyph.getBoundingClientRect().left;
    for (const animation of animations) animation.currentTime = 325;
    const middle = glyph.getBoundingClientRect().left;
    const opaque = getComputedStyle(glyph).opacity;
    for (const animation of animations) animation.currentTime = 649;
    const end = glyph.getBoundingClientRect().left;
    const retained = layer?.textContent;
    editor.view.dom.dispatchEvent(new Event("beforeinput"));
    return { originalLeft, start, middle, end, opaque, retained, text: editor.getText() };
  });
  expect(result.start).toBeCloseTo(result.originalLeft, 1);
  expect(result.start).toBeGreaterThan(result.middle);
  expect(result.middle).toBeGreaterThan(result.end);
  expect(result.opaque).toBe("1");
  expect(result.retained).not.toContain("段文字");
  expect(result.text).toContain("第，用于检查");
});

test("paragraph paste opens space while keeping new paragraphs visible", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    const paragraph = editor.view.dom.querySelector("p");
    if (!paragraph) throw new Error("missing paragraph");
    const range = document.createRange();
    if (!paragraph.firstChild) throw new Error("missing text");
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, 1);
    const top = range.getBoundingClientRect().top;
    editor.commands.setTextSelection(1);
    const data = new DataTransfer();
    data.setData("text/html", "<p>这是整段粘贴的新文字。</p><p></p>");
    data.setData("text/plain", "这是整段粘贴的新文字。\n");
    editor.view.dom.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
    await Promise.resolve();
    const inserted = editor.view.dom.querySelector("p");
    const following = Array.from(editor.view.dom.querySelectorAll("p")).find((element) =>
      element.textContent?.startsWith("第一段文字"),
    );
    if (!inserted || !following) throw new Error("missing pasted paragraphs");
    if (!following.firstChild) throw new Error("missing following text");
    const followingRange = document.createRange();
    followingRange.setStart(following.firstChild, 0);
    followingRange.setEnd(following.firstChild, 1);
    const animations = document.getAnimations();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    const start = followingRange.getBoundingClientRect().top;
    const hidden = getComputedStyle(inserted).opacity;
    for (const animation of animations) animation.currentTime = 325;
    const middle = followingRange.getBoundingClientRect().top;
    for (const animation of animations) animation.currentTime = 649;
    const end = followingRange.getBoundingClientRect().top;
    for (const animation of animations) animation.finish();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      top,
      start,
      middle,
      end,
      hidden,
      visible: getComputedStyle(inserted).opacity,
      layers: document.querySelectorAll(".editor-content-motion-paint").length,
      text: editor.getText(),
    };
  });
  expect(result.text).toContain("这是整段粘贴的新文字。");
  expect(result.start).toBeCloseTo(result.top, 1);
  expect(result.start).toBeLessThan(result.middle);
  expect(result.middle).toBeLessThan(result.end);
  expect(Number(result.hidden)).toBeGreaterThan(0);
  expect(result.visible).toBe("1");
  expect(result.layers).toBe(0);
});

for (const paragraphs of [2, 3]) {
  test(`cross-paragraph delete across ${paragraphs} paragraphs moves the surviving suffix from its old position`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (paragraphs) => {
      const editor = window.motionEditor;
      editor
        .chain()
        .setMeta("addToHistory", false)
        .setContent(
          `<p>首段前文甲乙丙丁待删内容</p>${"<p>中间需要删除的段落。</p>".repeat(paragraphs - 2)}<p>尾段保留文字。</p><p>后续段落补位。</p>`,
        )
        .run();
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      const original = editor.getJSON();
      const positions: number[] = [];
      editor.state.doc.forEach((_node, pos) => {
        positions.push(pos);
      });
      const tail = editor.view.dom.children[paragraphs - 1]?.firstChild;
      const tailPos = positions[paragraphs - 1];
      const following = editor.view.dom.lastElementChild;
      if (!tail || tailPos === undefined || !following) throw new Error("missing paragraphs");
      const range = document.createRange();
      range.setStart(tail, 2);
      range.setEnd(tail, 3);
      const oldRect = range.getBoundingClientRect();
      const oldFollowingTop = following.getBoundingClientRect().top;
      editor.commands.setTextSelection({ from: 9, to: tailPos + 3 });
      editor.commands.deleteSelection();
      await Promise.resolve();
      const glyph = Array.from(document.querySelectorAll<HTMLElement>("[data-motion-kind]")).find(
        (g) => g.textContent === "保",
      );
      const animations = document.getAnimations().filter((a) => a.id === "editor-content-motion");
      const sample = (time: number) => {
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = time;
        }
        return {
          left: glyph?.getBoundingClientRect().left,
          top: glyph?.getBoundingClientRect().top,
          opacity: glyph && getComputedStyle(glyph).opacity,
          followingTop: following.getBoundingClientRect().top,
        };
      };
      const kind = glyph?.dataset.motionKind;
      const start = sample(0),
        middle = sample(325),
        end = sample(649);
      const finalText = editor.view.dom.firstElementChild?.firstChild;
      if (!finalText) throw new Error("missing merged paragraph");
      range.setStart(finalText, 8);
      range.setEnd(finalText, 9);
      const target = range.getBoundingClientRect();
      const text = editor.getText();
      const selection = { from: editor.state.selection.from, to: editor.state.selection.to };
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      editor.commands.undo();
      await Promise.resolve();
      const undoGlyph = Array.from(
        document.querySelectorAll<HTMLElement>("[data-motion-kind]"),
      ).find((g) => g.textContent === "保");
      const undoAnimations = document
        .getAnimations()
        .filter((a) => a.id === "editor-content-motion");
      const undoSample = (time: number) => {
        for (const animation of undoAnimations) {
          animation.pause();
          animation.currentTime = time;
        }
        const rect = undoGlyph?.getBoundingClientRect();
        return { left: rect?.left, top: rect?.top };
      };
      const undoKind = undoGlyph?.dataset.motionKind;
      const undoStart = undoSample(0);
      const undoEnd = undoSample(649);
      const restored = JSON.stringify(editor.getJSON()) === JSON.stringify(original);
      editor.view.dom.dispatchEvent(new Event("beforeinput"));
      return {
        kind,
        start,
        middle,
        end,
        oldLeft: oldRect.left,
        oldTop: oldRect.top,
        finalLeft: target.left,
        finalTop: target.top,
        oldFollowingTop,
        text,
        selection,
        undoKind,
        undoStart,
        undoEnd,
        restored,
        cleaned: !document.querySelector(".editor-content-motion-paint"),
      };
    }, paragraphs);
    expect(result.kind).toBe("retained");
    expect(result.start.left).toBeCloseTo(result.oldLeft, 1);
    expect(result.start.top).toBeCloseTo(result.oldTop, 1);
    expect(result.start.opacity).toBe("1");
    expect(result.middle.opacity).toBe("1");
    expect(result.start.top).toBeGreaterThan(result.middle.top ?? 0);
    expect(result.middle.top).toBeGreaterThan(result.end.top ?? 0);
    expect(result.end.left).toBeCloseTo(result.finalLeft, 1);
    expect(result.end.top).toBeCloseTo(result.finalTop, 1);
    expect(result.start.followingTop).toBeCloseTo(result.oldFollowingTop, 1);
    expect(result.start.followingTop).toBeGreaterThan(result.end.followingTop);
    expect(result.text).toBe("首段前文甲乙丙丁保留文字。\n\n后续段落补位。");
    expect(result.selection).toEqual({ from: 9, to: 9 });
    expect(result.undoKind).toBe("retained");
    expect(result.undoStart.left).toBeCloseTo(result.finalLeft, 1);
    expect(result.undoStart.top).toBeCloseTo(result.finalTop, 1);
    expect(result.undoEnd.left).toBeCloseTo(result.oldLeft, 1);
    expect(result.undoEnd.top).toBeCloseTo(result.oldTop, 1);
    expect(result.restored).toBe(true);
    expect(result.cleaned).toBe(true);
  });
}

test("coarse multi-occurrence replacement retains equal text, closes gaps and reveals new glyphs", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    const before = "箱体用于支撑，箱体保持稳定，箱体固定。";
    const after = before.replaceAll("箱体", "外保护壳");
    editor.commands.setContent(`<p>${before}</p>`);
    await Promise.resolve();
    editor.view.dom.dispatchEvent(new Event("beforeinput"));
    editor.commands.setTextSelection({ from: 1, to: 3 });
    const next = editor.schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: after }] }],
    });
    const old = editor.state.doc;
    const start = old.content.findDiffStart(next.content);
    const end = old.content.findDiffEnd(next.content);
    if (start === null || !end) throw new Error("missing replacement");
    editor.view.dispatch(editor.state.tr.replace(start, end.a, next.slice(start, end.b)));
    const immediate = editor.getText();
    await Promise.resolve();
    const layer = document.querySelector<HTMLElement>(".editor-content-motion-paint");
    const retained = Array.from(
      layer?.querySelectorAll<HTMLElement>("[data-motion-kind='retained']") ?? [],
    );
    const inserted = layer?.querySelector<HTMLElement>("[data-motion-kind='inserted']");
    const following = retained.find((glyph) => glyph.textContent === "用");
    if (!following || !inserted) throw new Error("missing replacement paint");
    const animations = document.getAnimations().filter((a) => a.id === "editor-content-motion");
    const sample = (time: number) => {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = time;
      }
      return {
        left: following.getBoundingClientRect().left,
        opacity: getComputedStyle(following).opacity,
        insertedOpacity: Number(getComputedStyle(inserted).opacity),
      };
    };
    const samples = [sample(0), sample(292.5), sample(487.5), sample(649)];
    const retainedText = retained.map((glyph) => glyph.textContent).join("");
    const paintedText = layer?.textContent;
    const inert = layer?.inert;
    const timing = animations.map((a) => a.effect?.getTiming());
    for (const animation of animations) animation.finish();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const paragraph = editor.view.dom.querySelector("p");
    return {
      immediate,
      after,
      retainedText,
      paintedText,
      samples,
      inert,
      timing,
      finalOpacity: paragraph && getComputedStyle(paragraph).opacity,
      remaining: document.querySelectorAll(".editor-content-motion-paint").length,
    };
  });
  expect(result.immediate).toBe(result.after);
  expect(result.retainedText).toBe("用于支撑，保持稳定，固定。");
  expect(result.paintedText).toBe(result.after);
  expect(result.samples.every((sample) => sample.opacity === "1")).toBe(true);
  expect(result.samples[1]?.left).toBeLessThan(result.samples[0]?.left ?? 0);
  expect(result.samples[3]?.left).toBeGreaterThan(result.samples[1]?.left ?? 0);
  expect(result.samples[2]?.insertedOpacity).toBeGreaterThan(0);
  expect(result.samples[2]?.insertedOpacity).toBeLessThan(1);
  expect(result.samples[3]?.insertedOpacity).toBeGreaterThan(0.99);
  expect(result.inert).toBe(true);
  expect(
    result.timing.every((timing) => timing?.duration === 650 && timing.easing === "ease-in-out"),
  ).toBe(true);
  expect(result.finalOpacity).toBe("1");
  expect(result.remaining).toBe(0);
});

test("whole-run whitespace cleanup never drops equal text from the paint", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    editor.commands.setContent("<p>箱体 安装在支架上，箱体 保持稳定。</p>");
    await Promise.resolve();
    editor.view.dom.dispatchEvent(new Event("beforeinput"));
    const text = "箱体安装在支架上，箱体保持稳定。";
    editor.view.dispatch(editor.state.tr.insertText(text, 1, editor.state.doc.content.size - 1));
    await Promise.resolve();
    const paint = document.querySelector(".editor-content-motion-paint");
    const paragraph = editor.view.dom.querySelector("p");
    const opacity = paragraph && getComputedStyle(paragraph).opacity;
    return { text: editor.getText(), painted: paint?.textContent, opacity };
  });
  expect(result.text).toBe("箱体安装在支架上，箱体保持稳定。");
  expect(result.opacity === "1" || result.painted === result.text).toBe(true);
});

test("complete replacement has a visible fallback and cancels cleanly on more input", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    editor.commands.selectAll();
    editor.commands.insertContent("全新正文");
    await Promise.resolve();
    const paragraph = editor.view.dom.querySelector("p");
    for (const animation of document.getAnimations()) {
      if (animation.id !== "editor-content-motion") continue;
      animation.pause();
      animation.currentTime = 0;
    }
    const visible = paragraph && Number(getComputedStyle(paragraph).opacity) > 0;
    editor.view.dom.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data: "甲" }),
    );
    editor.commands.insertContent("甲");
    await Promise.resolve();
    return {
      visible,
      text: editor.getText(),
      opacity: paragraph && getComputedStyle(paragraph).opacity,
      layers: document.querySelectorAll(".editor-content-motion-paint").length,
      animations: document.getAnimations().filter((a) => a.id === "editor-content-motion").length,
    };
  });
  expect(result.visible).toBe(true);
  expect(result.text).toContain("全新正文甲");
  expect(result.opacity).toBe("1");
  expect(result.layers).toBe(0);
  expect(result.animations).toBe(0);
});

test("wrapped, zoomed, marked Unicode text joins the native paint without a jump", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    const host = document.querySelector<HTMLElement>("#editor");
    if (!host) throw new Error("missing host");
    host.style.width = "210px";
    host.style.zoom = "1.25";
    editor.commands.setContent(
      "<p><strong>箱体</strong>支撑😀传动组件并保持稳定，<em>箱体</em>能够持续稳定运行。</p>",
    );
    await Promise.resolve();
    editor.view.dom.dispatchEvent(new Event("beforeinput"));
    const next = editor.getJSON();
    for (const child of next.content?.[0]?.content ?? []) {
      if ("text" in child && child.text) child.text = child.text.replaceAll("箱体", "外保护壳");
    }
    const after = editor.schema.nodeFromJSON(next);
    const end = editor.state.doc.content.findDiffEnd(after.content);
    const start = editor.state.doc.content.findDiffStart(after.content);
    if (start === null || !end) throw new Error("missing edit");
    editor.view.dispatch(editor.state.tr.replace(start, end.a, after.slice(start, end.b)));
    await Promise.resolve();
    const paint = document.querySelector<HTMLElement>(".editor-content-motion-paint");
    const glyph = Array.from(paint?.querySelectorAll("[data-motion-kind]") ?? []).find(
      (glyph) => glyph.textContent === "😀",
    );
    if (!glyph) throw new Error("missing Unicode glyph");
    const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT);
    let native: DOMRect | undefined;
    while (walker.nextNode()) {
      const index = walker.currentNode.textContent?.indexOf("😀") ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(walker.currentNode, index);
      range.setEnd(walker.currentNode, index + 2);
      native = range.getBoundingClientRect();
      break;
    }
    const animations = document.getAnimations().filter((a) => a.id === "editor-content-motion");
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 649;
    }
    const endRect = glyph.getBoundingClientRect();
    const painted = paint?.textContent;
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    return {
      text: editor.getText(),
      painted,
      dx: native ? Math.abs(endRect.left - native.left) : Infinity,
      dy: native ? Math.abs(endRect.top - native.top) : Infinity,
      layers: document.querySelectorAll(
        ".editor-content-motion-paint, .editor-content-motion-measure",
      ).length,
    };
  });
  expect(result.painted).toBe(result.text);
  expect(result.dx).toBeLessThan(0.5);
  expect(result.dy).toBeLessThan(0.5);
  expect(result.layers).toBe(0);
});

test("cut removes text immediately and preserves clipboard and undo", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const editor = window.motionEditor;
    editor.commands.setTextSelection({ from: 2, to: 6 });
    const data = new DataTransfer();
    editor.view.dom.dispatchEvent(
      new ClipboardEvent("cut", { bubbles: true, cancelable: true, clipboardData: data }),
    );
    await Promise.resolve();
    const retained = document.querySelector(".editor-content-motion-paint")?.textContent ?? "";
    const text = editor.getText();
    editor.commands.undo();
    return { retained, text, clipboard: data.getData("text/plain"), restored: editor.getText() };
  });
  expect(result.clipboard).toBe("一段文字");
  expect(result.retained).not.toContain("一段文字");
  expect(result.text).toContain("第，用于检查");
  expect(result.restored).toContain("第一段文字");
});

for (const platform of ["Windows", "Mac", "Harmony"] as const) {
  for (const command of ["delete", "insertText"] as const) {
    test(`${platform}: native ${command} commits selection edits with source-specific motion and undo`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const result = await page.evaluate(async (command) => {
        const editor = window.motionEditor;
        const original = editor.getText();
        editor.commands.setTextSelection({ from: 2, to: 6 });
        editor.view.focus();
        const accepted = document.execCommand(
          command,
          false,
          command === "insertText" ? "新文" : undefined,
        );
        // Native editing mutates DOM before ProseMirror's observer runs.
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        const text = editor.getText();
        const animations = document
          .getAnimations()
          .filter((animation) => animation.id === "editor-content-motion");
        const paint = document.querySelector<HTMLElement>(".editor-content-motion-paint");
        const paragraph = editor.view.dom.firstElementChild;
        const visible =
          Boolean(paragraph && getComputedStyle(paragraph).opacity !== "0") ||
          Boolean(paint?.textContent);
        const active = animations.length;
        const durations = animations.map((animation) => animation.effect?.getTiming().duration);
        editor.view.dom.dispatchEvent(new Event("beforeinput"));
        const cleaned = !document.querySelector(".editor-content-motion-paint");
        editor.commands.undo();
        return {
          accepted,
          text,
          active,
          durations,
          visible,
          cleaned,
          restored: editor.getText(),
          original,
        };
      }, command);
      expect(errors).toEqual([]);
      expect(result.accepted).toBe(true);
      expect(
        result.text.startsWith(command === "delete" ? "第，用于检查" : "第新文，用于检查"),
      ).toBe(true);
      if (command === "delete") expect(result.active).toBeGreaterThan(0);
      else expect(result.active).toBe(0);
      expect(
        result.durations.every((duration) => duration === (platform === "Windows" ? 650 : 400)),
      ).toBe(true);
      expect(result.visible).toBe(true);
      expect(result.cleaned).toBe(true);
      expect(result.restored).toBe(result.original);
    });
  }
}

test("native typing across selected paragraphs is immediate while clipboard paste still animates", async ({
  page,
}) => {
  const original = await page.evaluate(() => {
    const editor = window.motionEditor;
    const first = editor.state.doc.firstChild;
    if (!first) throw new Error("missing first paragraph");
    editor.commands.setTextSelection({ from: 2, to: first.nodeSize + 4 });
    editor.view.focus();
    return editor.getText();
  });
  await page.keyboard.insertText("中文输入");
  await expect.poll(() => page.evaluate(() => window.motionEditor.getText())).toContain("中文输入");
  const typed = await page.evaluate(() => {
    const editor = window.motionEditor;
    const result = {
      text: editor.getText(),
      layers: document.querySelectorAll(".editor-content-motion-paint").length,
      animations: document
        .getAnimations()
        .filter((animation) => animation.id === "editor-content-motion").length,
    };
    editor.commands.undo();
    const undo = editor.getText();
    editor.commands.redo();
    return { ...result, undo, redo: editor.getText() };
  });
  expect(typed).toMatchObject({ layers: 0, animations: 0 });
  expect(typed.undo).toBe(original);
  expect(typed.redo).toBe(typed.text);
  const pasted = await page.evaluate(async () => {
    const editor = window.motionEditor;
    editor.commands.setTextSelection({ from: 2, to: 6 });
    const data = new DataTransfer();
    data.setData("text/plain", "粘贴文字");
    editor.view.dom.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
    await Promise.resolve();
    const animations = document
      .getAnimations()
      .filter((animation) => animation.id === "editor-content-motion");
    const result = {
      text: editor.getText(),
      active: animations.length,
      durations: animations.map((animation) => animation.effect?.getTiming().duration),
    };
    editor.commands.undo();
    const undoPaste = editor.getText();
    editor.commands.undo();
    const undoTyping = editor.getText();
    editor.commands.redo();
    const redoTyping = editor.getText();
    editor.commands.redo();
    return { ...result, undoPaste, undoTyping, redoTyping, redoPaste: editor.getText() };
  });
  expect(pasted.active).toBeGreaterThan(0);
  expect(pasted.durations.every((duration) => duration === 650)).toBe(true);
  expect(pasted.text).toContain("粘贴文字");
  expect(pasted.undoPaste).toBe(typed.text);
  expect(pasted.undoTyping).toBe(original);
  expect(pasted.redoTyping).toBe(typed.text);
  expect(pasted.redoPaste).toBe(pasted.text);
});

test("IME composition and committed Chinese text do not animate", async ({ page }) => {
  await page.evaluate(() => {
    const editor = window.motionEditor;
    editor.commands.setTextSelection({ from: 2, to: 6 });
    editor.view.focus();
  });
  const session = await page.context().newCDPSession(page);
  await session.send("Input.imeSetComposition", {
    text: "中文",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await session.send("Input.insertText", { text: "中文输入" });
  await expect.poll(() => page.evaluate(() => window.motionEditor.getText())).toContain("中文输入");
  const result = await page.evaluate(() => ({
    layers: document.querySelectorAll(".editor-content-motion-paint").length,
    animations: document
      .getAnimations()
      .filter((animation) => animation.id === "editor-content-motion").length,
  }));
  expect(result).toEqual({ layers: 0, animations: 0 });
  await session.detach();
});
