import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

for (const deviceScaleFactor of [1, 2]) {
  test(`dialog contours stay crisp at ${deviceScaleFactor}x pixel density`, async ({ browser }) => {
    const context = await browser.newContext({
      deviceScaleFactor,
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      await page.setContent('<div class="standard-dialog-overlay"></div>');
      for (const file of [
        "app/app.css",
        "shared/standard-dialog.css",
        "exports/print-center.css",
      ]) {
        await page.addStyleTag({
          content: readFileSync(`src/renderer/src/${file}`, "utf8"),
        });
      }
      await page.addStyleTag({
        content: `
          body, .standard-dialog-overlay { background: #9399a3; }
          .probe { position: fixed; left: 100px; top: 100px; width: 600px;
            height: 600px; min-height: 0; max-height: none; animation: none; }
        `,
      });
      for (const className of [
        "application-settings-dialog__surface",
        "standard-dialog print-center-dialog",
      ]) {
        await page.locator(".standard-dialog-overlay").evaluate((parent, className) => {
          parent.replaceChildren();
          const surface = document.createElement("section");
          surface.className = `${className} probe`;
          parent.append(surface);
        }, className);
        const probe = page.locator(".probe");
        // A horizontal pixel strip through the straight left edge, clear of its corner.
        const { data, info } = await sharp(
          await page.screenshot({ clip: { x: 96, y: 200, width: 8, height: 1 } }),
        )
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const red = (x: number) => data[x * info.channels] ?? 0;
        const edge = 4 * deviceScaleFactor;
        // A single dark pixel separates the backdrop from the fully painted surface;
        // the old light border instead left a two-pixel grey band inside at 2x.
        expect(red(edge - 1), className).toBeLessThan(red(edge - 2) - 20);
        expect(red(edge), className).toBeGreaterThan(240);
        expect(red(edge + 1), className).toBe(red(edge));
        await expect(probe).toHaveCSS("border-top-width", "1px");
        await expect(probe).toHaveCSS("border-radius", "12px");
      }
    } finally {
      await context.close();
    }
  });
}
