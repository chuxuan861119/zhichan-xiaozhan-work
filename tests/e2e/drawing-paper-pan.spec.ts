import { readFile } from "node:fs/promises";
import { chromium, expect, test } from "@playwright/test";
import sharp from "sharp";

for (const deviceScaleFactor of [1, 1.5]) {
  test(`paper stays white through live pan and release at DPR ${deviceScaleFactor}`, async () => {
    const browser = await chromium.launch({
      ...(process.platform === "win32" ? { channel: "msedge" } : {}),
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 500, height: 400 },
        deviceScaleFactor,
      });
      const css = await readFile("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");
      await page.setContent(`<style>${css}
        body{margin:0;background:#112233}.drawing-stage{width:400px;height:300px;flex:none}
        </style><section class="drawing-stage"><div class="drawing-viewport">
        <svg class="drawing-cad-paper" viewBox="0 0 400 300">
          <rect x="-1000" y="-1000" width="3000" height="3000" fill="white"/>
        </svg></div></section>`);
      const pixel = async (x: number, y: number) => {
        const { data, info } = await sharp(await page.screenshot())
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const offset =
          (Math.round(y * deviceScaleFactor) * info.width + Math.round(x * deviceScaleFactor)) * 4;
        return [...data.subarray(offset, offset + 3)];
      };
      const paper = page.locator(".drawing-cad-paper");
      for (const zoom of [1, 10]) {
        await paper.evaluate(
          (el, zoom) => el.setAttribute("viewBox", `0 0 ${400 / zoom} ${300 / zoom}`),
          zoom,
        );
        for (const [dx, dy, x, y] of [
          [80, 0, 20, 150],
          [-80, 0, 380, 150],
          [0, 80, 200, 20],
          [0, -80, 200, 280],
        ]) {
          await paper.evaluate(
            (el, d) => {
              (el as SVGSVGElement).style.transform = `translate3d(${d[0]}px,${d[1]}px,0)`;
            },
            [dx!, dy!],
          );
          expect(await pixel(x!, y!)).toEqual([255, 255, 255]);
          await paper.evaluate(
            (el, v) => {
              (el as SVGSVGElement).style.transform = "";
              el.setAttribute(
                "viewBox",
                `${-v.dx / v.zoom} ${-v.dy / v.zoom} ${400 / v.zoom} ${300 / v.zoom}`,
              );
            },
            { dx: dx!, dy: dy!, zoom },
          );
          expect(await pixel(x!, y!)).toEqual([255, 255, 255]);
        }
      }
      await paper.evaluate((el) => {
        el.setAttribute("viewBox", "0 0 400 300");
        const rect = el.querySelector("rect")!;
        rect.setAttribute("x", "100");
        rect.setAttribute("width", "200");
      });
      expect(await pixel(20, 150)).toEqual([237, 237, 240]);
      expect(await pixel(200, 150)).toEqual([255, 255, 255]);
      expect(await pixel(450, 150)).toEqual([17, 34, 51]);
    } finally {
      await browser.close();
    }
  });
}
