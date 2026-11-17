import { baseFragments, fragmentWorldPoint } from "./base-fragments.js";
import type { CadObjectOwner, CadAppearancePatch } from "./cad-objects.js";
import { type CadMapping, cadToPage, pageToCad } from "./cad-state.js";
import { detailLeader, detailRatioText } from "./detail-view.js";
import { pointInside } from "./geometry.js";
import { leaderPoints } from "./label-layout.js";
import { cadLabelLineweight } from "./cad-label-style.js";
import type { DrawingBaseFragment, DrawingPoint, DrawingProject } from "./model.js";
export type CadExportScene = {
  entities: { handle: string }[];
  primitives: {
    handle?: string;
    kind: string;
    points: [number, number][];
    color: [number, number, number];
    aci7: boolean;
    lineweight: number;
  }[];
};
export type CadExportCommand = {
  command: string;
  params: Record<string, unknown>;
  owner?: CadObjectOwner;
  appearance?: CadAppearancePatch;
};
/** Apply semantic overrides to recreated handles, never to drawing defaults. */
export function executeCadExportCommand(
  kernel: { execute(c: string, p: string): string },
  command: CadExportCommand,
) {
  const result = JSON.parse(
    kernel.execute(command.command, JSON.stringify(command.params)),
  ) as Record<string, unknown>;
  if (command.appearance) {
    const handles = Array.isArray(result.handles)
      ? result.handles
      : typeof result.handle === "string"
        ? [result.handle]
        : [];
    if (handles.length)
      kernel.execute("bridge.appearance", JSON.stringify({ ...command.appearance, handles }));
  }
  return result;
}
type Point = DrawingPoint;
type Polygon = Point[];
type Primitive = {
  kind: string;
  points: [number, number][];
  color: [number, number, number];
  lineweight: number;
};
const EPS = 1e-8;
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const mix = (a: Point, b: Point, t: number) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const area = (p: Polygon) =>
  p.reduce((v, a, i) => {
    const b = p[(i + 1) % p.length]!;
    return v + a.x * b.y - b.x * a.y;
  }, 0) / 2;
const rectangle = (w: number, h: number): Polygon => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];
function clean(p: Polygon): Polygon {
  const out = p.filter((a, i) => {
    const b = p[(i + p.length - 1) % p.length]!;
    return Math.hypot(a.x - b.x, a.y - b.y) > EPS;
  });
  return Math.abs(area(out)) > EPS ? out : [];
}
function halfPlane(poly: Polygon, a: Point, b: Point, inside = true): Polygon {
  const result: Polygon = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!,
      q = poly[(i + 1) % poly.length]!,
      cp = cross(a, b, p) * (inside ? 1 : -1),
      cq = cross(a, b, q) * (inside ? 1 : -1);
    if (cp >= -EPS) result.push(p);
    if ((cp > EPS && cq < -EPS) || (cp < -EPS && cq > EPS)) result.push(mix(p, q, cp / (cp - cq)));
  }
  return clean(result);
}
function convexIntersection(subject: Polygon, clip: Polygon): Polygon {
  let result = subject;
  for (let i = 0; i < clip.length && result.length; i++)
    result = halfPlane(result, clip[i]!, clip[(i + 1) % clip.length]!);
  return result;
}
function convexDifference(subject: Polygon, clip: Polygon): Polygon[] {
  let remaining = subject;
  const result: Polygon[] = [];
  for (let i = 0; i < clip.length && remaining.length; i++) {
    const a = clip[i]!,
      b = clip[(i + 1) % clip.length]!;
    const outside = halfPlane(remaining, a, b, false);
    if (outside.length) result.push(outside);
    remaining = halfPlane(remaining, a, b);
  }
  return result;
}
/** Convex polygons remain whole; simple concave polygons are partitioned into disjoint ears. */
function polygonCells(input: Polygon): Polygon[] {
  const p = clean(input);
  if (p.length < 3) throw new Error("CAD 裁剪多边形退化，未生成不完整文件。");
  if (area(p) < 0) p.reverse();
  const convex = p.every(
    (a, i) => cross(a, p[(i + 1) % p.length]!, p[(i + 2) % p.length]!) >= -EPS,
  );
  const angle = p.reduce((sum, a, i) => {
    const b = p[(i + 1) % p.length]!,
      c = p[(i + 2) % p.length]!;
    return sum + Math.atan2(cross(a, b, c), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y));
  }, 0);
  if (convex && Math.abs(angle - 2 * Math.PI) < 1e-5) return [p];
  for (let i = 0; i < p.length; i++)
    for (let j = i + 2; j < p.length; j++) {
      if (i === 0 && j === p.length - 1) continue;
      const a = p[i]!,
        b = p[(i + 1) % p.length]!,
        c = p[j]!,
        d = p[(j + 1) % p.length]!;
      if (cross(a, b, c) * cross(a, b, d) < -EPS && cross(c, d, a) * cross(c, d, b) < -EPS)
        throw new Error("CAD 导出暂不支持自相交裁剪边界，请先拆成简单区域。");
    }
  const result: Polygon[] = [];
  while (p.length > 3) {
    let found = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length]!,
        b = p[i]!,
        c = p[(i + 1) % p.length]!;
      if (Math.abs(cross(a, b, c)) <= EPS) {
        p.splice(i, 1);
        found = true;
        break;
      }
      if (cross(a, b, c) < 0) continue;
      if (
        p.some(
          (q, j) =>
            j !== i &&
            j !== (i + 1) % p.length &&
            j !== (i + p.length - 1) % p.length &&
            pointInside(q, [a, b, c]),
        )
      )
        continue;
      result.push([a, b, c]);
      p.splice(i, 1);
      found = true;
      break;
    }
    if (!found) throw new Error("CAD 裁剪边界无法可靠分解，未生成不完整文件。");
  }
  if (p.length === 3) result.push(p);
  return result;
}
type Clip = { points: Polygon; cells: Polygon[] };
const prepare = (polygons: Polygon[]): Clip[] =>
  polygons.map((points) => ({ points, cells: polygonCells(points) }));
function cropFill(poly: Polygon, clips: Clip[], holes: Clip[]): Polygon[] {
  let cells = [poly];
  for (const clip of clips)
    cells = cells.flatMap((cell) =>
      clip.cells.map((c) => convexIntersection(cell, c)).filter((p) => p.length),
    );
  for (const hole of holes)
    for (const h of hole.cells) cells = cells.flatMap((cell) => convexDifference(cell, h));
  return cells;
}
function cropLine(a: Point, b: Point, clips: Clip[], holes: Clip[]): Polygon[] {
  const times = [0, 1],
    dx = b.x - a.x,
    dy = b.y - a.y;
  for (const { points } of [...clips, ...holes])
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!,
        q = points[(i + 1) % points.length]!,
        ex = q.x - p.x,
        ey = q.y - p.y,
        den = dx * ey - dy * ex;
      if (Math.abs(den) < EPS) continue;
      const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / den,
        u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / den;
      if (t > EPS && t < 1 - EPS && u >= -EPS && u <= 1 + EPS) times.push(t);
    }
  times.sort((a, b) => a - b);
  const result: Polygon[] = [];
  for (let i = 1; i < times.length; i++) {
    const start = times[i - 1]!,
      end = times[i]!;
    if (end - start < EPS) continue;
    const middle = mix(a, b, (start + end) / 2);
    if (
      clips.every((c) => pointInside(middle, c.points)) &&
      !holes.some((c) => pointInside(middle, c.points))
    )
      result.push([mix(a, b, start), mix(a, b, end)]);
  }
  return result;
}
const circle = (center: Point, radius: number): Polygon =>
  Array.from({ length: 256 }, (_, i) => ({
    x: center.x + Math.cos((i * 2 * Math.PI) / 256) * radius,
    y: center.y + Math.sin((i * 2 * Math.PI) / 256) * radius,
  }));
function fullFragment(fragment: DrawingBaseFragment, project: DrawingProject) {
  if (fragment.holes.length || fragment.clips.length !== 1) return false;
  const expected = rectangle(project.width, project.height),
    actual = fragment.clips[0]!;
  return (
    actual.length === 4 &&
    expected.every((p) => actual.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < EPS))
  );
}

/** Run the plan only in an isolated export session, never in the user's live CAD session. */
export function compileCadExport(
  project: DrawingProject,
  scenes: ReadonlyMap<string, CadExportScene>,
): { sourceCadAssetId: string | null; commands: CadExportCommand[]; warnings: string[] } {
  if (!project.cad) throw new Error("当前图纸没有可编辑 CAD 检查点，不能伪造 CAD 导出。");
  const mapping = project.cad.mapping,
    current = scenes.get(project.cad.assetId);
  if (!current) throw new Error("CAD 原始检查点未加载。");
  const commands: CadExportCommand[] = [],
    warnings: string[] = [];
  let batch: Primitive[] = [],
    total = 0,
    maskFramesDisabled = false;
  let owner: CadObjectOwner | undefined;
  const flush = () => {
    if (batch.length) {
      if (!maskFramesDisabled && batch.some((p) => p.kind === "mask")) {
        commands.push({ command: "setvar", params: { name: "WIPEOUTFRAME", value: 0 } });
        maskFramesDisabled = true;
      }
      commands.push({
        command: "bridge.add_primitives",
        params: { primitives: batch },
        ...(owner ? { owner } : {}),
      });
      batch = [];
    }
  };
  const own = (next: CadObjectOwner | undefined) => {
    flush();
    owner = next;
  };
  const push = (
    kind: string,
    points: Polygon,
    color: [number, number, number] = [0, 0, 0],
    lineweight = 0,
  ) => {
    if (!points.length) return;
    if (++total > 100000) throw new Error("CAD 导出图元超过 100000 个，请缩小图纸复杂度后重试。");
    batch.push({
      kind,
      points: points.map((p) => {
        const w = pageToCad(p, mapping);
        return [w.x, w.y];
      }),
      color,
      lineweight,
    });
  };
  const renderFragment = (
    fragment: DrawingBaseFragment,
    scene: CadExportScene,
    sourceMapping: CadMapping,
    sourceScale = 1,
    extraClip?: Polygon,
    after: (p: Point) => Point = (p) => p,
  ) => {
    const clips = prepare(fragment.clips),
      holes = prepare(fragment.holes);
    const finalClips = extraClip ? prepare([extraClip]) : [];
    const transform = (p: Point) => after(fragmentWorldPoint(fragment, p));
    const inheritedOwner = owner;
    const inheritBindings = scene === current && !extraClip && !!project.cad?.unified;
    const drawPolygon = (
      polygon: Polygon,
      kind: string,
      color: [number, number, number],
      lineweight: number,
    ) => {
      for (const cell of cropFill(polygon, clips, holes))
        for (const cropped of cropFill(cell.map(transform), finalClips, [])) {
          if (kind === "mask") push("mask", cropped, color, lineweight);
          else
            for (let i = 1; i + 1 < cropped.length; i++)
              push("triangles", [cropped[0]!, cropped[i]!, cropped[i + 1]!], color, lineweight);
        }
    };
    // Source SVG images have an opaque page background, but holes remain transparent.
    if (!project.cad?.overlayAssetId)
      drawPolygon(
        rectangle(project.width * sourceScale, project.height * sourceScale),
        "mask",
        [255, 255, 255],
        0,
      );
    for (const primitive of scene.primitives) {
      if (inheritBindings) {
        const object = project.cad?.objects?.find(
          (o) => primitive.handle && o.body?.includes(primitive.handle),
        );
        own(object ? { id: object.id, kind: "detail", role: "body" } : undefined);
      }
      const color: [number, number, number] = primitive.aci7 ? [0, 0, 0] : primitive.color;
      let points = primitive.points.map(([x, y]) => {
        const p = cadToPage({ x, y }, sourceMapping);
        return { x: p.x * sourceScale, y: p.y * sourceScale };
      });
      if (primitive.kind === "infinite" || primitive.kind === "ray") {
        const base = points[0],
          direction = primitive.points[1];
        if (!base || !direction) throw new Error("CAD 无限线数据不完整。");
        const corners = clips.flatMap((c) => c.points),
          reach = Math.max(...corners.map((p) => Math.hypot(p.x - base.x, p.y - base.y)), 1) * 2;
        const length = Math.hypot(...direction);
        if (!length) throw new Error("CAD 无限线方向无效。");
        const d = { x: (direction[0] / length) * reach, y: (-direction[1] / length) * reach };
        points = [
          primitive.kind === "ray" ? base : { x: base.x - d.x, y: base.y - d.y },
          { x: base.x + d.x, y: base.y + d.y },
        ];
      }
      if (["polyline", "infinite", "ray"].includes(primitive.kind)) {
        for (let i = 1; i < points.length; i++)
          for (const segment of cropLine(points[i - 1]!, points[i]!, clips, holes))
            for (const final of cropLine(
              transform(segment[0]!),
              transform(segment[1]!),
              finalClips,
              [],
            ))
              push("polyline", final, color, primitive.lineweight);
      } else if (primitive.kind === "triangles" || primitive.kind === "mask") {
        if (points.length % 3) throw new Error("CAD 三角图元数据不完整。");
        for (let i = 0; i < points.length; i += 3)
          drawPolygon(points.slice(i, i + 3), primitive.kind, color, primitive.lineweight);
      } else if (primitive.kind === "point") {
        for (const p of points)
          if (
            clips.every((c) => pointInside(p, c.points)) &&
            !holes.some((c) => pointInside(p, c.points))
          ) {
            const q = transform(p);
            if (finalClips.every((c) => pointInside(q, c.points)))
              push("point", [q], color, primitive.lineweight);
          }
      } else throw new Error(`CAD 导出不支持图元 ${primitive.kind}，未生成缺失内容的文件。`);
    }
    if (inheritBindings) own(inheritedOwner);
  };
  const fragments = baseFragments(project),
    preserve = fragments.length > 0 && fragments.every((f) => fullFragment(f, project));
  const sourceCadAssetId = preserve ? project.cad.assetId : null;
  if (preserve) {
    if (
      fragments.length > 1 ||
      fragments.some(
        (f) => f.offset.x || f.offset.y || (f.scale ?? 1) !== 1 || (f.rotation ?? 0) !== 0,
      )
    )
      commands.push({
        command: "bridge.transform_model",
        params: {
          origin: [mapping.originX, mapping.originY],
          copies: fragments.map((f) => ({
            scale: f.scale ?? 1,
            rotation: -(f.rotation ?? 0),
            delta: [f.offset.x / mapping.scale, -f.offset.y / mapping.scale],
          })),
        },
      });
  } else {
    for (const fragment of fragments) renderFragment(fragment, current, mapping);
    warnings.push(
      "裁剪后的 CAD 曲线、文字和填充已转换为可编辑的矢量线段/实心面；未裁剪原稿不受影响。",
    );
  }
  for (const detail of project.detailViews ?? []) {
    if (
      project.cad.unified &&
      project.cad.objects?.some((o) => o.id === detail.id && o.body !== undefined)
    )
      continue;
    own({ id: detail.id, kind: "detail", role: "body" });
    if (!detail.cadSource) throw new Error("局部放大缺少冻结 CAD 来源，请重新创建后导出。");
    const frozen = scenes.get(detail.cadSource.assetId);
    if (!frozen) throw new Error("局部放大冻结 CAD 检查点未加载。");
    const boundary = circle(detail.center, detail.radius * detail.ratio);
    if (!project.cad.overlayAssetId) push("mask", boundary, [255, 255, 255]);
    for (const fragment of project.cad.overlayAssetId
      ? baseFragments({
          width: detail.cadSource.width ?? project.width,
          height: detail.cadSource.height ?? project.height,
        })
      : detail.fragments)
      renderFragment(
        fragment,
        frozen,
        detail.cadSource.mapping,
        project.cad.overlayAssetId ? 1 : (detail.sourceScale ?? 1),
        boundary,
        (p) => ({
          x: detail.center.x + (p.x - detail.source.x) * detail.ratio,
          y: detail.center.y + (p.y - detail.source.y) * detail.ratio,
        }),
      );
  }
  own(undefined);
  if (project.detailViews?.length)
    warnings.push(
      "局部放大内容使用冻结 CAD 图形；圆形裁剪/遮罩采用 256 边矢量近似，外框仍为 CAD 圆。",
    );
  const text = (value: string, at: Point, height: number) => {
    flush();
    const point = pageToCad(at, mapping);
    commands.push(
      { command: "color", params: { color: "0,0,0" } },
      {
        command: "text",
        params: {
          at: [point.x, point.y],
          text: value,
          height: height / mapping.scale,
          justify: "MC",
        },
        ...(owner ? { owner } : {}),
      },
    );
  };
  const ring = (center: Point, radius: number, width: number) => {
    flush();
    const p = pageToCad(center, mapping);
    commands.push(
      { command: "color", params: { color: "0,0,0" } },
      { command: "lweight", params: { lineweight: Math.min(2.11, (width * 25.4) / 96) } },
      {
        command: "circle",
        params: { center: [p.x, p.y], radius: radius / mapping.scale },
        ...(owner ? { owner } : {}),
      },
    );
  };
  for (const detail of project.detailViews ?? []) {
    const lw = Math.min(2.11, (detail.lineWidth * 25.4) / 96);
    if (!detail.markerHidden) {
      own({ id: detail.id, kind: "detail", role: "source" });
      ring(detail.source, detail.radius, detail.lineWidth);
      push("polyline", detailLeader(detail), [0, 0, 0], lw);
      text(detail.label, detail.marker, detail.fontSize);
    }
    own({ id: detail.id, kind: "detail", role: "frame" });
    ring(detail.center, detail.radius * detail.ratio, detail.lineWidth);
    if (!detail.titleHidden) {
      text(detail.label, detail.title, detail.fontSize);
      push(
        "polyline",
        [
          { x: detail.title.x - detail.fontSize * 1.3, y: detail.title.y + detail.fontSize * 0.7 },
          { x: detail.title.x + detail.fontSize * 1.3, y: detail.title.y + detail.fontSize * 0.7 },
        ],
        [0, 0, 0],
        lw,
      );
      text(
        detailRatioText(detail.ratio),
        { x: detail.title.x, y: detail.title.y + detail.fontSize * 1.5 },
        detail.fontSize,
      );
    }
  }
  for (const annotation of project.annotations) {
    own({ id: annotation.id, kind: "label", role: "label" });
    const points = leaderPoints(annotation);
    if (points.length > 1)
      push("polyline", points, [0, 0, 0], cadLabelLineweight(project,annotation));
    text(annotation.text, annotation, annotation.fontSize);
  }
  flush();
  if (commands.some((item) => ["bridge.add_primitives", "text", "circle"].includes(item.command))) {
    commands.unshift({ command: "bridge.prepare_export", params: {} });
  }
  for (const command of commands) {
    const owner = command.owner;
    if (!owner || owner.role === "body") continue;
    const saved = project.cad?.objects?.find((o) => o.id === owner.id && o.kind === owner.kind)
      ?.appearance?.[owner.role];
    if (!saved) continue;
    const { lineWidthAtEdit, ...appearance } = saved;
    const width =
      owner.kind === "label"
        ? project.annotations.find((a) => a.id === owner.id)?.lineWidth
        : project.detailViews?.find((d) => d.id === owner.id)?.lineWidth;
    if (owner.kind === "detail" && lineWidthAtEdit !== undefined && lineWidthAtEdit !== width) delete appearance.lineweight;
    command.appearance = appearance;
  }
  return { sourceCadAssetId, commands, warnings };
}
