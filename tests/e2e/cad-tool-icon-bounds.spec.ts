import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge", headless: true });

test("mechanical tool icons leave room for their complete strokes", async ({ page }, info) => {
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { CAD_TOOL_ICONS } from './src/renderer/src/drawing-markup/cad-tool-icons';
        document.body.innerHTML = [22, 32].map(size => '<div style="display:flex;gap:16px;margin-bottom:12px">' + ['chain.drive', 'gear.external', 'spring', 'spring.extension'].map(id =>
          renderToStaticMarkup(createElement(CAD_TOOL_ICONS[id], {width:size, height:size}))
        ).join('') + '</div>').join('');`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  await page.setViewportSize({ width: 300, height: 160 });
  await page.setContent("<body style='padding:30px;background:white'></body>");
  await page.addStyleTag({
    content: readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8"),
  });
  const script = bundle.outputFiles[0];
  if (!script) throw new Error("Missing icon fixture bundle");
  await page.addScriptTag({ content: script.text });
  const bounds = await page.locator("svg > path, svg > circle").evaluateAll((nodes) =>
    nodes.map((node) => {
      const shape = node as SVGGraphicsElement;
      const box = shape.getBBox();
      const halfStroke = parseFloat(getComputedStyle(shape).strokeWidth) / 2;
      return {
        left: box.x - halfStroke,
        top: box.y - halfStroke,
        right: box.x + box.width + halfStroke,
        bottom: box.y + box.height + halfStroke,
      };
    }),
  );
  expect(bounds.length).toBeGreaterThan(0);
  for (const box of bounds) {
    expect(box.left).toBeGreaterThan(0);
    expect(box.top).toBeGreaterThan(0);
    expect(box.right).toBeLessThan(24);
    expect(box.bottom).toBeLessThan(24);
  }
  await page.screenshot({ path: info.outputPath("mechanical-icons.png") });
});
