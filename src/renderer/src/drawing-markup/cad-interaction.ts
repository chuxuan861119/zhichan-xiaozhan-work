import { baseFragments, fragmentLocalPoint } from "../../../shared/drawing-markup/base-fragments";
import { pageToCad } from "../../../shared/drawing-markup/cad-state";
import { pointInside } from "../../../shared/drawing-markup/geometry";
import type { DrawingPoint, DrawingProject } from "../../../shared/drawing-markup/model";
import type { ExtraCadTool } from "./cad-gesture";
import type { CadScene } from "./cadcraft-client";

// AutoCAD GRIPOBJLIMIT default. Use the same limit for painting and hit testing.
export const CAD_GRIP_OBJECT_LIMIT = 100;

export function expandCadGroups(scene: CadScene, handles: string[]) {
  const visible = new Set(scene.entities.filter((e) => e.visible !== false).map((e) => e.handle));
  const selected = new Set(handles.filter((h) => visible.has(h)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of scene.groups ?? []) {
      if (!group.selectable || !group.members.some((h) => selected.has(h))) continue;
      for (const h of group.members)
        if (visible.has(h) && !selected.has(h)) {
          selected.add(h);
          changed = true;
        }
    }
  }
  return [...selected];
}

export function supportsCadProperty(field: string, types: string[]) {
  const allowed: Record<string, string[]> = {
    text: ["Text", "MText"],
    height: ["Text", "MText"],
    radius: ["Circle", "Arc"],
    rotation: ["Text", "MText", "Block Reference"],
  };
  return types.length > 0 && (!allowed[field] || types.every((t) => allowed[field]!.includes(t)));
}
export function validCadProperty(field: string, value: string, types: string[]) {
  if (!value.trim() || !supportsCadProperty(field, types)) return false;
  if (field === "text") return true;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (field === "radius" || field === "height") return n > 0;
  if (field === "lineweight") return n >= 0 && n <= 2.11;
  if (field === "color") return Number.isInteger(n) && n >= 1 && n <= 255;
  return true;
}

export function resolveCadWindow(
  project: DrawingProject,
  start: DrawingPoint,
  end: DrawingPoint,
  aperture: number,
) {
  const first = resolveCadPointer(project, start, aperture);
  if (!first) return null;
  const corners = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
  const polygon = corners.map(
    (p) => resolveCadPointer(project, p, aperture, first.fragmentId)?.point,
  );
  if (polygon.some((p) => !p)) return null;
  return {
    polygon: polygon as DrawingPoint[],
    crossing: end.x < start.x,
    fragmentId: first.fragmentId,
  };
}

export type CadTool =
  | "select"
  | "window"
  | "line"
  | "rectang"
  | "circle"
  | "gear"
  | "chain"
  | "spring"
  | "text"
  | "move"
  | "copy"
  | "rotate"
  | "scale"
  | "pline"
  | "spline"
  | "arrayrect"
  | "arraypolar"
  | "arraypath"
  | "explode"
  | "hatch"
  | ExtraCadTool;

/** Keep a gesture on its starting fragment, including its final point beyond a clip. */
export function resolveCadPointer(
  project: DrawingProject,
  page: DrawingPoint,
  aperture: number,
  fragmentId?: string,
) {
  if (!project.cad) return null;
  const fragment = project.cad.unified
    ? undefined
    : fragmentId
      ? baseFragments(project).find((item) => item.id === fragmentId)
      : project.baseFragments
        ? [...baseFragments(project)].reverse().find((item) => {
            const local = fragmentLocalPoint(item, page);
            return (
              item.clips.every((clip) => pointInside(local, clip)) &&
              !item.holes.some((hole) => pointInside(local, hole))
            );
          })
        : undefined;
  if (!project.cad.unified && (fragmentId || project.baseFragments) && !fragment) return null;
  return {
    point: pageToCad(fragment ? fragmentLocalPoint(fragment, page) : page, project.cad.mapping),
    tolerance: aperture / (fragment?.scale ?? 1) / project.cad.mapping.scale,
    fragmentId: fragment?.id,
  };
}

export function cadPreviewGeometry(
  mode: CadTool,
  anchor: DrawingPoint | null,
  points: DrawingPoint[],
  cursor: DrawingPoint,
  amount = 6,
) {
  const result: { paths: DrawingPoint[][]; circle?: { center: DrawingPoint; radius: number } } = {
    paths: [],
  };
  if (mode === "rectang" && anchor)
    result.paths = [
      [anchor, { x: cursor.x, y: anchor.y }, cursor, { x: anchor.x, y: cursor.y }, anchor],
    ];
  else if (mode === "circle" && anchor)
    result.circle = {
      center: anchor,
      radius: Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y),
    };
  else if (mode === "arc" && points.length === 2) {
    const [a, b] = points as [DrawingPoint, DrawingPoint],
      c = cursor;
    const bx = b.x - a.x,
      by = b.y - a.y,
      cx = c.x - a.x,
      cy = c.y - a.y;
    const det = 2 * (bx * cy - by * cx);
    if (Math.abs(det) > 1e-10) {
      const ux = ((bx * bx + by * by) * cy - (cx * cx + cy * cy) * by) / det;
      const uy = (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / det;
      const center = { x: a.x + ux, y: a.y + uy },
        radius = Math.hypot(ux, uy);
      const start = Math.atan2(-uy, -ux),
        mid = Math.atan2(b.y - center.y, b.x - center.x),
        end = Math.atan2(c.y - center.y, c.x - center.x);
      const tau = 2 * Math.PI,
        norm = (n: number) => ((n % tau) + tau) % tau;
      const sweep =
        norm(mid - start) <= norm(end - start) ? norm(end - start) : norm(end - start) - tau;
      result.paths = [
        Array.from({ length: 97 }, (_, i) => ({
          x: center.x + radius * Math.cos(start + (sweep * i) / 96),
          y: center.y + radius * Math.sin(start + (sweep * i) / 96),
        })),
      ];
    }
  } else if (mode === "ellipse" && points.length === 2) {
    const [center, major] = points as [DrawingPoint, DrawingPoint];
    const dx = major.x - center.x,
      dy = major.y - center.y,
      len = Math.hypot(dx, dy);
    if (len > 0) {
      const minor = Math.hypot(cursor.x - center.x, cursor.y - center.y);
      if (minor > 0)
        result.paths = [
          Array.from({ length: 97 }, (_, i) => {
            const t = (i * Math.PI) / 48;
            return {
              x: center.x + dx * Math.cos(t) - (dy / len) * minor * Math.sin(t),
              y: center.y + dy * Math.cos(t) + (dx / len) * minor * Math.sin(t),
            };
          }),
        ];
    }
  } else if (
    mode === "polygon" &&
    points.length &&
    Number.isInteger(amount) &&
    amount >= 3 &&
    amount <= 20
  ) {
    const center = points[0]!,
      radius = Math.hypot(cursor.x - center.x, cursor.y - center.y);
    result.paths = [
      Array.from({ length: amount + 1 }, (_, i) => ({
        x:
          center.x +
          radius *
            Math.cos(
              Math.atan2(cursor.y - center.y, cursor.x - center.x) + (i * 2 * Math.PI) / amount,
            ),
        y:
          center.y +
          radius *
            Math.sin(
              Math.atan2(cursor.y - center.y, cursor.x - center.x) + (i * 2 * Math.PI) / amount,
            ),
      })),
    ];
  } else if (points.length && mode !== "spline") result.paths = [[...points, cursor]];
  else if (anchor) result.paths = [[anchor, cursor]];
  return result;
}
