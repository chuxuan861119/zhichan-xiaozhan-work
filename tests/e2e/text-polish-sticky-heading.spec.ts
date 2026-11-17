import { readFile } from "node:fs/promises";
import { expect, type Locator, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Missing visible reasoning heading");
  return box;
}

test("polish reasoning headings stay reachable while their content scrolls", async ({ page }) => {
  const appCss = await readFile("src/renderer/src/app/app.css", "utf8");
  const polishCss = await readFile(
    "src/renderer/src/patents/ai-correction/text-polish-panel.css",
    "utf8",
  );
  const thinkingCss = await readFile(
    "src/renderer/src/patents/ai-correction/ai-thinking-feedback.css",
    "utf8",
  );
  await page.setContent(`<style>${appCss}\n${polishCss}\n${thinkingCss}</style>
    <div class="text-polish-panel" style="width:395px"><div class="text-polish-conversation">
      <div class="text-polish-conversation__messages" style="height:500px;flex:none" role="log">
        <article class="text-polish-conversation__message is-assistant">
          <details class="polish-completed-reasoning" open><summary>思考过程</summary><pre>${"较长的思考文字\n".repeat(90)}</pre></details>
        </article>
        <section class="ai-thinking-feedback"><div class="ai-thinking-feedback__actions"><button type="button">收起思考过程</button></div><div class="ai-thinking-feedback__content">${"正在分析<br>".repeat(90)}</div></section>
      </div>
    </div></div>`);
  const summary = page.locator("summary");
  const before = await bounds(summary);
  await page.locator("details pre").evaluate((el) => {
    el.scrollTop = 400;
  });
  expect((await bounds(summary)).y).toBe(before.y);
  await summary.click();
  await expect(page.locator("details")).not.toHaveAttribute("open");
  const button = page.getByRole("button", { name: "收起思考过程" });
  const liveTop = (await bounds(button)).y;
  const content = page.locator(".ai-thinking-feedback__content");
  await content.evaluate((el) => {
    el.scrollTop = 400;
  });
  expect((await bounds(content)).height).toBeLessThanOrEqual(280);
  expect((await bounds(button)).y).toBe(liveTop);
  await expect(button).toBeInViewport();
});
