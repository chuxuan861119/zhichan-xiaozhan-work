import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });
const origin = process.env.REFERENCE_MARK_TEST_ORIGIN ?? "http://127.0.0.1:5173";
const fixture = resolve("tests/e2e/fixtures/reference-mark-edit-motion.html");

for (const active of [false, true]) {
  test(`keyword editing has continuous outer geometry with highlight=${active}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${origin}/@fs/${fixture}?active=${active}`);
    await page.getByRole("button", { name: "编辑箱体", exact: true }).waitFor();
    const metrics = await page
      .locator('[data-reference-list-id="mark-1"]')
      .evaluate(async (row) => {
        const sample = () => ({
          height: row.getBoundingClientRect().height,
          padding: parseFloat(getComputedStyle(row).paddingTop),
        });
        const frames = async () => {
          const values = [];
          for (let i = 0; i < 32; i++) {
            await new Promise(requestAnimationFrame);
            values.push(sample());
          }
          return values;
        };
        const beforeOpen = sample();
        row.querySelector<HTMLButtonElement>(".reference-mark-panel__row-menu")?.click();
        const opening = await frames();
        row.querySelector<HTMLButtonElement>('[aria-label="取消箱体修改"]')?.click();
        const closing = await frames();
        return { beforeOpen, opening, closing };
      });
    const firstOpening = metrics.opening[0];
    const firstClosing = metrics.closing[0];
    if (!firstOpening || !firstClosing) throw new Error("Missing motion frames");
    expect(Math.abs(firstOpening.height - metrics.beforeOpen.height)).toBeLessThan(2);
    expect(metrics.opening.some((frame) => frame.padding > 4 && frame.padding < 8)).toBe(true);
    expect(metrics.closing.some((frame) => frame.padding > 4 && frame.padding < 8)).toBe(true);
    expect(Math.abs(firstClosing.height - (metrics.opening.at(-1)?.height ?? 0))).toBeLessThan(2);
    expect(
      metrics.opening.every((frame, i, frames) => {
        const previous = frames[i - 1];
        return !previous || frame.height >= previous.height - 0.5;
      }),
    ).toBe(true);
    expect(
      metrics.closing.every((frame, i, frames) => {
        const previous = frames[i - 1];
        return !previous || frame.height <= previous.height + 0.5;
      }),
    ).toBe(true);
    expect(metrics.closing.at(-1)?.height).toBeCloseTo(metrics.beforeOpen.height, 0);
    await expect(page.getByRole("button", { name: "编辑箱体", exact: true })).toBeVisible();
  });
}

test("highlighted keyword input boundaries remain visible after opening and reopening", async ({
  page,
}) => {
  await page.goto(`${origin}/@fs/${fixture}?active=true`);
  const row = page.locator('[data-reference-list-id="mark-1"]');
  await page.getByRole("button", { name: "编辑箱体", exact: true }).click();
  const input = page.getByRole("textbox", { name: "箱体关键词" });
  await expect(input).toBeVisible();
  const colors = await input.evaluate((element) => {
    const row = element.closest("[data-reference-list-id]");
    if (!row) throw new Error("Missing row");
    const style = getComputedStyle(element);
    return {
      input: style.backgroundColor,
      row: getComputedStyle(row).backgroundColor,
      border: style.borderColor,
    };
  });
  expect(colors.border).not.toBe("rgba(0, 0, 0, 0)");
  await input.fill("临时草稿");
  await page.getByRole("button", { name: "取消箱体修改" }).click();
  await page.getByRole("button", { name: "编辑箱体", exact: true }).click();
  await expect(input).toHaveValue("箱体");
  await expect(row).toHaveClass(/is-keyword-active/u);
  const borderBeforeError = await row.evaluate(
    (element) => getComputedStyle(element).borderTopWidth,
  );
  await page.getByRole("textbox", { name: "箱体序号" }).fill("0");
  await page.getByRole("button", { name: "保存箱体" }).click();
  await expect(row).toContainText("序号必须是正整数");
  expect(await row.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe(
    borderBeforeError,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  await page.getByRole("button", { name: "取消箱体修改" }).click();
  await expect(row.locator("input")).toHaveCount(0);
});
