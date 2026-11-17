import { expect, test } from "./helpers/workbench.js";

for (const scale of [1, 1.25, 1.5, 2]) {
  test(`native startup bounds fit the work area at scale ${scale}`, async ({ workbench }) => {
    const app = await workbench.launchAllowMultipleInstances(
      `--force-device-scale-factor=${scale}`,
    );
    const page = await app.firstWindow();
    expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(scale, 2);
    const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Main window missing");
      const bounds = window.getBounds();
      return {
        bounds,
        minimum: window.getMinimumSize(),
        area: screen.getDisplayMatching(bounds).workArea,
      };
    });
    expect(geometry.bounds.x).toBeGreaterThanOrEqual(geometry.area.x);
    expect(geometry.bounds.y).toBeGreaterThanOrEqual(geometry.area.y);
    expect(geometry.bounds.x + geometry.bounds.width).toBeLessThanOrEqual(
      geometry.area.x + geometry.area.width,
    );
    expect(geometry.bounds.y + geometry.bounds.height).toBeLessThanOrEqual(
      geometry.area.y + geometry.area.height,
    );
    expect(geometry.minimum[0]).toBeLessThanOrEqual(geometry.area.width);
    expect(geometry.minimum[1]).toBeLessThanOrEqual(geometry.area.height);
  });
}
