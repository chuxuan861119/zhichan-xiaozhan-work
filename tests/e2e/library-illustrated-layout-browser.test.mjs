import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const css = (
  await Promise.all(
    ["app/app.css", "library/library-view.css"].map((file) =>
      readFile(new URL(`../../src/renderer/src/${file}`, import.meta.url), "utf8"),
    ),
  )
).join("\n");

const tallImage = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960"><rect width="720" height="960" fill="#abc"/></svg>',
)}`;

test("illustrated patent image stays above the footer at single and double column widths", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [700, 860, 1000]) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.setContent(`<style>${css}</style>
        <div class="library-view" style="width:${width}px;padding:20px">
          <div class="patent-library-month-cards" data-view-mode="illustrated">
            <article class="library-card patent-card patent-illustrated-card">
              <div class="patent-illustrated-card__media">
                <fieldset class="patent-illustrated-hover patent-illustrated-card__image-hover">
                  <button class="patent-illustrated-hover__trigger"><img src="${tallImage}" alt="附图缩略图"></button>
                </fieldset>
              </div>
              <div class="patent-illustrated-card__body">专利信息</div>
              <footer class="patent-illustrated-card__footer">最后编辑时间</footer>
            </article>
          </div>
        </div>`);
      await page.locator("img").waitFor();
      const image = await page.locator("img").boundingBox();
      const media = await page.locator(".patent-illustrated-card__media").boundingBox();
      const footer = await page.locator(".patent-illustrated-card__footer").boundingBox();
      assert.ok(image.y + image.height <= media.y + media.height, `${width}px image in media`);
      assert.ok(image.y + image.height <= footer.y, `${width}px image above footer`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("ported image preview stays centered and contained in the viewport", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.setContent(`<style>${css}</style>
      <div class="spatial-presence" data-motion="enter">
        <span class="patent-illustrated-hover__popover patent-illustrated-hover__popover--image" role="dialog">
          <img src="${tallImage}" alt="附图预览">
        </span>
      </div>`);
    const preview = await page.locator("[role=dialog]").boundingBox();
    const image = await page.locator("img").boundingBox();
    assert.ok(Math.abs(preview.x + preview.width / 2 - 600) < 1);
    assert.ok(Math.abs(preview.y + preview.height / 2 - 450) < 1);
    assert.ok(preview.x >= 0 && preview.y >= 0);
    assert.ok(preview.x + preview.width <= 1200 && preview.y + preview.height <= 900);
    assert.ok(image.width <= preview.width && image.height <= preview.height);
  } finally {
    await browser.close();
  }
});
