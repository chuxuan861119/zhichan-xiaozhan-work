import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("cached affine preview applies CAD coordinates correctly without rebuilding vertices", async () => {
  const component = resolve("src/renderer/src/drawing-markup/cad-gesture-preview.tsx");
  const compiled = await build({
    stdin: {
      contents: `
      import React,{createRef} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
      import {CadGesturePreview} from ${JSON.stringify(component)};
      const project={projectId:'probe',width:500,height:500,cad:{unified:1,mapping:{originX:10,originY:100,scale:2}}};
      const ref=createRef();const scene={entities:[{handle:'A',type:'Line'}],primitives:[{handle:'A',kind:'polyline',points:[[12,20],[15,25]]}]};const handles=['A'];
      flushSync(()=>createRoot(document.getElementById('root')).render(<svg><CadGesturePreview ref={ref} project={project} unit={1}/></svg>));
      window.updatePreview=(value)=>flushSync(()=>ref.current.update({mode:'move',anchor:{x:10,y:20},cursor:{x:15,y:23},points:[],snapped:false,scene,handles,...value}));
      window.clearPreview=()=>flushSync(()=>ref.current.update(null));
    `,
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
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
    for (const [value, expected] of [
      [{ mode: "move" }, [14, 154]],
      [{ mode: "copy", cursor: { x: 16, y: 24 } }, [16, 152]],
      [{ mode: "rotate", transform: { command: "rotate", base: [10, 20], angle: 90 } }, [0, 156]],
      [{ mode: "scale", transform: { command: "scale", base: [10, 20], factor: 3 } }, [12, 160]],
    ] as const) {
      const actual = await page.evaluate((value) => {
        (window as any).updatePreview(value);
        const line = document.querySelector(
          "[data-cad-affine-preview] polyline",
        ) as SVGPolylineElement;
        const p = line.points.getItem(0).matrixTransform(line.getCTM()!);
        return [p.x, p.y];
      }, value);
      expect(actual[0]).toBeCloseTo(expected[0]);
      expect(actual[1]).toBeCloseTo(expected[1]);
    }
    await page.evaluate(() => {
      (window as any).retained = document.querySelector("[data-cad-affine-preview] polyline");
    });
    const retained = await page.evaluate(() => {
      (window as any).updatePreview({ cursor: { x: 30, y: 40 } });
      return (
        (window as any).retained === document.querySelector("[data-cad-affine-preview] polyline")
      );
    });
    expect(retained).toBe(true);
    for (const [cursor, expected] of [
      [{ x: 10, y: 30 }, [-4, 160]],
      [{ x: 20, y: 30 }, [0, 156]],
    ] as const) {
      const actual = await page.evaluate((cursor) => {
        (window as any).updatePreview({ mode: "mirror", points: [{ x: 10, y: 20 }], cursor });
        const line = document.querySelector(
          "[data-cad-mirror-preview] polyline",
        ) as SVGPolylineElement;
        const p = line.points.getItem(0).matrixTransform(line.getCTM()!);
        return [p.x, p.y];
      }, cursor);
      expect(actual[0]).toBeCloseTo(expected[0]);
      expect(actual[1]).toBeCloseTo(expected[1]);
    }
    // Exercise the actual root compositor surface, including camera changes
    // while a preview remains active; do not infer alignment from CSS strings.
    await page.evaluate(() => {
      const host = document.getElementById("root")!;
      host.className = "drawing-viewport";
      host.style.cssText = "position:relative;width:500px;height:500px";
      const root = host.querySelector("svg")!;
      root.setAttribute("role", "application");
      root.setAttribute("viewBox", "0 0 500 500");
      root.style.cssText = "width:100%;height:100%";
      (window as any).clearPreview();
      (window as any).updatePreview({
        mode: "move",
        handles: ["A", ...Array.from({ length: 63 }, (_, i) => String(i))],
      });
    });
    // Dense translation now uses the same GPU surface as scaling. Verify its
    // context-loss fallback before exercising the SVG compositor coordinates.
    await expect(page.locator("[data-cad-gpu-preview]")).toBeVisible();
    await page.locator("[data-cad-gpu-preview]").evaluate(element =>
      (element as HTMLCanvasElement).getContext("webgl")!
        .getExtension("WEBGL_lose_context")!.loseContext());
    await expect(page.locator("[data-cad-gpu-preview]")).toBeHidden();
    await expect(page.locator("[data-cad-composited-preview]")).toHaveCount(1);
    const offset = () =>
      page.evaluate(() => {
        const root = document.querySelector('svg[role="application"]')!,
          rect = root.getBoundingClientRect();
        const line = document.querySelector(
          "[data-cad-composited-preview] polyline",
        ) as SVGPolylineElement;
        const p = line.points.getItem(0).matrixTransform(line.getScreenCTM()!);
        return [p.x - rect.x, p.y - rect.y];
      });
    expect(await offset()).toEqual([14, 154]);
    await page.evaluate(() => {
      const root = document.querySelector('svg[role="application"]') as SVGSVGElement;
      root.style.transform = "translate3d(25px,-10px,0)";
    });
    await expect.poll(offset).toEqual([14, 154]);
    await page.evaluate(() => {
      const root = document.querySelector('svg[role="application"]')!;
      root.setAttribute("viewBox", "0 0 250 250");
    });
    await expect.poll(offset).toEqual([28, 308]);
    await page.evaluate(() => {
      (window as any).clearPreview();
      (window as any).updatePreview({
        mode: "scale",
        transform: { command: "scale", base: [10, 20], factor: 2 },
        handles: ["A", ...Array.from({ length: 63 }, (_, i) => String(i))],
      });
    });
    await expect(page.locator("[data-cad-gpu-preview]")).toBeVisible();
    await page
      .locator("[data-cad-gpu-preview]")
      .evaluate((element) =>
        (element as HTMLCanvasElement)
          .getContext("webgl")!
          .getExtension("WEBGL_lose_context")!
          .loseContext(),
      );
    await expect(page.locator("[data-cad-gpu-preview]")).toBeHidden();
    await expect(page.locator("[data-cad-affine-preview]")).toBeVisible();
    await page.evaluate(() => (window as any).clearPreview());
    await expect(page.locator("[data-cad-composited-preview]")).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
