import type { Page } from "@playwright/test";
import sharp from "sharp";
import {
  dismissWorkbenchWelcome,
  expect,
  test,
  type WorkbenchHarness,
} from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
type CadScene = {
  partial?: boolean;
  removedHandles?: string[];
  entities: {
    handle: string;
    type: string;
    grips?: [number, number][];
    radius?: number;
    geometry?: { center?: { x: number; y: number }; radius?: number };
  }[];
  primitives: { handle: string }[];
};
async function nativeEntities(page: Page, refresh = false) {
  if (refresh) await page.evaluate(async()=>{
    const state=window as unknown as {nativeCadWorker:Worker;nativeCadScene:CadScene;nativeProbeId?:number};
    const id=state.nativeProbeId=(state.nativeProbeId ?? 0)-1;
    state.nativeCadScene=await new Promise<CadScene>((resolve,reject)=>{
      const listener=(event:MessageEvent)=>{
        if(event.data.id!==id)return;
        state.nativeCadWorker.removeEventListener("message",listener);
        if(event.data.ok)resolve(event.data.value);
        else reject(new Error(event.data.error));
      };
      state.nativeCadWorker.addEventListener("message",listener);
      state.nativeCadWorker.postMessage({id,method:"scene",args:[]});
    });
  });
  return page.evaluate(
    () => (window as unknown as { nativeCadScene: CadScene }).nativeCadScene.entities,
  );
}
async function setup(workbench: WorkbenchHarness) {
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    const workers = new WeakSet<Worker>();
    const scenes = new WeakMap<Worker, CadScene>();
    const sceneReads = new WeakMap<Worker, Set<number>>();
    Worker.prototype.postMessage = function (
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (!workers.has(this)) {
        workers.add(this);
        sceneReads.set(this, new Set());
        this.addEventListener("message", (event) => {
          // Edits wrap scene; restoring a history checkpoint returns the scene directly.
          const direct = sceneReads.get(this)!.delete(event.data?.id);
          let scene = (event.data?.value?.scene ?? (direct ? event.data?.value : undefined)) as CadScene | undefined;
          if (scene && Array.isArray(scene.entities) && Array.isArray(scene.primitives)) {
            const previous = scenes.get(this);
            if (scene.partial && previous) {
              const replaced = new Set([
                ...scene.entities.map((entity) => entity.handle),
                ...(scene.removedHandles ?? []),
              ]);
              scene = {
                ...scene,
                partial: false,
                entities: [
                  ...previous.entities.filter((entity) => !replaced.has(entity.handle)),
                  ...scene.entities,
                ],
                primitives: [
                  ...previous.primitives.filter((primitive) => !replaced.has(primitive.handle)),
                  ...scene.primitives,
                ],
              };
            }
            scenes.set(this, scene);
            (window as unknown as { nativeCadScene: CadScene }).nativeCadScene = scene;
          }
        });
      }
      const sent = message as {id:number;method:string};
      if (["load","restore","checkout","scene"].includes(sent.method))
        sceneReads.get(this)!.add(sent.id);
      if (sent.method === "edit")
        (window as unknown as {nativeCadWorker:Worker}).nativeCadWorker=this;
      return Reflect.apply(
        original,
        this,
        transfer === undefined ? [message] : [message, transfer],
      );
    };
  });
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
  await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await expect(workspace.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
  );
  const box = await canvas.boundingBox();
  if (!box) throw new Error("CAD canvas missing");
  return { app, page, workspace, panel, canvas, box };
}
async function project(page: Page) {
  return page.evaluate(async () => {
    const list = await window.patentApi.patents.list("active");
    if (!list.ok || !list.value[0]) throw new Error("Patent missing");
    const opened = await window.patentApi.patents.open(list.value[0].patentId);
    if (!opened.ok || !opened.value.patent.drawingProjects[0]) throw new Error("Drawing missing");
    return opened.value.patent.drawingProjects[0];
  });
}
async function screenPoint(page: Page, point: [number, number]) {
  const drawing = await project(page);
  if (!drawing.cad) throw new Error("CAD mapping missing");
  return page.evaluate(
    ({ point, mapping }) => {
      const svg = document.querySelector('[aria-label="CAD标号画布"]') as SVGSVGElement;
      const p = new DOMPoint(
        (point[0] - mapping.originX) * mapping.scale,
        (mapping.originY - point[1]) * mapping.scale,
      ).matrixTransform(svg.getScreenCTM()!);
      return { x: p.x, y: p.y };
    },
    { point, mapping: drawing.cad.mapping },
  );
}

async function painted(page: Page) {
  const pending = page.locator('[aria-label="CAD标号画布"] [data-cad-pending-drawings]');
  await expect(pending).toHaveCount(0);
}

test("dragging a selected stroke moves the whole set once, while grips, cancellation and clicks remain independent", async ({workbench}) => {
  const {page,panel,canvas,box,workspace}=await setup(workbench);
  const saved=async()=>{
    await expect(workspace).toHaveAttribute("data-cad-pending","false");
    await expect(workspace.locator('[data-save-state="saved"]')).toBeVisible();
  };
  for(const y of [220,320]){
    await panel.getByRole("button",{name:"直线",exact:true}).click();
    await page.mouse.click(box.x+160,box.y+y);
    await page.mouse.click(box.x+360,box.y+y);
    await canvas.press("Enter");
    await saved();
  }
  await canvas.press("Control+a");
  const before=(await nativeEntities(page)).filter(e=>e.type.toLowerCase()==="line");
  expect(before).toHaveLength(2);
  const line=before[0]!, other=before[1]!;
  const a=line.grips![0]!, b=line.grips![2]!;
  const grab=await screenPoint(page,[a[0]*0.75+b[0]*0.25,a[1]*0.75+b[1]*0.25]);
  // Instrument the worker boundary, not a UI hint: no geometry writes during movement.
  await page.evaluate(()=>{
    const original=Worker.prototype.postMessage;
    (window as unknown as {dragEdits:number}).dragEdits=0;
    Worker.prototype.postMessage=function(message:unknown,...rest:unknown[]){
      if((message as {method?:string}).method==="edit") (window as unknown as {dragEdits:number}).dragEdits++;
      return Reflect.apply(original,this,[message,...rest]);
    };
  });
  const edits=()=>page.evaluate(()=>(window as unknown as {dragEdits:number}).dragEdits);
  await page.mouse.move(grab.x,grab.y);
  await page.mouse.down();
  // No artificial hold: the first real move must respond immediately.
  await page.mouse.move(grab.x+45,grab.y+35);
  await expect(canvas.locator("[data-cad-affine-preview]")).toBeVisible();
  expect(await edits()).toBe(0);
  expect(await nativeEntities(page)).toEqual(before);
  await page.mouse.up();
  await saved();
  expect(await edits()).toBe(1);
  const moved=await nativeEntities(page);
  const shifted=moved.find(e=>e.handle===line.handle)!;
  const dx=shifted.grips![0]![0]-a[0],dy=shifted.grips![0]![1]-a[1];
  expect(Math.abs(dx)).toBeGreaterThan(0);
  expect(Math.abs(dy)).toBeGreaterThan(0);
  for(const entity of before){
    const after=moved.find(e=>e.handle===entity.handle)!;
    entity.grips!.forEach((p,i)=>{
      expect(after.grips![i]![0]-p[0]).toBeCloseTo(dx,5);
      expect(after.grips![i]![1]-p[1]).toBeCloseTo(dy,5);
    });
  }
  await canvas.press("Control+z");await saved();
  await expect.poll(async()=>(await nativeEntities(page,true)).find(e=>e.handle===line.handle)?.grips).toEqual(line.grips);
  await canvas.press("Control+y");await saved();
  await expect.poll(async()=>(await nativeEntities(page,true)).find(e=>e.handle===line.handle)?.grips).toEqual(shifted.grips);
  await canvas.press("Control+a");
  const p=await screenPoint(page,[
    shifted.grips![0]![0]*0.75+shifted.grips![2]![0]*0.25,
    shifted.grips![0]![1]*0.75+shifted.grips![2]![1]*0.25,
  ]);
  // A plain click or a cancelled drag creates no undo/save operation.
  await page.mouse.click(p.x,p.y);
  await page.mouse.move(p.x,p.y);await page.mouse.down();
  await page.mouse.move(p.x+25,p.y+25);
  await expect(canvas.locator("[data-cad-affine-preview]")).toBeVisible();
  await canvas.press("Escape");await page.mouse.up();
  expect(await edits()).toBe(1);
  expect((await nativeEntities(page)).find(e=>e.handle===line.handle)?.grips).toEqual(shifted.grips);
  await page.mouse.move(p.x,p.y);await page.mouse.down();
  await page.mouse.move(p.x+25,p.y+25);
  await expect(canvas.locator("[data-cad-affine-preview]")).toBeVisible();
  await page.mouse.move(p.x,p.y);await page.mouse.up();
  expect(await edits()).toBe(1);
  await expect(canvas).toHaveAttribute("data-cad-pickbox","true");
  await page.mouse.move(p.x,p.y);await page.mouse.down();
  await page.mouse.move(p.x+25,p.y+25);
  await expect(canvas.locator("[data-cad-affine-preview]")).toBeVisible();
  await canvas.dispatchEvent("pointercancel",{pointerId:1,pointerType:"mouse",isPrimary:true,buttons:1});
  await page.mouse.up();
  expect(await edits()).toBe(1);
  await expect(canvas).toHaveAttribute("data-cad-pickbox","true");
  // The endpoint edits only this line, despite a second selected object.
  const grip=await screenPoint(page,shifted.grips![0]!);
  await page.mouse.move(grip.x,grip.y);await page.mouse.down();
  await page.mouse.move(grip.x-30,grip.y-25);
  await expect(canvas.locator(".cad-grip-shape")).toBeVisible();
  await page.mouse.up();await saved();
  expect(await edits()).toBe(2);
  const result=await nativeEntities(page);
  expect(result.find(e=>e.handle===other.handle)?.grips).toEqual(moved.find(e=>e.handle===other.handle)?.grips);
  expect(result.find(e=>e.handle===line.handle)?.grips?.[2]).toEqual(shifted.grips![2]);
  expect(result.find(e=>e.handle===line.handle)?.grips?.[0]).not.toEqual(shifted.grips![0]);
});

test("pick box stays in selection mode after selecting an entity while tools and panning keep their own cursors", async ({
  workbench,
}) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const cursor = () => canvas.evaluate((element) => getComputedStyle(element).cursor);
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  const idleCursor = await cursor();
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "false");
  expect(await cursor()).not.toBe(idleCursor);
  await canvas.press("Escape");
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  expect(await cursor()).toBe(idleCursor);
  await page.mouse.click(box.x + 30, box.y + 30);
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "false");
  await canvas.press("Escape");
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.click(x - 80, y - 60);
  await page.mouse.click(x + 80, y + 60);
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(panel.getByRole("button", { name: "选择", exact: true })).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  await page.mouse.click(x, y - 60);
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  expect(await cursor()).toBe(idleCursor);
  await canvas.press("Escape");
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + 5, y + 5);
  await expect.poll(cursor).toBe("grabbing");
  await page.mouse.up({ button: "middle" });
  expect(await cursor()).toBe(idleCursor);
});

test("accepted line stays visually stable through background saving and drawing remains available outside old extents", async ({
  workbench,
}) => {
  const { page, workspace, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await page.mouse.click(x - 120, y);
  await page.mouse.click(x + 120, y);
  // The accepted native scene now paints immediately, so a transient pending
  // SVG need not survive until the test observes it. Compare it with the saved
  // scene, not with the blue dashed rubber-band shown before accepting a point.
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(1);
  // Move the next segment's cursor/guide off the accepted stroke before sampling.
  await page.mouse.move(x + 180, y + 120);
  const ink = async () => {
    const image = await sharp(await canvas.screenshot())
      .extract({
        left: Math.round(box.width / 2 - 90),
        top: Math.round(box.height / 2 - 4),
        width: 180,
        height: 9,
      })
      .removeAlpha()
      .raw()
      .toBuffer();
    let total = 0;
    for (let i = 0; i < image.length; i += 3)
      total += 255 - (image[i]! + image[i + 1]! + image[i + 2]!) / 3;
    return total;
  };
  const before = await ink();
  await canvas.press("Enter");
  await expect(workspace).toHaveAttribute("data-cad-pending", "false");
  await painted(page);
  const after = await ink();
  expect(before).toBeGreaterThan(1000);
  expect(Math.abs(after - before) / before).toBeLessThan(0.05);
  const frame = (await project(page)).cad!.mapping;
  await expect(workspace.locator(".drawing-stage")).toHaveAttribute("data-infinite-cad", "true");
  await expect(workspace.locator(".drawing-cad-paper")).toHaveCount(0);
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(box.x + 100, y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(box.x + box.width - 100, y, { steps: 4 });
    await page.mouse.up({ button: "middle" });
  }
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await page.mouse.click(x - 80, y - 30);
  await page.mouse.move(x + 80, y + 30);
  await expect(canvas.locator('[data-cad-preview="line"] polyline').first()).toBeVisible();
  await expect(canvas.locator('[data-cad-preview="line"] clipPath')).toHaveCount(0);
  const preview = await canvas.locator('[data-cad-preview="line"] polyline').first().getAttribute("points");
  expect(Number(preview?.split(/[ ,]/u)[0])).toBeLessThan(0);
  await page.mouse.click(x + 80, y + 30);
  await canvas.press("Enter");
  await painted(page);
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(2);
  expect((await nativeEntities(page)).at(-1)!.grips![0]![0]).toBeLessThan(frame.originX);
  await expect(workspace).toHaveAttribute("data-cad-pending", "false");
  // The infinite scene extends without moving the persisted coordinate frame.
  expect((await project(page)).cad!.mapping).toEqual(frame);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(workspace).toBeHidden();
});

test("hover capture works for every rectangle grip, a circle center and an arbitrary line connection before mouse-down", async ({
  workbench,
}) => {
  const { page, workspace, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await page.mouse.click(x - 160, y - 80);
  await page.mouse.click(x - 30, y + 60);
  await expect
    .poll(async () =>
      (await nativeEntities(page)).some((entity) => (entity.grips?.length ?? 0) >= 8),
    )
    .toBe(true);
  const rect = await page.evaluate(() =>
    (window as unknown as { nativeCadScene: CadScene }).nativeCadScene.entities.find(
      (entity) => (entity.grips?.length ?? 0) >= 8,
    ),
  );
  if (!rect?.grips) throw new Error("Native rectangle grips missing");
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  for (const [index, grip] of rect.grips.entries()) {
    const target = await screenPoint(page, grip);
    await page.mouse.move(target.x + 2, target.y + 2);
    await expect(canvas.locator(".cad-cursor.is-snapped path")).toHaveCount(1);
    await expect(canvas.locator(".cad-cursor rect")).toHaveCount(0);
    await expect(canvas.locator(".cad-cursor")).toHaveAttribute(
      "data-cad-snap",
      index % 2 ? "midpoint" : "endpoint",
    );
    await expect(canvas.locator('[data-cad-preview="line"] polyline')).toHaveCount(0);
    const center = await canvas.locator(".cad-cursor").evaluate((element) => {
      const marker = element as SVGGraphicsElement,
        b = marker.getBBox();
      const p = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(
        marker.getScreenCTM()!,
      );
      return { x: p.x, y: p.y };
    });
    expect(Math.hypot(center.x - target.x, center.y - target.y)).toBeLessThan(0.1);
  }
  const start = rect.grips[0]!,
    edgeEnd = rect.grips[2]!;
  const arbitrary: [number, number] = [
    start[0] + (edgeEnd[0] - start[0]) * 0.3,
    start[1] + (edgeEnd[1] - start[1]) * 0.3,
  ];
  const a = await screenPoint(page, start),
    b = await screenPoint(page, arbitrary);
  await page.mouse.click(a.x + 2, a.y + 2);
  await page.mouse.move(b.x, b.y - 2);
  await expect(canvas.locator(".cad-cursor.is-snapped path")).toHaveCount(1);
  await expect(canvas.locator(".cad-cursor")).toHaveAttribute("data-cad-snap", "nearest");
  await page.mouse.click(b.x, b.y - 2);
  await canvas.press("Enter");
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { nativeCadScene: CadScene }).nativeCadScene.entities.some(
            (entity) => entity.type === "Line",
          ),
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await painted(page);
  const line = await page.evaluate(() =>
    (window as unknown as { nativeCadScene: CadScene }).nativeCadScene.entities.find(
      (entity) => entity.type === "Line",
    ),
  );
  expect(line?.grips?.[0]).toEqual(start);
  const end = line?.grips?.at(-1);
  expect(end?.[0]).toBeCloseTo(arbitrary[0], 6);
  expect(end?.[1]).toBeCloseTo(arbitrary[1], 6);
  await panel.getByRole("button", { name: "圆", exact: true }).click();
  await page.mouse.click(x + 120, y);
  await page.mouse.click(x + 170, y);
  await expect
    .poll(async () => (await nativeEntities(page)).some((entity) => entity.type === "Circle"))
    .toBe(true);
  const circle = await page.evaluate(() =>
    (window as unknown as { nativeCadScene: CadScene }).nativeCadScene.entities.find(
      (entity) => entity.type === "Circle",
    ),
  );
  if (!circle?.grips?.[0]) throw new Error("Native circle center missing");
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  const center = await screenPoint(page, circle.grips[0]);
  await page.mouse.move(center.x + 2, center.y + 2);
  await expect(canvas.locator(".cad-cursor.is-snapped path")).toHaveCount(1);
  await expect(canvas.locator(".cad-cursor")).toHaveAttribute("data-cad-snap", "center");
  await expect(canvas.locator('[data-cad-preview="line"] polyline')).toHaveCount(0);
  await canvas.press("Escape");
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(workspace).toBeHidden();
});

test("selected CAD grips snap on hover and stretch the whole outline during drag", async ({
  workbench,
}) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await page.mouse.click(x - 140, y - 70);
  await page.mouse.click(x - 20, y + 50);
  await expect
    .poll(async () =>
      (await nativeEntities(page)).some((entity) => (entity.grips?.length ?? 0) >= 8),
    )
    .toBe(true);
  await page.mouse.click(x - 80, y - 70);
  await expect(page.getByText("已选择 1 个对象。", { exact: true })).toBeVisible();
  const entity = (await nativeEntities(page)).find((item) => item.grips?.length === 8);
  if (!entity?.grips) throw new Error("Selected rectangle grips missing");
  const start = await screenPoint(page, entity.grips[0]!);
  await page.mouse.move(start.x + 2, start.y + 2);
  await expect(canvas.locator(".cad-cursor.is-snapped")).toHaveAttribute(
    "data-cad-snap",
    "endpoint",
  );
  await page.mouse.down();
  // Move away from the existing edge: object-nearest capture correctly wins
  // over the horizontal guide while the pointer is on that edge.
  await page.mouse.move(start.x - 40, start.y + 4, { steps: 3 });
  await expect(
    canvas.locator('[data-cad-preview="select"] .cad-cursor.is-snapped'),
  ).toHaveAttribute("data-cad-snap", "polar");
  await expect(canvas.locator('[data-cad-preview="select"] .cad-tracking-guide')).toHaveCount(1);
  await page.mouse.move(start.x + 40, start.y - 25, { steps: 5 });
  const stretched = canvas.locator('[data-cad-preview="select"] .cad-grip-shape polyline');
  await expect(stretched).toHaveCount(1);
  expect((await stretched.getAttribute("points"))?.trim().split(/\s+/u).length).toBeGreaterThan(3);
  await page.mouse.up();
  await expect(page.locator("[data-cad-detail-live-scene]")).toBeVisible();
  await expect(page.locator('.drawing-viewport[data-cad-detail-live="base"]')).toBeVisible();
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  expect(
    await canvas.evaluate(
      (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
      { x: x + 70, y: y - 50 },
    ),
  ).toBe(true);
  expect(
    await canvas.evaluate(
      (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
      { x: x + 120, y: y + 10 },
    ),
  ).toBe(true);
  await page.mouse.click(x + 70, y - 50);
  await page.mouse.click(x + 120, y + 10);
  await canvas.press("Enter");
  await expect
    .poll(async () => {
      const next = (await nativeEntities(page)).find((item) => item.handle === entity.handle);
      return next?.grips?.[0]?.[0];
    })
    .not.toBe(entity.grips[0]![0]);
  await expect.poll(async () => (await nativeEntities(page)).length).toBeGreaterThan(1);
});

test("real line intersections use the intersection marker before accepting the first point", async ({
  workbench,
}) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  for (const [start, end] of [
    [
      [x - 80, y],
      [x + 80, y],
    ],
    [
      [x - 20, y - 70],
      [x - 20, y + 70],
    ],
  ] as const) {
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await page.mouse.click(...start);
    await page.mouse.click(...end);
    await canvas.press("Enter");
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
  }
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await page.mouse.move(x - 19, y + 1);
  await expect(canvas.locator(".cad-cursor")).toHaveAttribute("data-cad-snap", "intersection");
  await expect(canvas.locator('[data-cad-preview="line"] polyline')).toHaveCount(0);
  await page.mouse.click(x - 19, y + 1);
  await page.mouse.move(x + 120, y + 90);
  await expect(canvas.locator('[data-cad-preview="line"] polyline')).toHaveCount(1);
  const start = await canvas.locator('[data-cad-preview="line"] polyline').evaluate((element) => {
    const line = element as SVGPolylineElement;
    const p = line.points.getItem(0).matrixTransform(line.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  expect(Math.hypot(start.x - (x - 20), start.y - y)).toBeLessThan(0.2);
  await canvas.press("Escape");
});

test("first point tracking and polar intersections commit the exact visible alignment", async ({ workbench }) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await page.mouse.click(x - 160, y - 80);
  await page.mouse.click(x - 30, y + 60);
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(1);
  await painted(page);
  const grips = (await nativeEntities(page))[0]!.grips!;
  const a = grips[0]!, b = grips[4]!;
  const firstReference = await screenPoint(page, a);
  const secondReference = await screenPoint(page, b);
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await page.mouse.move(firstReference.x, firstReference.y);
  await expect(canvas.locator(".cad-tracking-reference")).toHaveCount(1);
  const start = { x: firstReference.x + 230, y: firstReference.y };
  await page.mouse.move(start.x, start.y + 2);
  await expect(canvas.locator(".cad-cursor")).toHaveAttribute("data-cad-snap", /tracking|extension/);
  await page.mouse.click(start.x, start.y + 2);
  await page.mouse.move(secondReference.x, secondReference.y);
  await expect(canvas.locator(".cad-tracking-reference")).toHaveCount(2);
  await page.mouse.move(start.x + 2, secondReference.y + 2);
  await expect(canvas.locator(".cad-tracking-guide")).toHaveCount(2);
  await page.mouse.click(start.x + 2, secondReference.y + 2);
  await canvas.press("Enter");
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(2);
  const line = (await nativeEntities(page)).find(entity => entity.type.toLowerCase() === "line")!;
  expect(line.grips![0]![1]).toBeCloseTo(a[1], 7);
  expect(line.grips!.at(-1)![1]).toBeCloseTo(b[1], 7);
  expect(line.grips!.at(-1)![0]).toBeCloseTo(line.grips![0]![0], 7);
});

test("stationary acquisition, double-reference tracking, navigation and cancel remain temporary", async ({
  workbench,
}) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  for (const [start, end] of [
    [
      [x - 140, y + 70],
      [x - 70, y + 110],
    ],
    [
      [x + 40, y - 70],
      [x + 110, y - 30],
    ],
  ] as const) {
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await page.mouse.click(...start);
    await page.mouse.click(...end);
    await canvas.press("Enter");
    await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  }
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(2);
  await painted(page);
  const entities = await nativeEntities(page),
    a = entities[0]!.grips![0]!,
    b = entities[1]!.grips![0]!;
  const before = await nativeEntities(page);
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  for (const ref of [a, b]) {
    const p = await screenPoint(page, ref);
    await page.mouse.move(p.x, p.y);
    await expect(canvas.locator(".cad-tracking-reference")).toHaveCount(ref === a ? 1 : 2);
  }
  const cross = await screenPoint(page, [a[0], b[1]]);
  await page.mouse.move(cross.x + 2, cross.y + 2);
  await expect(canvas.locator(".cad-cursor")).toHaveAttribute("data-cad-snap", "tracking");
  await expect(canvas.locator(".cad-tracking-guide")).toHaveCount(2);
  // A previous edit may still finish saving. Hover must leave the live native
  // geometry unchanged, regardless of that background checkpoint's asset ID.
  expect(await nativeEntities(page)).toEqual(before);
  expect(await nativeEntities(page)).toHaveLength(2);
  // Navigation hides stale pointer-space overlays; acquired world references are retained.
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(cross.x + 20, cross.y + 20);
  await expect(canvas.locator(".cad-tracking-guide")).toHaveCount(0);
  await page.mouse.up({ button: "middle" });
  const newCross = await screenPoint(page, [a[0], b[1]]);
  await page.mouse.move(newCross.x + 2, newCross.y + 2);
  await expect(canvas.locator(".cad-tracking-reference")).toHaveCount(2);
  await page.mouse.click(newCross.x + 2, newCross.y + 2);
  await page.mouse.click(newCross.x + 60, newCross.y - 60);
  await canvas.press("Enter");
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(3);
  const line = (await nativeEntities(page)).at(-1)!;
  expect(line.grips![0]![0]).toBeCloseTo(a[0], 7);
  expect(line.grips![0]![1]).toBeCloseTo(b[1], 7);
  await expect(canvas.locator(".cad-tracking-reference")).toHaveCount(0);
  await canvas.press("Escape");
  await expect(canvas.locator(".cad-gesture-preview")).toHaveCount(0);
});

test("deferred first-point tangent previews and commits exact geometry, Tab chooses the other tangent", async ({
  workbench,
}) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await panel.getByRole("button", { name: "圆", exact: true }).click();
  await page.mouse.click(x - 80, y);
  await page.mouse.click(x - 20, y);
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(1);
  await painted(page);
  const circle = (await nativeEntities(page))[0]!,
    c = circle.grips![0]!,
    r = circle.radius!;
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  const first = await screenPoint(page, [c[0] + r * 0.6, c[1] + r * 0.8]);
  await page.mouse.move(first.x, first.y);
  await expect(canvas.locator(".cad-cursor")).toHaveAttribute("data-cad-snap", "tangent-pending");
  await expect(canvas.locator(".cad-cursor")).toHaveClass(/is-deferred/u);
  await page.mouse.click(first.x, first.y);
  const endpoint: [number, number] = [c[0] + r * 2.6, c[1]];
  const end = await screenPoint(page, endpoint);
  await page.mouse.move(end.x, end.y);
  await expect(canvas.locator(".cad-cursor")).toHaveAttribute("data-cad-snap", "tangent");
  const preview = canvas.locator('[data-cad-preview="line"] polyline');
  const original = await preview.getAttribute("points");
  await canvas.press("Tab");
  await expect(preview).not.toHaveAttribute("points", original!);
  const chosen = await preview.evaluate((el) => {
    const line = el as SVGPolylineElement;
    return [line.points.getItem(0).x, line.points.getItem(0).y];
  });
  await page.mouse.click(end.x, end.y);
  await canvas.press("Enter");
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(2);
  await painted(page);
  const line = (await nativeEntities(page)).find((e) => e.type === "Line")!;
  const start = line.grips![0]!,
    finish = line.grips!.at(-1)!;
  expect(Math.hypot(start[0] - c[0], start[1] - c[1])).toBeCloseTo(r, 6);
  expect(
    (start[0] - c[0]) * (finish[0] - start[0]) + (start[1] - c[1]) * (finish[1] - start[1]),
  ).toBeCloseTo(0, 6);
  expect(finish[0]).toBeCloseTo(endpoint[0], 6);
  expect(finish[1]).toBeCloseTo(endpoint[1], 6);
  const saved = await project(page),
    mapping = saved.cad!.mapping;
  // SVGPointList stores float32, while native CAD coordinates remain float64.
  expect((start[0] - mapping.originX) * mapping.scale).toBeCloseTo(chosen[0]!, 4);
  expect((mapping.originY - start[1]) * mapping.scale).toBeCloseTo(chosen[1]!, 4);
  await expect(canvas.locator(".cad-tracking-guide")).toHaveCount(0);
});

test("a new circle contacting an existing circle displays tangency and saves touching geometry", async ({
  workbench,
}) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await panel.getByRole("button", { name: "圆", exact: true }).click();
  await page.mouse.click(x - 80, y);
  await page.mouse.click(x - 20, y);
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(1);
  await painted(page);
  const original = (await nativeEntities(page))[0]!,
    center = original.grips![0]!,
    radius = original.radius!;
  const delta = [radius * 1.7, radius * 1.5] as const,
    distance = Math.hypot(...delta);
  const anchor = await screenPoint(page, [center[0] + delta[0], center[1] + delta[1]]);
  const contact = await screenPoint(page, [
    center[0] + (radius * delta[0]) / distance,
    center[1] + (radius * delta[1]) / distance,
  ]);
  await panel.getByRole("button", { name: "圆", exact: true }).click();
  await page.mouse.click(anchor.x, anchor.y);
  await page.mouse.move(contact.x + 2, contact.y + 2);
  // Nearest and tangent can be eligible together. Use the supported Tab cycle,
  // not the removed one-shot capture dropdown, to choose the tangent constraint.
  for (let i = 0; i < 8 && await canvas.locator(".cad-cursor").getAttribute("data-cad-snap") !== "tangent"; i++) {
    await canvas.press("Tab");
  }
  await expect(canvas.locator(".cad-snap-label")).toHaveText("相切");
  await expect(canvas.locator(".cad-cursor")).toHaveAttribute("data-cad-snap", "tangent");
  await page.mouse.click(contact.x + 2, contact.y + 2);
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(2);
  const added = (await nativeEntities(page))[1]!,
    addedCenter = added.grips![0]!;
  expect(Math.hypot(addedCenter[0] - center[0], addedCenter[1] - center[1])).toBeCloseTo(
    radius + added.radius!,
    6,
  );
  await painted(page);
});

test("three-point arc contact with a line previews and commits a genuinely tangent arc", async ({
  workbench,
}) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await page.mouse.click(x - 120, y + 70);
  await page.mouse.click(x + 120, y + 70);
  await canvas.press("Enter");
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(1);
  await painted(page);
  const line = (await nativeEntities(page))[0]!,
    first = line.grips![0]!,
    last = line.grips!.at(-1)!,
    h = Math.abs(last[0] - first[0]) / 10,
    contact = [first[0] + (last[0] - first[0]) * 0.63, first[1]] as [number, number];
  await panel.getByRole("button", { name: "圆弧", exact: true }).click();
  for (const point of [
    [contact[0] - h, contact[1] + h],
    [contact[0] + h, contact[1] + h],
  ] as [number, number][]) {
    const screen = await screenPoint(page, point);
    await page.mouse.click(screen.x, screen.y);
  }
  const screen = await screenPoint(page, contact);
  await page.mouse.move(screen.x + 1, screen.y + 1);
  await expect(canvas.locator(".cad-snap-label")).toHaveText("相切");
  await page.mouse.click(screen.x + 1, screen.y + 1);
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(2);
  const arc = (await nativeEntities(page)).find((e) => e.type === "Arc")!,
    center = arc.geometry!.center!,
    radius = arc.geometry!.radius!;
  // Pointer coordinates traverse SVG float32 values; contact geometry stays float64.
  expect(center.x).toBeCloseTo(contact[0], 4);
  expect(Math.abs(center.y - contact[1])).toBeCloseTo(radius, 7);
  await painted(page);
});

test("a three-point arc snaps tangent to an existing finite arc, then a line can depart along its tangent", async ({
  workbench,
}) => {
  const { page, panel, canvas, box } = await setup(workbench);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const tool = panel.getByRole("button", { name: "圆弧", exact: true });
  await tool.click();
  await page.mouse.click(x + 90, y + 10);
  await page.mouse.click(x + 30, y + 70);
  await page.mouse.click(x + 90, y + 130);
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(1);
  await painted(page);
  const target = (await nativeEntities(page))[0]!,
    origin = target.geometry!.center!,
    r = target.geometry!.radius!;
  const contact = [origin.x - r, origin.y] as [number, number];
  await tool.click();
  for (const point of [
    [origin.x - 3 * r, origin.y],
    [origin.x - 2 * r, origin.y - r],
  ] as [number, number][]) {
    const screen = await screenPoint(page, point);
    await page.mouse.click(screen.x, screen.y);
  }
  const screen = await screenPoint(page, contact);
  await page.mouse.move(screen.x + 1, screen.y + 1);
  await expect(canvas.locator(".cad-snap-label")).toHaveText("相切");
  await page.mouse.click(screen.x + 1, screen.y + 1);
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(2);
  await painted(page);
  const added = (await nativeEntities(page))[1]!,
    c = added.geometry!.center!,
    radius = added.geometry!.radius!;
  expect(Math.hypot(c.x - origin.x, c.y - origin.y)).toBeCloseTo(radius + r, 7);
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await page.mouse.click(screen.x, screen.y);
  const endpoint = await screenPoint(page, [contact[0], contact[1] + r * 0.6]);
  await page.mouse.move(endpoint.x, endpoint.y);
  await expect(canvas.locator(".cad-snap-label")).toHaveText("相切");
  await page.mouse.click(endpoint.x, endpoint.y);
  await canvas.press("Enter");
  await expect.poll(async () => (await nativeEntities(page)).length).toBe(3);
  const line = (await nativeEntities(page)).find((e) => e.type === "Line")!,
    a = line.grips![0]!,
    b = line.grips!.at(-1)!;
  expect((a[0] - origin.x) * (b[0] - a[0]) + (a[1] - origin.y) * (b[1] - a[1])).toBeCloseTo(0, 6);
  await painted(page);
});
