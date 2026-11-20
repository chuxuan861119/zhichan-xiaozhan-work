import { DESIGN_DIMENSION_GROUPS } from "../../../shared/patent/design-dimension-matrix";

export const SIX_VIEW_KINDS = ["front", "rear", "left", "right", "top", "bottom"] as const;
export type SixViewKind = (typeof SIX_VIEW_KINDS)[number];
export type SixViewImage = {
  kind: SixViewKind;
  viewId: string;
  width: number | null;
  height: number | null;
  url?: string;
  mirror?: "x" | "y";
  omitted?: boolean;
};
export type EdgeState = "matched" | "mismatch" | "unknown";
type Point = [number, number, number];
export type SixViewRotation = { pitch: number; yaw: number };
export type SixViewFace = {
  kind: SixViewKind;
  image?: SixViewImage;
  omitted: boolean;
  corners: Point[];
  normal: Point;
  edges: EdgeState[];
};

/** Compare pixel dimensions, not product bounds or inferred legal compliance. */
export function buildSixViewModel(
  images: readonly SixViewImage[],
  omittedKinds: ReadonlySet<SixViewKind> = new Set(),
) {
  const valid = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  const byKind = new Map(images.map((image) => [image.kind, image]));
  const groups = DESIGN_DIMENSION_GROUPS.map((group) => {
    const values = group.entries
      .filter((entry) => !omittedKinds.has(entry.kind))
      .map((entry) => byKind.get(entry.kind)?.[entry.dimension]);
    const known = values.filter(valid);
    return {
      axis: group.axis,
      known,
      state: (new Set(known).size > 1
        ? "mismatch"
        : known.length >= 2 && known.length === values.length
          ? "matched"
          : "unknown") as EdgeState,
    };
  });
  const dimension = (axis: string, fallback: number) =>
    groups.find((group) => group.axis === axis)?.known[0] ?? fallback;
  const width = dimension("width", 100),
    height = dimension("height", 100),
    depth = dimension("depth", 100);
  const edge = (axis: string) => groups.find((group) => group.axis === axis)!.state;
  const faces: SixViewFace[] = SIX_VIEW_KINDS.map((kind) => {
    const image = byKind.get(kind);
    const horizontalAxis = kind === "left" || kind === "right" ? "depth" : "width";
    const verticalAxis = kind === "top" || kind === "bottom" ? "depth" : "height";
    const w = valid(image?.width) ? image.width : horizontalAxis === "width" ? width : depth;
    const h = valid(image?.height) ? image.height : verticalAxis === "height" ? height : depth;
    let center: Point, u: Point, v: Point, normal: Point;
    switch (kind) {
      case "front":
        center = [0, 0, depth / 2];
        u = [w, 0, 0];
        v = [0, h, 0];
        normal = [0, 0, 1];
        break;
      case "rear":
        center = [0, 0, -depth / 2];
        u = [-w, 0, 0];
        v = [0, h, 0];
        normal = [0, 0, -1];
        break;
      case "left":
        center = [-width / 2, 0, 0];
        u = [0, 0, w];
        v = [0, h, 0];
        normal = [-1, 0, 0];
        break;
      case "right":
        center = [width / 2, 0, 0];
        u = [0, 0, -w];
        v = [0, h, 0];
        normal = [1, 0, 0];
        break;
      case "top":
        center = [0, -height / 2, 0];
        u = [w, 0, 0];
        v = [0, 0, h];
        normal = [0, -1, 0];
        break;
      case "bottom":
        center = [0, height / 2, 0];
        u = [w, 0, 0];
        v = [0, 0, -h];
        normal = [0, 1, 0];
        break;
    }
    const corners = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ].map(([a, b]) => center.map((n, i) => n + a! * u[i]! + b! * v[i]!) as Point);
    return {
      kind,
      omitted: omittedKinds.has(kind),
      ...(image ? { image } : {}),
      corners,
      normal,
      edges: [edge(horizontalAxis), edge(verticalAxis), edge(horizontalAxis), edge(verticalAxis)],
    };
  });
  return {
    faces,
    status: groups.some((g) => g.state === "mismatch")
      ? ("mismatch" as const)
      : groups.every((g) => g.state === "matched")
        ? ("matched" as const)
        : ("incomplete" as const),
  };
}

/** Orthographic projection uses one scale for all six planes; no per-face fitting. */
export function projectSixViewFaces(
  model: ReturnType<typeof buildSixViewModel>,
  rotation: SixViewRotation,
) {
  const yaw = (rotation.yaw * Math.PI) / 180,
    pitch = (rotation.pitch * Math.PI) / 180;
  const rotate = ([x, y, z]: Point): Point => {
    const xx = x * Math.cos(yaw) + z * Math.sin(yaw),
      zz = -x * Math.sin(yaw) + z * Math.cos(yaw);
    return [
      xx,
      y * Math.cos(pitch) - zz * Math.sin(pitch),
      y * Math.sin(pitch) + zz * Math.cos(pitch),
    ];
  };
  const rotated = model.faces.map((face) => ({
    ...face,
    rotated: face.corners.map(rotate),
    visible: rotate(face.normal)[2] > 0.001,
    facing: rotate(face.normal)[2],
  }));
  // Fit by a rotation-independent bounding sphere, so dragging cannot cause zoom pumping.
  const radius = Math.max(
    1,
    ...model.faces.flatMap((face) => face.corners.map((point) => Math.hypot(...point))),
  );
  const scale = 85 / radius;
  return rotated
    .filter((face) => face.visible)
    .map((face) => ({
      ...face,
      points: face.rotated.map(([x, y]) => [140 + x * scale, 100 + y * scale] as [number, number]),
      depth: face.rotated.reduce((sum, point) => sum + point[2], 0) / 4,
    }))
    .sort((a, b) => a.depth - b.depth);
}
