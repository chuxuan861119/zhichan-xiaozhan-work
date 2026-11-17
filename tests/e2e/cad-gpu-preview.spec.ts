import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("GPU preview preserves transformed positions, pixel widths, dash gaps, fills and context-loss fallback", async () => {
  const compiled = await build({
    stdin: {
      contents: `import {previewMesh,createPreviewGpu} from ${JSON.stringify(resolve("src/renderer/src/drawing-markup/cad-preview-gpu.ts"))};
      const p=(points,kind='polyline')=>({points,kind,handle:'A',lineweight:.25,color:[0,0,0],aci7:true});
      const canvas=document.querySelector('canvas');
      const renderer=createPreviewGpu(canvas,previewMesh([p([[10,20],[110,20]]),p([[20,50],[50,50],[20,80]],'triangles')],()=>1.5));
      window.draw=(scale)=>{renderer.draw(new DOMMatrix([scale,0,0,scale,0,0]),300,200,2);const gl=canvas.getContext('webgl');const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);return [...data]};
      window.lose=()=>{canvas.getContext('webgl').getExtension('WEBGL_lose_context').loseContext();};
      window.available=()=>renderer.draw(new DOMMatrix(),300,200,2);
    `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas style="width:300px;height:200px"></canvas>');
    await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
    for (const scale of [1, 2]) {
      const pixels = (await page.evaluate(
        (scale) => (window as any).draw(scale),
        scale,
      )) as number[];
      const alpha = (x: number, y: number) => pixels[((400 - 1 - y) * 600 + x) * 4 + 3] ?? 0;
      const y = 40 * scale;
      const x = 20 * scale + 4;
      expect(alpha(x, y)).toBeGreaterThan(180);
      expect(alpha(20 * scale + 13, y)).toBeLessThan(10);
      const thickness = Array.from({ length: 15 }, (_, i) => alpha(x, y + i - 7)).filter(
        (a) => a > 100,
      ).length;
      expect(thickness).toBeGreaterThanOrEqual(2);
      expect(thickness).toBeLessThanOrEqual(4);
      expect(alpha(50 * scale, 110 * scale)).toBeGreaterThan(35);
      expect(alpha(50 * scale, 110 * scale)).toBeLessThan(60);
      expect(alpha(4, 4)).toBe(0);
    }
    await page.evaluate(() => (window as any).lose());
    await expect.poll(() => page.evaluate(() => (window as any).available())).toBe(false);
  } finally {
    await browser.close();
  }
});
