import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("label lettering stays the same size and keyword drafts survive canvas navigation", async ({ workbench }) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(), page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "新建专利" });
  await creation.getByRole("radio", { name: "实用新型", exact: true }).check();
  await creation.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(creation).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const ws = page.getByRole("region", { name: "CAD标号", exact: true });
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  const canvas = ws.getByRole("application", { name: "CAD标号画布", exact: true });
  await expect(ws.getByRole("button", { name: "标号", exact: true })).toBeEnabled({timeout:60_000});
  await ws.getByRole("button", { name: "标号", exact: true }).click();
  await expect(page.getByLabel("标号内容", {exact:true})).not.toHaveAttribute("list");
  // Exercise the normal SVG fallback before the asynchronous native outlines arrive.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    const held: Array<() => void> = [];
    Worker.prototype.postMessage = function(this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      if ((args[0] as {method?:string})?.method === "labelGlyph") held.push(() => original.apply(this,args));
      else original.apply(this,args);
    } as Worker["postMessage"];
    (window as typeof window & { releaseCadLabelGlyph?: () => void }).releaseCadLabelGlyph = () => {
      Worker.prototype.postMessage = original;
      held.forEach(send => send());
    };
  });
  await page.getByLabel("标号内容", {exact:true}).fill("987");
  await canvas.click({position:{x:180,y:300}});
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x+350,box.y+250);
  const ghost = canvas.locator('[data-drawing-preview="label"]');
  await expect(ghost.locator("text")).toBeVisible();
  const fallback = await ghost.locator("text").evaluate(async element => {
    await document.fonts.load('20px "CAD Unified Text"');
    const style = getComputedStyle(element), context = document.createElement("canvas").getContext("2d")!;
    // Measure at font-design scale so integer pixel hinting of a small label
    // does not look like a difference in its actual outline dimensions.
    context.font = `1000px ${style.fontFamily}`;
    const fontScale = Number.parseFloat(style.fontSize) / 1000;
    const metrics = context.measureText(element.textContent!);
    const matrix = (element as SVGTextElement).getScreenCTM()!;
    return {width:(metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight)*fontScale*Math.hypot(matrix.a,matrix.b),
      height:(metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent)*fontScale*Math.hypot(matrix.c,matrix.d)};
  });
  await page.evaluate(() => (window as typeof window & {releaseCadLabelGlyph?:()=>void}).releaseCadLabelGlyph?.());
  const native = ghost.locator("[data-label-native-glyph]");
  await expect(native).toBeVisible();
  const preview = (await native.boundingBox())!;
  expect(fallback.height/preview.height).toBeCloseTo(1,1);
  expect(fallback.width/preview.width).toBeCloseTo(1,1);
  await canvas.click({position:{x:350,y:250}});
  const keyword = page.getByLabel("标号987关键词", {exact:true});
  await expect(keyword).toBeVisible();
  const id = await canvas.locator("[data-annotation] text").filter({hasText:/^987$/}).evaluate(element => element.parentElement!.getAttribute("data-annotation"));
  const filled = ws.locator(`[data-cad-label="${id}"] path:not([fill="none"])`);
  await expect(filled.first()).toBeVisible();
  const placed = await filled.evaluateAll(elements => {
    const boxes = elements.map(element=>element.getBoundingClientRect());
    return {width:Math.max(...boxes.map(b=>b.right))-Math.min(...boxes.map(b=>b.left)),
      height:Math.max(...boxes.map(b=>b.bottom))-Math.min(...boxes.map(b=>b.top))};
  });
  expect(placed.height/preview.height).toBeCloseTo(1,2);
  expect(placed.width/preview.width).toBeCloseTo(1,2);
  await keyword.fill("传动杆");
  await page.mouse.move(box.x+500,box.y+400);
  await page.mouse.down({button:"middle"});
  await page.mouse.move(box.x+540,box.y+430,{steps:5});
  await page.mouse.up({button:"middle"});
  await expect(keyword).toHaveValue("传动杆");
  await ws.getByRole("button",{name:"缩小图纸",exact:true}).click();
  await expect(keyword).toHaveValue("传动杆");
  await canvas.dispatchEvent("pointercancel",{pointerId:1,button:1});
  await expect(keyword).toBeVisible();
  await page.getByLabel("标号内容",{exact:true}).fill("988");
  await canvas.click({position:{x:100,y:450}});
  await expect(keyword).toHaveCount(0);
  await canvas.click({position:{x:180,y:400}});
  await expect(page.getByLabel("标号988关键词",{exact:true})).toBeVisible();
  await canvas.press("Escape");
  await expect(page.getByPlaceholder("填入关键词（选填）")).toHaveCount(0);
  await page.getByRole("tab",{name:"附图标记",exact:true}).click();
  await expect(page.getByRole("button",{name:"选中标号987",exact:true})).toContainText("传动杆");
});
