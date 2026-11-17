import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

test("CAD export settings keep immediate controls, disabled states and narrow layout", async () => {
  const compiled = await build({
    stdin: {
      contents: `
        import React, {useState} from "react";
        import {createRoot} from "react-dom/client";
        import {DrawingExportSettingsDialog} from "./src/renderer/src/drawing-markup/drawing-export-settings-dialog";
        window.events = [];
        function Demo() {
          const [open, setOpen] = useState(true), [auto, setAuto] = useState(true),
            [scale, setScale] = useState(1), [saving, setSaving] = useState(false),
            [failure, setFailure] = useState("");
          window.demo = {setOpen, setAuto, setScale, setSaving, setFailure};
          return <DrawingExportSettingsDialog open={open} autoAdjust={auto} scale={scale}
            disabled={false} saving={saving} failure={failure}
            onClose={() => {window.events.push("close"); setOpen(false)}}
            onAutoAdjustChange={value => {window.events.push(["auto", value]); setAuto(value)}}
            onScaleChange={setScale} onScaleCommit={() => window.events.push(["save", scale])} />;
        }
        createRoot(document.getElementById("root")).render(<Demo />);`,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    jsx: "automatic",
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const css = (
    await Promise.all(
      [
        "app/app.css",
        "shared/standard-dialog.css",
        "shared/button-feedback.css",
        "drawing-markup/drawing-workspace.css",
      ].map((file) => readFile(new URL(`../../src/renderer/src/${file}`, import.meta.url), "utf8")),
    )
  ).join("\n");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setContent(`<style>${css}</style><div id="root"></div>`);
    await page.addScriptTag({ content: compiled.outputFiles[0].text });
    const dialog = page.getByRole("dialog", { name: "CAD标号导出设置" });
    await page
      .waitForFunction(() => document.querySelector('[role="dialog"]'), null, { timeout: 5000 })
      .catch((error) => {
        throw new Error(errors.join("\n") || error.message);
      });
    await dialog.waitFor();
    const slider = page.getByRole("slider");
    const toggle = page.getByRole("switch");
    assert.equal(await slider.inputValue(), "100");
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.deepEqual(
      await dialog.evaluate((element) => {
        const css = getComputedStyle(element);
        return {
          width: element.getBoundingClientRect().width,
          radius: css.borderRadius,
          border: css.borderWidth,
        };
      }),
      { width: 520, radius: "12px", border: "0px" },
    );
    await page.screenshot({ path: "/private/tmp/cad-export-settings-implemented-20261006.png" });
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await slider.inputValue(), "105");
    assert.equal(await page.locator("output").textContent(), "105%");
    assert.ok(
      (await page.evaluate(() => window.events)).some(
        (event) => event[0] === "save" && event[1] === 1.05,
      ),
    );
    assert.equal(
      await slider.evaluate((element) => getComputedStyle(element).transitionDuration),
      "0s",
    );
    await toggle.click();
    assert.equal(await slider.isDisabled(), true);
    await toggle.click();
    assert.equal(await slider.isDisabled(), false);
    await page.evaluate(() => window.demo.setSaving(true));
    await page.waitForFunction(() => document.querySelector('[role="switch"]').disabled);
    assert.equal(await toggle.isDisabled(), true);
    assert.equal(await slider.isDisabled(), true);
    assert.equal(
      await page.getByRole("button", { name: "关闭CAD标号导出设置" }).isDisabled(),
      true,
    );
    await page.evaluate(() => {
      window.demo.setSaving(false);
      window.demo.setFailure("设置保存失败");
    });
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("alert").textContent(), "设置保存失败");
    await page.setViewportSize({ width: 360, height: 620 });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 360);
    assert.equal(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await page.screenshot({ path: "/private/tmp/cad-export-settings-narrow-20261006.png" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
