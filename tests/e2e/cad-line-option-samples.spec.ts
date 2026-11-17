import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge", headless: true });

test("CAD line options show stroke samples without checkmarks and keep native selection", async ({
  page,
}, info) => {
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { CadAppearancePanel } from './src/renderer/src/drawing-markup/cad-appearance-panel';
        createRoot(document.getElementById('root')).render(createElement(CadAppearancePanel, {
          defaults:{color:'#000000',lineweight:0.25,linetype:'Continuous'}, selected:[], linetypes:[], disabled:false,
          apply:async patch => { document.body.dataset.patch=JSON.stringify(patch); }, focusCanvas:()=>{}, onError:message=>{throw new Error(message)}
        }));`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
  });
  await page.setViewportSize({ width: 600, height: 500 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(
    '<div class="patent-global-function-rail" id="root" style="position:absolute;right:16px;bottom:16px;width:300px;padding:16px"></div>',
  );
  for (const file of [
    "app/app.css",
    "shared/dropdown-motion.css",
    "patents/function-rail/function-rail-select.css",
    "drawing-markup/cad-appearance-panel.css",
    "editor/ui/text-color-picker.css",
    "editor/ui/custom-color-popup.css",
  ])
    await page.addStyleTag({ content: readFileSync(`src/renderer/src/${file}`, "utf8") });
  await page.addStyleTag({ content: readFileSync("resources/ui/workbench-ui.css", "utf8") });
  const script = bundle.outputFiles[0];
  if (!script) throw new Error("Missing CAD appearance fixture");
  await page.addScriptTag({ content: script.text });
  for (const label of ["线宽", "线型"]) {
    const select = page.getByRole("combobox", { name: label, exact: true });
    await select.click();
    const contour = await select.evaluate((el) => {
      const style = getComputedStyle(el, "::picker(select)");
      return { border: style.borderTopWidth, shadow: style.boxShadow };
    });
    expect(contour.border).toBe("0px");
    expect(contour.shadow).not.toContain("0px 0px 0px 1px");
    const selected = select.locator("option:checked");
    expect(await selected.evaluate((el) => getComputedStyle(el, "::checkmark").display)).toBe(
      "none",
    );
    const samples = await select
      .locator("option")
      .evaluateAll((options) => options.map((el) => getComputedStyle(el, "::before").maskImage));
    expect(samples.every((sample) => sample.includes("data:image/svg+xml"))).toBe(true);
    expect(new Set(samples).size).toBeGreaterThan(1);
    expect(
      await select.evaluate((el) => parseFloat(getComputedStyle(el, "::picker(select)").height)),
    ).toBeLessThanOrEqual(280);
    await page.screenshot({ path: info.outputPath(`${label}-samples.png`) });
    await select
      .getByRole("option", { name: label === "线宽" ? "0.50 mm" : "点划线", exact: true })
      .click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-patch",
      label === "线宽" ? '{"lineweight":0.5}' : '{"linetype":"DASHDOT"}',
    );
  }
  const type = page.getByRole("combobox", { name: "线型", exact: true });
  await type.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-patch", '{"linetype":"DASHED"}');
  await page.addScriptTag({ content: "window.workbenchUi={dropdownDuration:()=>0}" });
  const color = page.getByRole("button", { name: "颜色", exact: true });
  await color.click();
  const palette = page.getByRole("dialog", { name: "颜色", exact: true });
  await expect(palette).not.toHaveCSS("box-shadow", "none");
  await expect(palette).toHaveCSS("box-shadow", /0px 16px 40px/);
  await expect(palette.getByRole("button")).toHaveCount(66);
  await expect(page.locator("#root").getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("cad-color-palette.png") });
  await palette.getByRole("button", { name: "标准色 #00B050", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-patch", '{"color":"#00b050"}');
  await color.click();
  await palette.getByRole("button", { name: "其他颜色", exact: true }).click();
  const custom = page.getByRole("dialog", { name: "其他颜色", exact: true });
  await expect(custom).not.toHaveCSS("box-shadow", "none");
  await expect(custom).toHaveCSS("box-shadow", /0px 16px 40px/);
  await page.screenshot({ path: info.outputPath("cad-other-color-shadow.png") });
  await custom.getByRole("textbox", { name: "HEX", exact: true }).fill("#bad");
  await expect(custom.getByRole("button", { name: "应用", exact: true })).toBeDisabled();
  await custom.getByRole("textbox", { name: "HEX", exact: true }).fill("#123456");
  await expect(page.locator("body")).toHaveAttribute("data-patch", '{"color":"#00b050"}');
  await custom.getByRole("textbox", { name: "HEX", exact: true }).press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-patch", '{"color":"#123456"}');
  await page.setViewportSize({ width: 360, height: 300 });
  await color.click();
  const bounds = await palette.boundingBox();
  if (!bounds) throw new Error("Missing CAD color palette");
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(352);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(292);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});
