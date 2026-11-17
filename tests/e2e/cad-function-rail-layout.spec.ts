import { readFileSync } from "node:fs";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

const css = [
  "src/renderer/src/app/app.css",
  "src/renderer/src/shared/standard-dialog.css",
  "src/renderer/src/drawing-markup/drawing-workspace.css",
  "src/renderer/src/drawing-markup/cad-reference-mark-panel.css",
  "src/renderer/src/patents/compact-tool-actions.css",
  "src/renderer/src/patents/function-rail/function-rail-appearance.css",
  "src/renderer/src/patents/function-rail/function-rail-responsive.css",
  "src/renderer/src/patents/reference-marks/reference-mark-order.css",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

test("CAD canvas focus border stays behind a pinned rail overlapping its edge", async () => {
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true,
  });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    for (const width of [1200, 760]) {
      await page.setViewportSize({ width, height: 600 });
      await page.setContent(`<style>${css}</style>
        <section class="drawing-workspace" style="height:600px">
          <div class="drawing-workspace-content">
            <div class="patent-function-rail-scope">
              <div class="patent-function-rail-edge-host">
                <aside style="position:absolute;left:0;top:30px;width:180px;height:180px;background:white;border-radius:16px;pointer-events:auto">固定功能栏</aside>
              </div>
            </div>
            <div class="drawing-layout"><div class="drawing-stage"><div class="drawing-viewport">
              <svg role="application" tabindex="0" aria-label="CAD标号画布"></svg>
            </div></div></div>
          </div>
        </section>`);
      const viewport = page.locator(".drawing-viewport");
      const bounds = (await viewport.boundingBox())!;
      // Inside the rail, directly over the canvas's left focus border.
      const clip = {x:bounds.x, y:bounds.y+80, width:4, height:40};
      const before = await page.screenshot({clip});
      await page.getByRole("application").focus();
      await expect(page.getByRole("application")).toBeFocused();
      expect(await viewport.evaluate(node => getComputedStyle(node,"::after").borderColor)).toBe("rgb(229, 151, 0)");
      expect(await viewport.evaluate(node => getComputedStyle(node,"::after").borderWidth)).toBe("1px");
      expect(await page.screenshot({clip})).toEqual(before);
    }
  } finally { await browser.close(); }
});

test("CAD reference card keeps rounded corners and smooth reversible tab transitions", async () => {
  const compiled = await build({
    stdin: {
      contents: `import React from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { PatentFunctionRailScope } from "./src/renderer/src/patents/function-rail/function-rail-context";
        import { PatentGlobalFunctionRail } from "./src/renderer/src/patents/patent-global-function-rail";
        import { CadFunctionTabs } from "./src/renderer/src/drawing-markup/cad-function-tabs";
        import { CadReferenceMarkPanel } from "./src/renderer/src/drawing-markup/cad-reference-mark-panel";
        const root = createRoot(document.querySelector(".drawing-workspace-content"));
        window.renderCadRail = (cadAvailable, count) => flushSync(() => root.render(
          <PatentFunctionRailScope scopeKey="drawing-markup" initialUserIntent="pinned">
            <CadFunctionTabs cadAvailable={cadAvailable} tools={<section className="cad-editing-panel"><fieldset className="cad-tool-group"><legend className="cad-tool-heading">绘图</legend><div className="cad-entity-tools"><input aria-label="绘图草稿" defaultValue="保留草稿" style={{width:"100%"}}/></div></fieldset></section>}
              referenceMarks={<CadReferenceMarkPanel referenceMarks={Array.from({length:count},(_,i)=>({referenceMarkId:String(i),number:i+1,keyword:"零部件"+(i+1)}))} busy={false} onSelectNumber={()=>{}} />}
              renderRail={(header, panels)=><PatentGlobalFunctionRail bookKind="description-drawings" title="图纸工具" headerContent={header}>
                <div className="patent-book-tools" data-function-rail-owner="drawing-markup">{panels}</div>
              </PatentGlobalFunctionRail>} />
          </PatentFunctionRailScope>));`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outdir: "out-cad-rail-corners-browser",
  });
  const script = compiled.outputFiles.find((file) => file.path.endsWith(".js"));
  if (!script) throw new Error("CAD rail script was not built");
  const styles = compiled.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const [width, height] of [
      [1200, 900],
      [760, 500],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.setContent(
        `<style>${css}\n${styles}</style><div style="display:flex;height:${height}px"><section class="drawing-workspace"><div class="drawing-workspace-content"></div></section></div>`,
      );
      await page.addScriptTag({ content: script.text });
      for (const count of [0, 40]) {
        // Return to a card without a tab header as well as starting without one.
        for (const cadAvailable of [false, true, false]) {
          await page.evaluate(
            ({ cadAvailable, count }) => {
              (
                window as unknown as { renderCadRail(available: boolean, count: number): void }
              ).renderCadRail(cadAvailable, count);
            },
            { cadAvailable, count },
          );
          let drawingTitleTop: number | undefined;
          if (cadAvailable) {
            await page.getByRole("tab", { name: "CAD工具", exact: true }).click();
            const drawingTitle = await page.locator(".cad-tool-heading").boundingBox();
            if (!drawingTitle) throw new Error("CAD drawing title is missing");
            drawingTitleTop = drawingTitle.y;
            await page.getByRole("tab", { name: "附图标记", exact: true }).click();
          }
          const card = page.locator(".cad-reference-mark-panel");
          await expect(card).toBeVisible();
          await expect(card).toHaveCSS("border-top-left-radius", cadAvailable ? "0px" : "12px");
          await expect(card).toHaveCSS("border-top-right-radius", cadAvailable ? "0px" : "12px");
          await expect(card).toHaveCSS("border-bottom-left-radius", "12px");
          await expect(card).toHaveCSS("border-bottom-right-radius", "12px");
          const rail = page.locator(".patent-global-function-rail");
          const top = cadAvailable ? rail.locator(".patent-global-function-rail__header") : card;
          await expect(top).toHaveCSS("border-top-left-radius", "12px");
          await expect(top).toHaveCSS("border-top-right-radius", "12px");
          if (cadAvailable) {
            const header = await top.boundingBox();
            const body = await rail.locator(".patent-global-function-rail__body").boundingBox();
            if (!header || !body) throw new Error("CAD tab header or body is missing");
            expect(body.y).toBeGreaterThanOrEqual(header.y + header.height);
            const panel = await card.boundingBox();
            if (!panel) throw new Error("CAD reference panel is missing");
            // The tab header has its own row; the old overlay-button spacer must not remain.
            expect(panel.y - body.y).toBeLessThanOrEqual(1);
            const referenceTitle = await card
              .getByRole("heading", { name: "附图标记" })
              .boundingBox();
            if (!referenceTitle || drawingTitleTop === undefined)
              throw new Error("CAD panel titles are missing");
            expect(Math.abs(drawingTitleTop - referenceTitle.y)).toBeLessThanOrEqual(1);
            await expect(rail.locator(".cad-function-tabs__panels")).toHaveCSS(
              "padding-top",
              "0px",
            );
          }
          // Check the painted silhouette, not just the computed radius value.
          expect(
            await top.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return element.contains(document.elementFromPoint(box.left + 1, box.top + 1));
            }),
          ).toBe(false);
          const pin = rail.getByRole("button", { name: "取消固定", exact: true });
          await expect(pin).toBeVisible();
          await pin.click();
          await expect(rail.getByRole("button", { name: "固定", exact: true })).toBeVisible();
          await expect(top).toHaveCSS("border-top-left-radius", "12px");
          await rail.getByRole("button", { name: "固定", exact: true }).click();
          await page.screenshot({
            path: test.info().outputPath(`rail-${height}-${count}-${cadAvailable}.png`),
            animations: "disabled",
          });
        }
      }
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      (
        window as unknown as { renderCadRail(available: boolean, count: number): void }
      ).renderCadRail(true, 40);
    });
    await page.getByRole("tab", { name: "CAD工具", exact: true }).click();
    await page.evaluate(() =>
      Promise.allSettled(
        document
          .querySelector(".cad-function-tabs__panels")!
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
    await page.getByRole("textbox", { name: "绘图草稿" }).fill("未保存的绘图参数");
    const start = await page.evaluate(async () => {
      const stage = document.querySelector<HTMLElement>(".cad-function-tabs__panels")!;
      const old = stage.querySelector<HTMLElement>('[role="tabpanel"][data-motion="enter"]')!;
      const outgoingTop = old.getBoundingClientRect().top;
      document.querySelector<HTMLButtonElement>('[role="tab"][id$="tab-marks"]')!.click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const incoming = stage.querySelector<HTMLElement>('[role="tabpanel"][data-motion="enter"]')!;
      return {
        outgoingRetained: !old.hidden && old.inert,
        outgoingOpacity: Number(getComputedStyle(old).opacity),
        incomingOpacity: Number(getComputedStyle(incoming).opacity),
        outgoingJump: old.getBoundingClientRect().top - outgoingTop,
        incomingTopGap: incoming.getBoundingClientRect().top - stage.getBoundingClientRect().top,
        durations: [stage, old, incoming].flatMap((element) =>
          element.getAnimations().map((animation) => animation.effect!.getTiming().duration),
        ),
      };
    });
    expect(start.outgoingRetained).toBe(true);
    expect(start.outgoingOpacity).toBeGreaterThan(0.8);
    expect(start.incomingOpacity).toBeLessThan(0.2);
    expect(Math.abs(start.outgoingJump)).toBeLessThanOrEqual(1);
    expect(Math.abs(start.incomingTopGap)).toBeLessThanOrEqual(1);
    expect(start.durations).toEqual([600, 600, 600]);
    await page.waitForTimeout(180);
    const reversal = await page.evaluate(async () => {
      const stage = document.querySelector<HTMLElement>(".cad-function-tabs__panels")!;
      const tools = stage.querySelector<HTMLElement>('[id$="panel-tools"]')!;
      const opacity = Number(getComputedStyle(tools).opacity);
      const height = stage.getBoundingClientRect().height;
      document.querySelector<HTMLButtonElement>('[role="tab"][id$="tab-tools"]')!.click();
      await new Promise(requestAnimationFrame);
      const motion = tools.getAnimations()[0]!;
      const resize = stage.getAnimations()[0]!;
      return {
        opacity,
        height,
        fromOpacity: Number((motion.effect as KeyframeEffect).getKeyframes()[0]!.opacity),
        fromHeight: Number.parseFloat(
          String((resize.effect as KeyframeEffect).getKeyframes()[0]!.height),
        ),
        duration: motion.effect!.getTiming().duration,
      };
    });
    expect(reversal.fromOpacity).toBeCloseTo(reversal.opacity, 1);
    expect(Math.abs(reversal.fromHeight - reversal.height)).toBeLessThan(45);
    expect(reversal.duration).toBe(600);
    await page.evaluate(() =>
      Promise.allSettled(
        document
          .querySelector(".cad-function-tabs__panels")!
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
    await expect(page.getByRole("textbox", { name: "绘图草稿" })).toHaveValue("未保存的绘图参数");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("tab", { name: "附图标记", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "CAD工具", includeHidden: true })).toBeHidden();
    expect(
      await page
        .locator(".cad-function-tabs__panels")
        .evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("CAD floating reference list uses canvas height rather than the collapsed handle height", async () => {
  const compiled = await build({
    stdin: {
      contents: `import React from "react";
        import { createRoot } from "react-dom/client";
        import { CadReferenceMarkPanel } from "./src/renderer/src/drawing-markup/cad-reference-mark-panel";
        import { PatentFunctionRailScope } from "./src/renderer/src/patents/function-rail/function-rail-context";
        import { PatentGlobalFunctionRail } from "./src/renderer/src/patents/patent-global-function-rail";
        import { measureRailVisibleHeight } from "./src/renderer/src/patents/function-rail/use-rail-visible-height";
        window.measureCadRail = measureRailVisibleHeight;
        const panel = React.createElement(CadReferenceMarkPanel, {
          referenceMarks: Array.from({length:40}, (_,i) => ({referenceMarkId:String(i),number:i+1,keyword:"零部件"+(i+1)})),
          projects: [{annotations:Array.from({length:20},(_,i) => ({text:String(i*2+1)}))}],
          busy:false, onSelectNumber(number){document.querySelector("#selected").textContent=String(number)}
        });
        createRoot(document.querySelector(".drawing-workspace-content")).render(
          React.createElement(PatentFunctionRailScope, {scopeKey:"drawing-markup",initialUserIntent:"pinned"},
            React.createElement(PatentGlobalFunctionRail, {bookKind:"description-drawings",title:"CAD标号"},
              React.createElement("div",{className:"patent-book-tools","data-function-rail-owner":"drawing-markup"},panel))));`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outdir: "out-cad-panel-browser",
  });
  const script = compiled.outputFiles[0];
  if (!script) throw new Error("Rail measurement script was not built");
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    for (const height of [900, 500]) {
      await page.setViewportSize({ width: 1200, height });
      await page.setContent(
        `<style>${css}</style><output id="selected" hidden></output><div style="display:flex;height:${height}px"><section class="drawing-workspace"><div class="drawing-workspace-content"></div></section></div>`,
      );
      await page.addScriptTag({ content: script.text });
      await expect(
        page.locator(".cad-reference-mark-panel .reference-mark-panel__row-number"),
      ).toHaveCount(40);
      await page.locator(".patent-global-function-rail-slot").evaluate((element) => {
        if (!(element instanceof HTMLElement)) throw new Error("Rail slot is not an HTML element");
        const measure = (
          window as unknown as Window & { measureCadRail(slot: HTMLElement): number }
        ).measureCadRail;
        element.style.setProperty("--rail-visible-height", `${measure(element)}px`);
      });
      const rail = page.locator(".patent-global-function-rail");
      const bounds = await rail.boundingBox();
      if (!bounds) throw new Error("Rail has no visible bounds");
      const scope = await page.locator(".patent-function-rail-scope").boundingBox();
      if (!scope) throw new Error("CAD canvas scope has no visible bounds");
      expect(Math.abs(bounds.y - scope.y - 8)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.y + bounds.height - scope.y - scope.height)).toBeLessThanOrEqual(1);
      expect(bounds.height).toBeGreaterThan(128);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 42);
      const title = await page.getByRole("heading", { name: "附图标记" }).boundingBox();
      if (!title) throw new Error("Reference title is not visible");
      expect(title.y - bounds.y).toBeLessThanOrEqual(26);
      const pin = await page.getByRole("button", { name: "取消固定" }).boundingBox();
      if (!pin) throw new Error("Pin button is not visible");
      expect(title.x + title.width).toBeLessThan(pin.x);
      if (height === 900)
        await page.screenshot({
          path: "out-cad-rail-compact-20261001.png",
          animations: "disabled",
        });
      await page.getByText("零部件1", { exact: true }).click();
      await expect(page.locator("#selected")).toHaveText("1");
      const row = page.getByRole("button", { name: "选中标号2", exact: true });
      await row.focus();
      await row.press("Enter");
      await expect(page.locator("#selected")).toHaveText("2");
      await expect(page.locator("button.reference-mark-panel__row-number")).toHaveCount(0);
      const first = page.locator(".reference-mark-panel__row-number").first();
      const firstBounds = await first.boundingBox();
      if (!firstBounds) throw new Error("First reference number has no visible bounds");
      expect(firstBounds.y + firstBounds.height).toBeLessThan(bounds.y + bounds.height);
      const dot = page.locator(".cad-reference-mark-status").first();
      await expect(dot).toHaveCSS("background-color", "rgb(34, 197, 94)");
      await expect(page.locator(".cad-reference-mark-status").nth(1)).toHaveCSS(
        "background-color",
        "rgb(245, 158, 11)",
      );
      await rail.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const lastBounds = await page
        .locator(".reference-mark-panel__row-number")
        .last()
        .boundingBox();
      if (!lastBounds) throw new Error("Last reference number has no visible bounds");
      expect(lastBounds.y).toBeGreaterThanOrEqual(bounds.y);
      expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
  } finally {
    await browser.close();
  }
});

test("CAD batch deletion uses the shared compact centered confirmation dialog", async () => {
  const compiled = await build({
    stdin: {
      contents: `import { confirmAppAction } from "./src/renderer/src/shared/app-dialog";
        document.querySelector("#delete").onclick = async () => {
          document.querySelector("#result").textContent = String(await confirmAppAction("删除 2 张图纸中的 3 个选中标号？可撤销恢复。"));
        };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    format: "iife",
    platform: "browser",
    outdir: "out-cad-confirm-browser",
  });
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const styles = compiled.outputFiles
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => file.text)
      .join("\n");
    const script = compiled.outputFiles.find((file) => file.path.endsWith(".js"));
    if (!script) throw new Error("Confirmation script was not built");
    await page.setContent(
      `<style>${css}\n${styles}</style><button id="delete">删除标号</button><output id="result"></output>`,
    );
    await page.addScriptTag({ content: script.text });
    await page.getByRole("button", { name: "删除标号" }).click();
    const dialog = page.getByRole("dialog", { name: "请确认" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("2 张图纸中的 3 个");
    const box = await dialog.boundingBox();
    if (!box) throw new Error("Confirmation has no bounds");
    expect(box.width).toBeLessThanOrEqual(560);
    expect(Math.abs(box.x + box.width / 2 - 600)).toBeLessThan(2);
    await page.screenshot({ path: "out-cad-delete-confirm.png", animations: "disabled" });
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page.locator("#result")).toHaveText("false");
    await expect(dialog).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
