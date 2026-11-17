import { readFileSync } from "node:fs";
import { chromium, expect, test } from "@playwright/test";

test("CAD canvas keeps its grid row when the function rail shares the canvas cell", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<style>${readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8")}html,body{margin:0;height:100%}.drawing-workspace{height:100vh}</style><section class="drawing-workspace"><section class="drawing-workspace-content"><aside class="drawing-sources"></aside><header class="drawing-header">CAD标号</header><div class="drawing-toolbar">标号</div><div class="drawing-layout"><div class="drawing-stage"><div class="drawing-viewport"><svg aria-label="CAD标号画布"><rect width="100" height="100" fill="black"/></svg></div></div></div><div class="drawing-status">已导入</div><div class="patent-function-rail-scope"></div></section></section>`,
    );
    for (const [width, height] of [
      [1440, 900],
      [1280, 720],
      [960, 600],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      const geometry = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return {
          height: r(".drawing-viewport").height,
          top: r(".drawing-layout").top,
          railTop: r(".patent-function-rail-scope").top,
          bottom: r(".drawing-layout").bottom,
          status: r(".drawing-status").top,
        };
      });
      expect(geometry.height).toBeGreaterThan(300);
      expect(geometry.top).toBe(geometry.railTop);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.status);
    }
  } finally {
    await browser.close();
  }
});
