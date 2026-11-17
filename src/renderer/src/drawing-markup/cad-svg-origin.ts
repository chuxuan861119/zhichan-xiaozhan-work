const number = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/giu;
const arities: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

/** Rebase actual vertices, not a group transform: Chromium loses thin strokes
 * when non-scaling-stroke is evaluated at very large absolute coordinates. */
export function rebaseCadPath(path: string, x: number, y: number): string | null {
  const commands = [...path.matchAll(/([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/giu)];
  if (!commands.length || commands[0]![1]!.toUpperCase() !== "M") return null;
  const output: string[] = [];
  for (const [index, match] of commands.entries()) {
    const command = match[1]!;
    const kind = command.toUpperCase();
    const input = match[2]!;
    const values = input.match(number)?.map(Number) ?? [];
    const arity = arities[kind]!;
    if (
      input.replace(number, "").replace(/[\s,]/gu, "") ||
      (arity ? !values.length || values.length % arity : values.length)
    )
      return null;
    // Relative commands are already offsets, except the first moveto which is
    // relative to the SVG origin. Subsequent implicit movetos are relative lines.
    const absolute = command === kind;
    output.push(
      command +
        values
          .map((value, i) => {
            if (!absolute && !(index === 0 && i < 2)) return value;
            const slot = i % arity;
            if (kind === "A" && slot < 5) return value;
            const vertical =
              kind === "V" || (kind !== "H" && (kind === "A" ? slot === 6 : slot % 2 === 1));
            return value - (vertical ? y : x);
          })
          .join(" "),
    );
  }
  return output.join(" ");
}

/** Only flat, self-contained CAD output is rebased. Definitions, transforms and
 * foreign SVG content retain their original coordinate semantics. */
export function rebaseCadScreenRoot(root: Element, x: number, y: number): Element | null {
  if (root.hasAttribute("transform")) return null;
  const allowed = new Set([
    "style",
    "path",
    "polyline",
    "polygon",
    "line",
    "circle",
    "ellipse",
    "rect",
  ]);
  const elements = Array.from(root.getElementsByTagName("*"));
  if (
    elements.some((element) => !allowed.has(element.localName) || element.hasAttribute("transform"))
  )
    return null;
  const rebased = root.cloneNode(true) as Element;
  for (const element of Array.from(rebased.getElementsByTagName("*"))) {
    if (element.localName === "style") continue;
    const d = element.getAttribute("d");
    if (d) {
      const path = rebaseCadPath(d, x, y);
      if (path === null) return null;
      element.setAttribute("d", path);
    }
    const points = element.getAttribute("points");
    if (points) {
      const values = points.match(number)?.map(Number) ?? [];
      if (values.length % 2 || points.replace(number, "").replace(/[\s,]/gu, "")) return null;
      element.setAttribute("points", values.map((value, i) => value - (i % 2 ? y : x)).join(" "));
    }
    for (const attr of ["x", "x1", "x2", "cx", "y", "y1", "y2", "cy"]) {
      const value = element.getAttribute(attr);
      if (value === null) continue;
      if (!Number.isFinite(Number(value)) || !value.trim()) return null;
      element.setAttribute(attr, String(Number(value) - (attr.includes("y") ? y : x)));
    }
    // Default origins must move too; radii, sizes and arc flags stay untouched.
    for (const attr of element.localName === "rect"
      ? ["x", "y"]
      : ["circle", "ellipse"].includes(element.localName)
        ? ["cx", "cy"]
        : element.localName === "line"
          ? ["x1", "x2", "y1", "y2"]
          : []) {
      if (!element.hasAttribute(attr))
        element.setAttribute(attr, String(-(attr.includes("y") ? y : x)));
    }
  }
  return rebased;
}
