import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

test("header keeps expansion beside the title and groups actions on the right", async ({
  page,
}) => {
  await page.setContent(
    `<aside class="text-polish-panel" style="width:395px"><header class="assistant-side-panel__header"><div class="assistant-side-panel__header-title"><span class="ai-kicker">模型</span><h2>小栈AI助手</h2></div><div class="assistant-side-panel__header-actions"><button aria-expanded="false">展开</button><button aria-label="历史对话">历史</button><button aria-label="新对话">新建</button><button>设置</button><button>关闭</button></div></header></aside>`,
  );
  await page.addStyleTag({
    content: await readFile("src/renderer/src/patents/ai-correction/text-polish-panel.css", "utf8"),
  });
  await page.locator("header button").evaluateAll((buttons) => {
    buttons.forEach((button, index) => {
      button.setAttribute("class", index < 3 ? "polish-icon-action" : "ai-icon-button");
      button.innerHTML = '<svg width="17" height="17" stroke-width="2"></svg>';
    });
  });
  const styles = await page.locator("header button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const icon = button.querySelector("svg");
      if (!icon) throw new Error("Missing icon");
      return [
        button.getBoundingClientRect().height,
        icon.getBoundingClientRect().width,
        getComputedStyle(icon).strokeWidth,
        getComputedStyle(button).borderRadius,
      ];
    }),
  );
  expect(styles).toEqual(Array.from({ length: 5 }, () => [30, 16, "1.8px", "6px"]));
  const positions = await page.locator("h2, header button").evaluateAll((items) =>
    items.map((el) => ({
      x: el.getBoundingClientRect().x,
      y: el.getBoundingClientRect().y,
      right: el.getBoundingClientRect().right,
    })),
  );
  if (
    !positions[0] ||
    !positions[1] ||
    !positions[2] ||
    !positions[3] ||
    !positions[4] ||
    !positions[5]
  )
    throw new Error("Missing header controls");
  expect(positions[1].x - positions[0].right).toBeLessThan(10);
  expect(Math.abs(positions[2].y - positions[5].y)).toBeLessThan(2);
  expect(positions[2].x).toBeLessThan(positions[3].x);
  expect(positions[3].x).toBeLessThan(positions[4].x);
});

test("preset options use the full composer row before wrapping", async ({ page }) => {
  await page.setContent(`<aside class="text-polish-panel" style="width:395px">
    <div class="text-polish-launch"><div class="text-polish-requirement">
      <textarea></textarea>
      <details open class="polish-preset-disclosure polish-launch-presets">
        <summary>常用需求</summary><fieldset class="text-polish-presets">
          <div class="text-polish-presets__options">${["专业严谨", "精简表达", "解释这段文字", "生成背景技术"].map((label) => `<button>${label}</button>`).join("")}</div>
        </fieldset>
      </details><div class="polish-launch-actions"><button class="ai-primary-action">↑</button></div>
    </div></div></aside>`);
  for (const path of [
    "src/renderer/src/app/app.css",
    "src/renderer/src/patents/ai-correction/text-polish-panel.css",
  ])
    await page.addStyleTag({ content: await readFile(path, "utf8") });
  const buttons = page.locator(".text-polish-presets__options button");
  const tops = await buttons.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().top),
  );
  expect(new Set(tops).size).toBe(1);
  await page.locator("summary").click();
  await expect(buttons.first()).toBeHidden();
  await page.locator("summary").click();
  await expect(buttons.last()).toBeVisible();
  const input = page.locator("textarea");
  const initialHeight = await input.evaluate((el) => el.getBoundingClientRect().height);
  const lineHeight = await input.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).lineHeight),
  );
  expect(Math.abs(initialHeight - lineHeight * 2)).toBeLessThan(1);
  await input.fill("第一行\n第二行\n第三行\n第四行");
  expect(await input.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(
    initialHeight,
  );
  await input.fill("较长的输入文字，用于检查滚动条。\n".repeat(20));
  expect(
    await input.evaluate((el) =>
      Math.abs(
        el.getBoundingClientRect().height - Number.parseFloat(getComputedStyle(el).lineHeight) * 6,
      ),
    ),
  ).toBeLessThan(1);
  expect(await input.evaluate((el) => getComputedStyle(el, "::-webkit-scrollbar").width)).toBe(
    "6px",
  );
  expect(
    await input.evaluate((el) => getComputedStyle(el, "::-webkit-scrollbar-button").display),
  ).toBe("none");
  await input.evaluate((el) => {
    el.scrollTop = 30;
  });
  expect(await input.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await input.fill("");
  expect(await input.evaluate((el) => el.getBoundingClientRect().height)).toBe(initialHeight);
  await input.evaluate((el) => el.parentElement?.setAttribute("class", "polish-composer"));
  expect(
    Math.abs((await input.evaluate((el) => el.getBoundingClientRect().height)) - lineHeight * 2),
  ).toBeLessThan(1);
  await input.fill("继续对话\n".repeat(10));
  expect(
    Math.abs((await input.evaluate((el) => el.getBoundingClientRect().height)) - lineHeight * 6),
  ).toBeLessThan(1);
});
