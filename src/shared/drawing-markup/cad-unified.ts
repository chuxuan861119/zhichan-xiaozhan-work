import { type CadExportScene, compileCadExport, executeCadExportCommand } from "./cad-export.js";
import { type CadPatentObject, cadObjectGroup } from "./cad-objects.js";
import { cadToPage, pageToCad } from "./cad-state.js";
import type { DrawingProject } from "./model.js";
import { drawingEditEqual } from "./performance.js";

export type UnifiedScene = Omit<CadExportScene, "primitives"> & {
  groups?: { name: string; members: string[]; selectable: boolean }[];
  primitives: (CadExportScene["primitives"][number] & { handle: string })[];
};
export type CadKernel = {
  load_dxf(bytes: Uint8Array): void;
  execute(command: string, params: string): string;
  scene(): string;
  export_dxf(): Uint8Array;
};
const roles = ["label", "body", "frame", "source"] as const;
const getScene = (kernel: CadKernel) => JSON.parse(kernel.scene()) as UnifiedScene;
const getIndex = (kernel: CadKernel) =>
  JSON.parse(kernel.execute("bridge.object_index", "{}")) as UnifiedScene;
const run = (kernel: CadKernel, command: string, params: object) =>
  JSON.parse(kernel.execute(command, JSON.stringify(params))) as Record<string, unknown>;
const isProxy = (name: string) => /^PW_LABEL_|^PW_DETAIL_.*_(?:FRAME|SOURCE)$/u.test(name);

export class CadDetailBoundsError extends Error {}

/** Validate only supplied primitives: edit deltas before acceptance, or the complete saved scene. */
export function assertCadDetailBounds(
  project: DrawingProject,
  scene: Pick<UnifiedScene, "primitives">,
  objects = project.cad?.objects ?? [],
) {
  if (!project.cad) return;
  for (const detail of project.detailViews ?? []) {
    const body = new Set(objects.find((o) => o.id === detail.id)?.body);
    const limit = detail.radius * detail.ratio;
    if (
      scene.primitives.some(
        (p) =>
          body.has(p.handle) &&
          p.points.some(([x, y]) => {
            const page = cadToPage({ x, y }, project.cad!.mapping);
            return (
              Math.hypot(page.x - detail.center.x, page.y - detail.center.y) >
              limit + Math.max(1e-4, limit * 1e-6)
            );
          }),
      )
    )
      throw new CadDetailBoundsError(
        `详图 ${detail.label} 的图形超出圆形范围，请在圆内调整；原工作稿未改变。`,
      );
  }
}

/** Editable bodies already contain their geometry; frozen sources are needed only to create/rebuild them. */
export function cadSynchronizationSourceIds(project: DrawingProject): string[] {
  if (!project.cad) throw new Error("图纸没有 CAD 工作稿。");
  const materialized = new Set(
    project.cad.unified
      ? project.cad.objects?.filter((o) => o.body !== undefined).map((o) => o.id)
      : [],
  );
  return [
    ...new Set([
      project.cad.assetId,
      ...(project.detailViews ?? []).flatMap((d) =>
        !materialized.has(d.id) && d.cadSource ? [d.cadSource.assetId] : [],
      ),
    ]),
  ];
}

/** One isolated transaction builds the native checkpoint and its semantic bindings together. */
export function synchronizeCad(
  kernel: CadKernel,
  blank: Uint8Array,
  project: DrawingProject,
  sources: ReadonlyMap<string, Uint8Array>,
  previous?: DrawingProject,
  options: { loaded?: boolean; nativeEdit?: boolean; deferExport?: boolean } = {},
) {
  if (!project.cad) throw new Error("图纸没有 CAD 工作稿。");
  const scenes = new Map<string, CadExportScene>();
  const required = cadSynchronizationSourceIds(project);
  const materialized = new Set(
    project.cad.unified
      ? project.cad.objects?.filter((o) => o.body !== undefined).map((o) => o.id)
      : [],
  );
  const currentIsFrozen = project.detailViews?.some(
    (d) => d.cadSource?.assetId === project.cad!.assetId && !materialized.has(d.id),
  );
  let currentGeometryLoaded = false;
  // Leave the live checkpoint loaded for the preserved-frame plan. Do not
  // parse it twice or tessellate unrelated frozen DWGs during a simple resize.
  for (const id of [...required.filter((id) => id !== project.cad!.assetId), project.cad.assetId]) {
    const bytes = sources.get(id);
    if (!bytes) throw new Error("CAD 工作稿或局部放大来源未加载。");
    if (!(options.loaded && id === project.cad.assetId)) kernel.load_dxf(bytes);
    const full = id !== project.cad.assetId || currentIsFrozen;
    const scene = full ? getScene(kernel) : getIndex(kernel);
    if (id === project.cad.assetId) currentGeometryLoaded = Boolean(full);
    // Frozen details must not copy patent text/frames into their editable geometry.
    const excluded = new Set(
      scene.groups?.filter((g) => isProxy(g.name)).flatMap((g) => g.members),
    );
    scenes.set(id, {
      ...scene,
      primitives: scene.primitives.filter((p) => !excluded.has(p.handle)),
    });
  }
  const exportProject = project.cad.overlayAssetId
    ? { ...project, baseFragments: undefined }
    : project;
  let plan = compileCadExport(exportProject, scenes);
  // Cropping/reframing really consumes source geometry. Preserving the live
  // model (including ordinary detail resizing) needs only its object index.
  if (!plan.sourceCadAssetId && !currentGeometryLoaded) {
    const scene = getScene(kernel);
    const excluded = new Set(
      scene.groups?.filter((g) => isProxy(g.name)).flatMap((g) => g.members),
    );
    scenes.set(project.cad.assetId, {
      ...scene,
      primitives: scene.primitives.filter((p) => !excluded.has(p.handle)),
    });
    plan = compileCadExport(exportProject, scenes);
  }
  const drawingDefaults = run(kernel, "bridge.drawing_defaults", {});
  if (!plan.sourceCadAssetId) kernel.load_dxf(blank);
  if (!options.loaded || !project.cad.unified) run(kernel, "bridge.flatten_layers", {});
  let scene = getIndex(kernel);
  const present = new Set(scene.entities.map(e => e.handle));
  const retainedProxies = new Set<string>();
  const unchanged = new Set<string>();
  if (plan.sourceCadAssetId && previous?.cad?.unified && previous.cad.assetId === project.cad.assetId &&
      drawingEditEqual(previous.cad.mapping, project.cad.mapping)) {
    for (const object of project.cad.objects ?? []) {
      const old = previous.cad.objects?.find(o => o.kind === object.kind && o.id === object.id);
      const before = object.kind === "label" ? previous.annotations.find(a => a.id === object.id)
        : previous.detailViews?.find(d => d.id === object.id);
      const after = object.kind === "label" ? project.annotations.find(a => a.id === object.id)
        : project.detailViews?.find(d => d.id === object.id);
      const handles = [...(object.label ?? []), ...(object.frame ?? []), ...(object.source ?? [])];
      if (old && before && after && handles.length && handles.every(h => present.has(h)) &&
          drawingEditEqual(old, object) && drawingEditEqual(before, after)) {
        unchanged.add(`${object.kind}:${object.id}`);
        for (const handle of handles) retainedProxies.add(handle);
      }
    }
  }
  const validDetails = new Set(project.detailViews?.map((d) => d.id));
  const objects: CadPatentObject[] = (project.cad.objects ?? [])
    .filter((o) =>
      o.kind === "detail" ? validDetails.has(o.id) : project.annotations.some((a) => a.id === o.id),
    )
    .map((o) => ({
      id: o.id,
      kind: o.kind,
      ...(o.appearance ? { appearance: structuredClone(o.appearance) } : {}),
      ...(unchanged.has(`${o.kind}:${o.id}`) ? {
        ...(o.label ? { label: [...o.label] } : {}),
        ...(o.frame ? { frame: [...o.frame] } : {}),
        ...(o.source ? { source: [...o.source] } : {}),
      } : {}),
      ...(o.body !== undefined ? { body: plan.sourceCadAssetId ? [...o.body] : [] } : {}),
    }));
  // Clear changed/obsolete proxies, including interrupted legacy conversions;
  // unchanged proxies keep their handles and avoid repeated text tessellation.
  const obsolete = (project.cad.objects ?? [])
    .filter((o) => o.kind === "detail" && !validDetails.has(o.id))
    .flatMap((o) => o.body ?? []);
  const replacedBodies =
    scene.groups
      ?.filter(
        (g) =>
          g.name.endsWith("_BODY") &&
          g.name.startsWith("PW_DETAIL_") &&
          !objects.some(
            (o) =>
              o.body !== undefined &&
              cadObjectGroup({ id: o.id, kind: o.kind, role: "body" }) === g.name,
          ),
      )
      .flatMap((g) => g.members) ?? [];
  const proxies = [
    ...(scene.groups?.filter((g) => isProxy(g.name)).flatMap((g) => g.members) ?? []),
    ...(project.cad.objects ?? []).flatMap((o) => [
      ...(o.label ?? []),
      ...(o.frame ?? []),
      ...(o.source ?? []),
    ]),
  ];
  const erase = [...new Set([...obsolete, ...proxies, ...replacedBodies])].filter((h) =>
    present.has(h) && !retainedProxies.has(h),
  );
  if (erase.length) run(kernel, "erase", { handles: erase });
  // Detail resizing/moving acts on the materialized body, retaining its independent edits.
  if (
    previous?.cad?.unified &&
    previous.cad.assetId === project.cad.assetId &&
    !options.nativeEdit &&
    plan.sourceCadAssetId
  )
    for (const detail of project.detailViews ?? []) {
      const before = previous.detailViews?.find((d) => d.id === detail.id);
      const body = objects.find((o) => o.id === detail.id)?.body;
      if (!before || !body?.length) continue;
      const a = pageToCad(before.center, project.cad.mapping),
        b = pageToCad(detail.center, project.cad.mapping);
      const factor = (detail.radius * detail.ratio) / (before.radius * before.ratio);
      if (factor !== 1) run(kernel, "scale", { handles: body, base: [a.x, a.y], factor });
      if (a.x !== b.x || a.y !== b.y)
        run(kernel, "move", { handles: body, delta: [b.x - a.x, b.y - a.y] });
    }
  for (const command of plan.commands) {
    if (command.owner && command.owner.role !== "body" &&
        unchanged.has(`${command.owner.kind}:${command.owner.id}`)) continue;
    const result = executeCadExportCommand(kernel, command);
    if (!command.owner) continue;
    const created = Array.isArray(result.handles)
      ? result.handles.filter((h): h is string => typeof h === "string")
      : typeof result.handle === "string"
        ? [result.handle]
        : [];
    if (!created.length) throw new Error("CAD 对象未能建立完整绑定，原工作稿未改变。");
    let object = objects.find((o) => o.id === command.owner!.id && o.kind === command.owner!.kind);
    if (!object) {
      object = { id: command.owner.id, kind: command.owner.kind };
      objects.push(object);
    }
    object[command.owner.role] = [...(object[command.owner.role] ?? []), ...created];
  }
  scene = getIndex(kernel);
  for (const detail of project.detailViews ?? []) {
    const object = objects.find((o) => o.id === detail.id);
    if (object && object.body === undefined) object.body = [];
  }
  const existing = new Set(scene.entities.map((e) => e.handle));
  for (const object of objects)
    for (const role of roles) {
      const handles = object[role]?.filter((h) => existing.has(h));
      if (!handles) continue;
      object[role] = handles;
      const name = cadObjectGroup({ id: object.id, kind: object.kind, role });
      const existingGroup = scene.groups?.find((g) => g.name === name);
      const members = new Set(handles);
      if (
        existingGroup &&
        existingGroup.selectable === (role !== "body") &&
        existingGroup.members.length === handles.length &&
        existingGroup.members.every((h) => members.has(h))
      )
        continue;
      if (existingGroup) run(kernel, "ungroup", { name });
      if (handles.length) run(kernel, "group", { name, handles, selectable: role !== "body" });
    }
  // One complete, final scene validates native geometry and publishes current
  // bindings together. Intermediate membership queries never tessellate it.
  run(kernel, "bridge.drawing_defaults", { restore: drawingDefaults });
  scene = getScene(kernel);
  if (restoreDetailHatchOrder(kernel, scene, objects)) scene = getScene(kernel);
  assertCadDetailBounds(project, scene, objects);
  return { bytes: options.deferExport ? new Uint8Array() : kernel.export_dxf(), objects, scene, warnings: plan.warnings };
}

/** The engine sends new hatches to the back of the entire drawing. A detail's
 * opaque backing must remain below its own fills, including native DXF export. */
function restoreDetailHatchOrder(
  kernel: CadKernel,
  scene: UnifiedScene,
  objects: CadPatentObject[],
) {
  const entities = scene.entities as {
    handle: string;
    type?: string;
    geometry?: { loops?: { sources?: number[] }[] };
  }[];
  let changed = false;
  const masks = new Set(scene.primitives.filter((p) => p.kind === "mask").map((p) => p.handle));
  const order = new Map(entities.map((e, i) => [e.handle, i]));
  for (const object of objects.filter((o) => o.kind === "detail" && o.body !== undefined)) {
    const body = new Set(object.body);
    // Recover only unambiguously associated legacy fills; do not adopt unrelated
    // imported hatches merely because they overlap the detail on screen.
    const recovered = entities
      .filter((e) => {
        if (e.type !== "Hatch" || objects.some((o) => o.body?.includes(e.handle))) return false;
        const sources = e.geometry?.loops?.flatMap((l) => l.sources ?? []) ?? [];
        return (
          sources.length > 0 &&
          sources.every((h) => Number.isSafeInteger(h) && body.has(h.toString(16).toUpperCase()))
        );
      })
      .map((e) => e.handle);
    if (recovered.length) {
      object.body = [...object.body!, ...recovered];
      for (const h of recovered) body.add(h);
      const name = cadObjectGroup({ id: object.id, kind: object.kind, role: "body" });
      run(kernel, "ungroup", { name });
      run(kernel, "group", { name, handles: object.body, selectable: false });
      changed = true;
    }
    const backing = [...body].filter((h) => masks.has(h));
    const lastMask = Math.max(-1, ...backing.map((h) => order.get(h) ?? -1));
    const covered = entities
      .filter(
        (e) =>
          e.type === "Hatch" && body.has(e.handle) && (order.get(e.handle) ?? Infinity) < lastMask,
      )
      .map((e) => e.handle);
    if (covered.length) {
      run(kernel, "draworder", { handles: covered, order: "above", reference: backing });
      changed = true;
    }
  }
  return changed;
}
