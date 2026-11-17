import { createLucideIcon, type IconNode, type LucideIcon } from "lucide-react";

// Original geometric diagrams. No Autodesk artwork is embedded or traced.
// Shared 24-unit grid: solid geometry, dashed construction, blue input constraints.
type Role = "geometry" | "guide" | "constraint";
function path(d: string, role: Role = "geometry"): IconNode[number] {
  return ["path", { d, className: `cad-icon-${role}`, key: `${role}:${d}` }];
}
function dot(x: number, y: number): IconNode[number] {
  return [
    "circle",
    {
      cx: String(x),
      cy: String(y),
      r: "1.35",
      className: "cad-icon-point",
      key: `point:${x}:${y}`,
    },
  ];
}
function ring(x: number, y: number, r: number, role: Role = "geometry"): IconNode[number] {
  return [
    "circle",
    {
      cx: String(x),
      cy: String(y),
      r: String(r),
      className: `cad-icon-${role}`,
      key: `circle:${x}:${y}:${r}`,
    },
  ];
}
const center = path("M10 12h4M12 10v4", "constraint");
const circle = ring(12, 12, 8);
const arc = path("M4 20A16 16 0 0 1 20 4");
const ellipse: IconNode[number] = [
  "ellipse",
  { cx: "12", cy: "12", rx: "9", ry: "6", className: "cad-icon-geometry", key: "ellipse" },
];
const hexagon = path("M12 3 20 7.5v9L12 21 4 16.5v-9Z");
function icon(name: string, nodes: IconNode): LucideIcon {
  return createLucideIcon(`Cad${name}`, nodes);
}

// Project a helix with overlapping turns, rather than a flat sine-wave symbol.
function springCoil(from: number, to: number, turns: number, depth: number, radius: number) {
  const segments = turns * 24;
  return path(Array.from({ length: segments + 1 }, (_, index) => {
    const progress = index / segments;
    const angle = progress * turns * Math.PI * 2;
    const x = from + (to - from) * progress + depth * (1 - Math.cos(angle));
    const y = 12 + radius * Math.sin(angle);
    return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(""));
}

export const CAD_TOOL_ICONS: Record<string, LucideIcon> = {
  "chain.drive": icon("ChainDrive", [path("M7 6L17 8a4 4 0 0 1 0 8L7 18A6 6 0 0 1 7 6Z"),ring(7,12,3.5),ring(17,12,2.3),dot(7,12),dot(17,12)]),
  "chain.sprocket": icon("Sprocket", [path("M12 2Q14 6 17 3Q16 7 21 7Q18 10 22 12Q18 14 21 17Q16 17 17 21Q14 18 12 22Q10 18 7 21Q8 17 3 17Q6 14 2 12Q6 10 3 7Q8 7 7 3Q10 6 12 2Z"),ring(12,12,6),ring(12,12,2)]),
  spring: icon("CompressionSpring", [path("M2 12h1M18 12h4"), springCoil(3, 18, 3, 3, 5)]),
  "spring.extension": icon("ExtensionSpring", [
    path("M7 12H4.5a2.5 2.5 0 1 1 2.5-2.5M17 12h2.5a2.5 2.5 0 1 0-2.5-2.5"),
    springCoil(7, 17, 3, 1.3, 3.5),
  ]),
  "gear.external": icon("ExternalGear", [path("M9 2h6l.5 3 2 1 2.5-1 2 4-2 2v2l2 2-2 4-2.5-1-2 1-.5 3H9l-.5-3-2-1-2.5 1-2-4 2-2v-2l-2-2 2-4 2.5 1 2-1Z"),ring(12,12,3)]),
  "gear.internal": icon("InternalGear", [ring(12,12,10),path("M9 6h6v3h3v6h-3v3H9v-3H6V9h3Z")]),
  "gear.rack": icon("GearRack", [path("M2 19V11h2V6h3v5h3V6h3v5h3V6h3v5h3v8Z")]),
  circle: icon("CircleRadius", [circle, center, path("M12 12h8", "constraint"), dot(20, 12)]),
  "circle.cd": icon("CircleDiameter", [
    circle,
    path("M4 12h16", "constraint"),
    dot(4, 12),
    dot(20, 12),
  ]),
  "circle.2p": icon("CircleTwoPoints", [
    circle,
    path("M6.35 17.65 17.65 6.35", "guide"),
    dot(6.35, 17.65),
    dot(17.65, 6.35),
  ]),
  "circle.3p": icon("CircleThreePoints", [circle, dot(12, 4), dot(5.07, 16), dot(18.93, 16)]),
  "circle.ttr": icon("CircleTwoTangents", [
    path("M2 2v20h20", "guide"),
    ring(10, 14, 8),
    path("M10 14h8", "constraint"),
    dot(2, 14),
    dot(10, 22),
  ]),
  "circle.ttt": icon("CircleThreeTangents", [
    path("M12 2 1 22h22Z", "guide"),
    ring(12, 15.5, 6.5),
    dot(6.3, 12.4),
    dot(17.7, 12.4),
    dot(12, 22),
  ]),
  arc: icon("ArcThreePoints", [arc, dot(4, 20), dot(8.69, 8.69), dot(20, 4)]),
  "arc.sce": icon("ArcCenter", [
    arc,
    path("M4 20h16V4", "guide"),
    dot(4, 20),
    dot(20, 4),
    path("M18 20h4M20 18v4", "constraint"),
  ]),
  "arc.ser": icon("ArcRadius", [
    path("M4 18a8 8 0 0 1 16 0"),
    dot(4, 18),
    dot(20, 18),
    path("M12 18v-8m-2 3 2-3 2 3", "constraint"),
  ]),
  "arc.sea": icon("ArcAngle", [
    arc,
    path("M4 20h16V4", "guide"),
    path("M14 20a6 6 0 0 1 6-6m-3-1 3 1-1 3", "constraint"),
    dot(4, 20),
    dot(20, 4),
  ]),
  "arc.continue": icon("ArcContinue", [
    path("M2 20h8", "guide"),
    path("M10 20A10 10 0 0 0 20 10V4", "constraint"),
    dot(10, 20),
    path("m17 7 3-3 3 3", "constraint"),
  ]),
  ellipse: icon("EllipseCenter", [ellipse, path("M12 12h9M12 12V6", "guide"), center, dot(21, 12)]),
  "ellipse.axis": icon("EllipseAxis", [
    ellipse,
    path("M3 12h18", "guide"),
    dot(3, 12),
    dot(21, 12),
    dot(12, 6),
  ]),
  "ellipse.arc": icon("EllipseArc", [
    path("M3 12a9 6 0 1 1 9 6"),
    path("M3 12h9v6", "guide"),
    dot(3, 12),
    dot(12, 18),
  ]),
  polygon: icon("PolygonInscribed", [
    ring(12, 12, 9, "guide"),
    hexagon,
    path("M12 12V3", "constraint"),
    dot(12, 3),
  ]),
  "polygon.out": icon("PolygonCircumscribed", [
    ring(12, 12, 7.8, "guide"),
    hexagon,
    path("M12 12h8", "constraint"),
    dot(20, 12),
  ]),
  "polygon.edge": icon("PolygonEdge", [
    hexagon,
    path("M4 16.5 12 21", "constraint"),
    dot(4, 16.5),
    dot(12, 21),
  ]),
  rectang: icon("Rectangle", [path("M4 5h16v14H4Z"), dot(4, 5), dot(20, 19)]),
  "rectang.center": icon("RectangleCenter", [path("M3 5h18v14H3Z"), path("M3 5l18 14M3 19L21 5","guide"), dot(12,12), dot(21,19)]),
  "rectang.3p": icon("RectangleThreePoints", [path("M2 11l14-8 6 10-14 8Z"), dot(2,11),dot(16,3),dot(22,13)]),
  "rectang.center-rotated": icon("RectangleCenterRotated", [path("M2 11l14-8 6 10-14 8Z"),path("M5 16l14-8M9 7l6 10","guide"),dot(12,12),dot(19,8)]),
  fillet: icon("Fillet", [path("M4 21V3h17", "guide"), path("M4 21v-8A10 10 0 0 1 14 3h7")]),
  chamfer: icon("Chamfer", [path("M4 21V3h17", "guide"), path("M4 21V12l9-9h8")]),
  trim: icon("Trim", [
    path("M14 2v20", "guide"),
    path("M2 12h12"),
    path("M14 12h8", "guide"),
    path("m18 9 4 6m-4 0 4-6", "constraint"),
  ]),
  extend: icon("Extend", [
    path("M20 2v20", "guide"),
    path("M2 12h8"),
    path("M10 12h10m-4-3 4 3-4 3", "constraint"),
  ]),
  mirror: icon("Mirror", [
    path("M12 2v20", "guide"),
    path("M3 6v12h6Z"),
    path("M21 6v12h-6Z", "constraint"),
  ]),
  hatch: icon("Hatch", [
    path("M3 3h18v18H3Z"),
    path("M3 9 9 3M3 15 15 3M3 21 21 3M9 21 21 9M15 21 21 15", "constraint"),
  ]),
  arrayrect: icon("RectangularArray", [
    path("M3 3h5v5H3ZM3 16h5v5H3ZM16 3h5v5h-5ZM16 16h5v5h-5Z"),
    path("M10 5.5h4M5.5 10v4", "guide"),
  ]),
  arraypolar: icon("PolarArray", [
    ring(12, 12, 8, "guide"),
    path("M10 2h4v4h-4ZM2 10h4v4H2ZM18 10h4v4h-4ZM10 18h4v4h-4Z"),
    center,
  ]),
  arraypath: icon("PathArray", [
    path("M2 20C8 20 5 4 13 4s6 12 9 12", "guide"),
    path("M1 17h5v5H1ZM8 3h5v5H8ZM18 13h5v5h-5Z"),
  ]),
  join: icon("JoinSegments", [path("M2 18h9l11-12"), path("M8 18h6M11 15v6", "constraint")]),
  explode: icon("ExplodeGeometry", [
    path("M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"),
    path("M9 9 5 5m10 4 4-4m-4 10 4 4m-10-4-4 4", "constraint"),
  ]),
  group: icon("GroupObjects", [
    path("M2 2h20v20H2Z", "guide"),
    path("M5 6h6v6H5Z"),
    ring(16, 16, 3),
    path("M10 16h3", "constraint"),
  ]),
  ungroup: icon("UngroupObjects", [
    path("M2 7V2h5M17 2h5v5M22 17v5h-5M7 22H2v-5", "guide"),
    path("M4 5h6v6H4Z"),
    ring(17, 17, 3),
    path("m10 14 4-4m-4 0 4 4", "constraint"),
  ]),
};

export function cadToolIcon(id: string, fallback: LucideIcon): LucideIcon {
  return CAD_TOOL_ICONS[id] ?? fallback;
}
