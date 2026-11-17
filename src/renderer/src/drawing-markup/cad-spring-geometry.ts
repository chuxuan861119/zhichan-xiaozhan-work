import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import profile from "../../../shared/drawing-markup/spring-profile.json";
import { extensionSpringPaths } from "./cad-extension-spring-geometry";
import { joinVisibleTurns } from "./cad-spring-outline";
import type { CadScene } from "./cadcraft-client";

type Spring = NonNullable<CadScene["entities"][number]["spring"]>;

type ProfilePoint = [number, number];

function endWireAdjustment(distance: number, scale: number): ProfilePoint {
  const change = scale - 1;
  if (distance <= 5) return [change * distance, change];
  if (distance >= 20) return [0, 0];
  const t = (distance - 5) / 15;
  return [
    (2 * t ** 3 - 3 * t ** 2 + 1) * change * 5 + (t ** 3 - 2 * t ** 2 + t) * change * 15,
    ((6 * t ** 2 - 6 * t) * change) / 3 + (3 * t ** 2 - 4 * t + 1) * change,
  ];
}

function outlineNormal(points: ProfilePoint[], index: number): ProfilePoint {
  const first = Math.max(0, Math.min(points.length - 3, index - 1));
  const a = points[first] as ProfilePoint,
    b = points[first + 1] as ProfilePoint,
    c = points[first + 2] as ProfilePoint;
  const ax = b[0] - a[0],
    ay = b[1] - a[1],
    bx = c[0] - b[0],
    by = c[1] - b[1];
  const la = Math.hypot(ax, ay),
    lb = Math.hypot(bx, by);
  // Unequally spaced samples need a quadratic tangent, including at open ends.
  const wa =
    index === 0
      ? (2 * la + lb) / (la + lb)
      : index === points.length - 1
        ? -lb / (la + lb)
        : lb / (la + lb);
  const wb = 1 - wa;
  const dx = (wa * ax) / la + (wb * bx) / lb,
    dy = (wa * ay) / la + (wb * by) / lb;
  const size = Math.hypot(dx, dy);
  return [dy / size, -dx / size];
}

/** Synchronous pointer-frame preview; the native editor changes only on release. */
export function springGripPreview(
  spring: Spring,
  index: number,
  to: DrawingPoint,
): DrawingPoint[][] {
  let start = { x: spring.at[0], y: spring.at[1] },
    end = { x: spring.end[0], y: spring.end[1] };
  let length = spring.length,
    width = spring.width,
    turns = spring.turns;
  const ux = (end.x - start.x) / length,
    uy = (end.y - start.y) / length;
  const px = -uy,
    py = ux;
  const extension = spring.kind === "extension";
  const minimumLength = extension
    ? 2 * width + (turns - 1) * spring.wire
    : 2.02 * turns * spring.wire;
  if (index === 0)
    start =
      Math.hypot(end.x - to.x, end.y - to.y) < minimumLength
        ? { x: end.x - ux * minimumLength, y: end.y - uy * minimumLength }
        : to;
  else if (index === 1)
    end =
      Math.hypot(to.x - start.x, to.y - start.y) < minimumLength
        ? { x: start.x + ux * minimumLength, y: start.y + uy * minimumLength }
        : to;
  else if (index === 2) {
    width = Math.max(
      spring.wire * 3.01,
      2 * Math.abs((to.x - (start.x + end.x) / 2) * px + (to.y - (start.y + end.y) / 2) * py),
    );
    if (extension) width = Math.min(width, (length - (turns - 1) * spring.wire) / 2);
  } else if (index === 3) {
    const maximumTurns = extension
      ? Math.floor((length - 2 * width) / spring.wire + 1 + 1e-8)
      : Math.floor(length / (2 * spring.wire) - 1e-8);
    if (maximumTurns < 3) return [];
    const base = {
      x: start.x + ux * length * 0.75 + px * width * 0.5,
      y: start.y + uy * length * 0.75 + py * width * 0.5,
    };
    turns = Math.max(
      3,
      Math.min(
        24,
        maximumTurns,
        turns + Math.round(((to.x - base.x) * ux + (to.y - base.y) * uy) / (length / turns)),
      ),
    );
  } else if (index === 4) {
    const dx = to.x - (start.x + end.x) / 2,
      dy = to.y - (start.y + end.y) / 2;
    start = { x: start.x + dx, y: start.y + dy };
    end = { x: end.x + dx, y: end.y + dy };
  } else return [];
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance <= 1e-6) return [];
  length = distance;
  const axis = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const normal = { x: -axis.y, y: axis.x };
  if (extension)
    return extensionSpringPaths(length, width, spring.wire, turns).map((path) =>
      path.map(([x, y]) => ({
        x: start.x + axis.x * x + normal.x * y,
        y: start.y + axis.y * x + normal.y * y,
      })),
    );
  const extra = (turns - profile.referenceTurns) * profile.referencePitch;
  const referenceLength = profile.referenceLength + extra;
  const radius = profile.referenceWire / 2;
  const axialScale = (length - spring.wire) / (referenceLength - profile.referenceWire);
  const acrossScale = (width - spring.wire) / (profile.referenceWidth - profile.referenceWire);
  const axialWireScale = spring.wire / (profile.referenceWire * axialScale);
  const local = (along: number, across: number): DrawingPoint => ({
    x: start.x + axis.x * along + normal.x * across,
    y: start.y + axis.y * along + normal.y * across,
  });
  const paths: ProfilePoint[][] = [];
  const append = (index: number, shift: number) => {
    const template = profile.paths[index] as ProfilePoint[];
    paths.push(
      template.map(([rawAxial, rawAcross], vertex): ProfilePoint => {
        const [nx, ny] = outlineNormal(template, vertex);
        // Resize the wire centreline, then restore the selected radius in the
        // transformed normal direction. Stretching a contour scales its wire too.
        const position = Math.max(
          0,
          Math.min(referenceLength - 2 * radius, rawAxial + shift - radius * nx - radius),
        );
        const across = Math.max(
          radius,
          Math.min(profile.referenceWidth - radius, rawAcross - radius * ny),
        );
        const [top, topSlope] = endWireAdjustment(position, axialWireScale);
        const [bottom, bottomSlope] = endWireAdjustment(
          referenceLength - 2 * radius - position,
          axialWireScale,
        );
        const normalX = nx / (axialScale * (1 + topSlope + bottomSlope));
        const normalY = ny / acrossScale;
        const normalLength = Math.hypot(normalX, normalY);
        return [
          spring.wire / 2 +
            axialScale * (position + top - bottom) +
            ((spring.wire / 2) * normalX) / normalLength,
          spring.wire / 2 +
            acrossScale * (across - radius) +
            ((spring.wire / 2) * normalY) / normalLength,
        ];
      }),
    );
  };
  append(0, 0);
  append(1, 0);
  for (let turn = 0; turn < turns - 3; turn++) append(2, (turn - 1) * profile.referencePitch);
  append(3, extra);
  append(4, extra);
  append(5, extra);
  for (let turn = 0; turn < turns - 3; turn++)
    append(6, extra + (1 - turn) * profile.referencePitch);
  append(7, 0);
  append(8, 0);
  append(9, 0);
  append(10, 0);
  append(11, extra);
  append(12, extra);
  joinVisibleTurns(paths, turns, width);
  // Adjacent sampled cap arcs estimate their endpoint normals independently.
  // Keep the shared seams exact after changing the wire radius.
  const face = paths[2 * turns + 2] as ProfilePoint[];
  face[face.length - 1] = face[0] as ProfilePoint;
  const faceJoin = paths[2 * turns + 1] as ProfilePoint[];
  faceJoin[faceJoin.length - 1] = face[0] as ProfilePoint;
  const cap = paths[2 * turns + 3] as ProfilePoint[];
  const tip = paths[2 * turns + 4] as ProfilePoint[];
  cap[0] = tip[tip.length - 1] as ProfilePoint;
  const lastTurn = paths[turns - 1] as ProfilePoint[];
  lastTurn[lastTurn.length - 1] = tip[0] as ProfilePoint;
  (paths[turns] as ProfilePoint[])[0] = cap[cap.length - 1] as ProfilePoint;
  return paths.map((path) => path.map(([along, across]) => local(along, width / 2 - across)));
}
