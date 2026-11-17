import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge", headless: true });

test("CAD buttons and portaled menus use fine strokes without changing drawing or line samples", async ({
  page,
}, info) => {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {Move, Copy, RotateCw, ZoomIn, Type, Spline, Pin, X} from 'lucide-react';
        import {CAD_TOOL_ICONS} from './src/renderer/src/drawing-markup/cad-tool-icons';
        import {CadToolMenu} from './src/renderer/src/drawing-markup/cad-tool-menu';
        const choices=Object.entries(CAD_TOOL_ICONS).map(([id,Icon])=>({id,label:id,tool:id,Icon}));
        createRoot(document.getElementById('root')).render(<>
          <div className="drawing-workspace"><div className="cad-tool-group"><div className="cad-entity-tools" style={{gridTemplateColumns:'repeat(8,80px)'}}>
            <CadToolMenu name="绘图" choices={choices} active={false} disabled={false} choose={()=>{}} focusCanvas={()=>{}}/>
            {[...Object.values(CAD_TOOL_ICONS),Move,Copy,RotateCw,ZoomIn,Type,Spline,Pin,X].map((Icon,i)=><button key={i}><Icon/><span>{i}</span></button>)}
          </div></div><svg role="application"><path id="geometry" d="M0 0h10" stroke-width="3"/></svg>
          <button><svg id="line-sample"><path d="M0 0h10" stroke-width="4"/></svg></button></div>
          <div className="patent-function-rail-scope" data-function-rail-scope="drawing-markup"><button><Pin/></button><button><X/></button></div>
          <div className="cad-transient-window"><button><X/></button></div>
        </>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
  });
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.setContent('<div id="root"></div>');
  for (const file of [
    "src/renderer/src/app/app.css",
    "src/renderer/src/drawing-markup/drawing-workspace.css",
    "resources/ui/workbench-ui.css",
  ])
    await page.addStyleTag({ content: readFileSync(file, "utf8") });
  const [script] = bundle.outputFiles;
  if (!script) throw new Error("Missing CAD icon fixture");
  await page.addScriptTag({ content: script.text });
  const icons = page.locator(".lucide");
  expect(await icons.count()).toBeGreaterThan(40);
  const checkStrokes = async () => {
    const strokes = await icons.evaluateAll((icons) =>
      icons.flatMap((icon) =>
        [icon, ...icon.querySelectorAll("path,circle,ellipse,rect,line,polyline,polygon")].map(
          (node) => parseFloat(getComputedStyle(node).strokeWidth),
        ),
      ),
    );
    expect(strokes.every((stroke) => stroke > 0 && stroke <= 1.25)).toBe(true);
  };
  await checkStrokes();
  await page.getByRole("button", { name: "绘图选项", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCSS("opacity", "1");
  await checkStrokes();
  await expect(page.locator("#geometry")).toHaveCSS("stroke-width", "3px");
  await expect(page.locator("#line-sample path")).toHaveCSS("stroke-width", "4px");
  await page.screenshot({ path: info.outputPath("cad-fine-icons.png") });
});
