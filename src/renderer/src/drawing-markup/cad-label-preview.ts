import type { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import type { DrawingProject } from "../../../shared/drawing-markup/model";

/** An isolated, label-free CAD raster source for automatic output lettering. */
export function cadLabelFreeSvg(
  kernel: CadcraftSession,
  project: DrawingProject,
  bytes: Uint8Array,
  handles: readonly string[],
  selectedHandles?: readonly string[],
): string {
  if (!project.cad) throw new Error("CAD 工作稿不存在。");
  kernel.load_dxf(bytes);
  const original = JSON.parse(kernel.scene()) as {
    entities: { handle: string }[];
    groups?: { name: string; members: string[] }[];
  };
  const present = new Set(
    original.entities.map(
      (entity) => entity.handle,
    ),
  );
  const erase = handles.filter((handle) => present.has(handle));
  if (erase.length !== handles.length)
    throw new Error("CAD 标号绑定已失效，请重新保存图纸后取图。");
  if (selectedHandles?.some((handle) => !present.has(handle)))
    throw new Error("选中的 CAD 图形已变化，请重新选择后取图。");
  const selected = selectedHandles ? new Set(selectedHandles) : null;
  const labelHandles = new Set(handles);
  const removed = selected
    ? [...present].filter((handle) => !selected.has(handle) || labelHandles.has(handle))
    : erase;
  if (removed.length) kernel.execute("erase", JSON.stringify({ handles: removed }));
  if (selected) {
    // Legacy patent SVGs hide semantic proxies for the image overlay to repaint.
    // Selected native CAD output has no such overlay: retain exactly the chosen
    // frame/title or source-marker entities, without pulling in their siblings.
    for (const group of original.groups ?? [])
      if (/^PW_DETAIL_.+_(?:FRAME|SOURCE)$/u.test(group.name) && group.members.some(h => selected.has(h)))
        kernel.execute("ungroup", JSON.stringify({ name: group.name }));
  }
  const scene = JSON.parse(kernel.scene()) as {
    svgFrame: { origin: [number, number]; width: number; height: number };
  };
  const native = kernel.export_patent_svg();
  if (!/^<svg\b[^>]*\bviewBox="[^"]+"/u.test(native)) throw new Error("CAD 图形预览生成失败。");
  const { mapping } = project.cad;
  const frame = scene.svgFrame;
  const x = mapping.originX - frame.origin[0];
  const y = frame.origin[1] - mapping.originY;
  const width = project.width / mapping.scale;
  const height = project.height / mapping.scale;
  const pixelScale = Math.min(1, 2000 / Math.max(project.width, project.height));
  return native.replace(/^<svg\b[^>]*>/u, (opening) =>
    opening
      .replace(/\bviewBox="[^"]+"/u, `viewBox="${x} ${y} ${width} ${height}"`)
      .replace(/\bwidth="[^"]+"/u, `width="${Math.max(1, Math.ceil(project.width * pixelScale))}"`)
      .replace(
        /\bheight="[^"]+"/u,
        `height="${Math.max(1, Math.ceil(project.height * pixelScale))}"`,
      ),
  );
}
