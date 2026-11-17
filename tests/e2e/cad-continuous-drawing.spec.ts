import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("rapid continuous strokes are all accepted and durably saved before CAD closes", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  let page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const line = panel.getByRole("button", { name: "直线", exact: true });
  await expect(line).toBeEnabled({ timeout: 60_000 });
  await expect(workspace.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
    { timeout: 60_000 },
  );
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas has not loaded");
  const image = workspace.locator(".drawing-vector-preview img").first();
  const retainedSource = await image.getAttribute("src");
  if (!retainedSource) throw new Error("Preview has not loaded");
  // New-drawing setup has its own disabled-to-ready opacity transition. Begin
  // sampling only once that initial transition has completed.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [".drawing-import", ".drawing-project-name", '[data-drawing-tool="select"]'].map(
          (selector) => {
            const button = document.querySelector(selector);
            return button ? getComputedStyle(button).opacity : null;
          },
        ),
      ),
    )
    .toEqual(["1", "1", "1"]);
  await page.evaluate(() => {
    const buttons = [
      document.querySelector<HTMLButtonElement>(".drawing-import"),
      document.querySelector<HTMLButtonElement>(".drawing-project-name"),
      document.querySelector<HTMLButtonElement>('[data-drawing-tool="select"]'),
    ];
    if (buttons.some((button) => !button)) throw new Error("Drawing controls missing");
    const baseline = buttons.map((button) => getComputedStyle(button!).opacity);
    const badge = document.querySelector(".patent-tabs__state-badge");
    if (!badge) throw new Error("Patent state badge missing");
    const badgeBounds = badge.getBoundingClientRect();
    const state = {
      running: true,
      frames: 0,
      locked: 0,
      dimmed: 0,
      badgeDrift: 0,
      mismatches: [] as {
        index: number;
        baseline: string;
        opacity: string;
        lock: string | null;
        connected: boolean;
      }[],
    };
    (window as unknown as { cadChromeFrames: typeof state }).cadChromeFrames = state;
    const sample = () => {
      if (!state.running) return;
      buttons.forEach((button, index) => {
        if (button!.disabled) state.locked++;
        const opacity = getComputedStyle(button!).opacity;
        if (opacity !== baseline[index]) {
          state.dimmed++;
          if (state.mismatches.length < 9)
            state.mismatches.push({
              index,
              baseline: baseline[index]!,
              opacity,
              lock:
                button!.closest("[data-cad-save-locked]")?.getAttribute("data-cad-save-locked") ??
                null,
              connected: button!.isConnected,
            });
        }
      });
      const bounds = badge.getBoundingClientRect();
      state.badgeDrift = Math.max(
        state.badgeDrift,
        Math.abs(bounds.x - badgeBounds.x),
        Math.abs(bounds.width - badgeBounds.width),
      );
      state.frames++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await line.click();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(workspace.locator(".cad-cursor")).toHaveCount(0);
  await page.mouse.click(box.x + box.width / 2 - 150, box.y + box.height / 2 - 30);
  for (let index = 0; index < 5; index++) {
    await page.mouse.click(
      box.x + box.width / 2 - 100 + index * 40,
      box.y + box.height / 2 + (index % 2) * 30,
    );
    // Deliberately arrive before the measured 230–320 ms checkpoint completes.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 35)));
  }
  const countLines = () =>
    page.evaluate(async () => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok) throw new Error(list.error.message);
      const patent = list.value[0];
      if (!patent) throw new Error("Test patent missing");
      const opened = await window.patentApi.patents.open(patent.patentId);
      if (!opened.ok) throw new Error(opened.error.message);
      const cad = opened.value.patent.drawingProjects[0]?.cad;
      if (!cad) throw new Error("CAD checkpoint missing");
      const source = await window.patentApi.assets.readDrawingSource(
        opened.value.sessionId,
        cad.assetId,
      );
      if (!source.ok) throw new Error(source.error.message);
      return new TextDecoder()
        .decode(source.value)
        .split(/\r?\n/u)
        .filter((line) => line === "LINE").length;
    });
  await expect.poll(countLines, { timeout: 15_000 }).toBe(5);
  const chrome = await page.evaluate(() => {
    const state = (
      window as unknown as {
        cadChromeFrames: {
          running: boolean;
          frames: number;
          locked: number;
          dimmed: number;
          badgeDrift: number;
          mismatches: unknown[];
        };
      }
    ).cadChromeFrames;
    state.running = false;
    return state;
  });
  expect(chrome.frames).toBeGreaterThan(0);
  expect(chrome.locked).toBe(0);
  expect(chrome.dimmed, JSON.stringify(chrome.mismatches)).toBe(0);
  expect(chrome.badgeDrift).toBeLessThan(0.1);
  // Saving may progress while LINE remains active, but must not repaint the
  // complete canvas between individual points.
  await expect(image).toHaveAttribute("src", retainedSource);
  await page.mouse.move(box.x + box.width / 2 - 148, box.y + box.height / 2 - 28);
  await expect(workspace.locator(".cad-cursor.is-snapped path")).toHaveCount(1);
  await expect(workspace.locator(".cad-cursor rect")).toHaveCount(0);
  await page.evaluate(() => {
    const image = document.querySelector(".drawing-vector-preview img");
    if (!image) throw new Error("Preview missing");
    const baseline = image.getBoundingClientRect();
    const state = { running: true, drift: 0, missing: 0, frames: 0 };
    (window as unknown as { cadContinuousFrame: typeof state }).cadContinuousFrame = state;
    const sample = () => {
      if (!state.running) return;
      const current = document.querySelector(".drawing-vector-preview img");
      if (!current) state.missing++;
      else {
        const rect = current.getBoundingClientRect();
        state.drift = Math.max(
          state.drift,
          Math.abs(rect.x - baseline.x),
          Math.abs(rect.y - baseline.y),
          Math.abs(rect.width - baseline.width),
          Math.abs(rect.height - baseline.height),
        );
      }
      state.frames++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.click(box.x + 40, box.y + box.height / 2 + 50);
  await expect.poll(countLines, { timeout: 15_000 }).toBe(6);
  const frames = await page.evaluate(() => {
    const state = (
      window as unknown as {
        cadContinuousFrame: { running: boolean; drift: number; missing: number; frames: number };
      }
    ).cadContinuousFrame;
    state.running = false;
    return state;
  });
  expect(frames.frames).toBeGreaterThan(0);
  expect(frames.missing).toBe(0);
  expect(frames.drift).toBeLessThan(0.1);
  // Close immediately after another accepted point, without waiting for its
  // checkpoint. The close participant must drain both queues before unmount.
  await page.mouse.click(box.x + 100, box.y + box.height / 2 + 80);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(workspace).toBeHidden();
  expect(await countLines()).toBe(7);
  await app.close();
  const reopened = await workbench.launch();
  page = await reopened.firstWindow();
  await dismissWorkbenchWelcome(page);
  expect(await countLines()).toBe(7);
});
