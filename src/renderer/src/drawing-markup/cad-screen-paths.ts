const paintProperties = new Set([
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "fill",
  "fill-opacity",
]);
const groupAttributes = new Set(["stroke-linecap", "stroke-linejoin", "fill-rule"]);
const rootAttributes = new Set([
  "data-cad-stroke-unit",
  "xmlns",
  "xmlns:xlink",
  "version",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
]);

const directAttributes = new Set([
  "d",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
]);

/** Native checkpoints use explicitly styled polylines, without CSS classes. */
function nativeStroke(element: Element, parent: Element): Element | null {
  if (
    !["polyline", "path"].includes(element.localName) ||
    element.getAttribute("fill") !== "none" ||
    !/^#[\da-f]{6}$/iu.test(element.getAttribute("stroke") ?? "") ||
    !(Number(element.getAttribute("stroke-width")) > 0) ||
    Array.from(element.attributes).some((a) => !directAttributes.has(a.name)) ||
    Array.from(element.childNodes).some((node) => node.nodeType === 1)
  )
    return null;
  if (element.localName === "path") return element;
  const coordinates = (element.getAttribute("points") ?? "").trim().split(/[\s,]+/u);
  if (
    coordinates.length < 4 ||
    coordinates.length % 2 ||
    coordinates.some((n) => !Number.isFinite(Number(n)))
  )
    return null;
  const path = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  for (const attribute of Array.from(element.attributes))
    if (attribute.name !== "points") path.setAttribute(attribute.name, attribute.value);
  path.setAttribute(
    "d",
    coordinates
      .map((value, index) => (index % 2 ? ` ${value}` : `${index ? "L" : "M"}${value}`))
      .join(""),
  );
  parent.replaceChild(path, element);
  return path;
}

/**
 * Converter drawings can contain tens of thousands of tiny stroke elements.
 * Batch only adjacent opaque strokes in the display copy: each absolute move
 * preserves a separate subpath, while bounded batches retain useful culling.
 * Unrecognized SVG styling keeps the original rendering path.
 */
export function batchCadScreenPaths(root: Element) {
  if (Array.from(root.attributes).some((a) => !rootAttributes.has(a.name))) return;
  if (
    Array.from(root.getElementsByTagName("*")).some(
      (element) =>
        element.hasAttribute("transform") ||
        ["animate", "animateTransform", "set"].includes(element.localName),
    )
  )
    return;
  const classes = new Set<string>();
  const seen = new Set<string>();
  for (const style of Array.from(root.getElementsByTagName("style"))) {
    if (style.attributes.length) return;
    const rule = /^\s*\.([\w-]+)\s*\{([^{}]*)\}\s*$/u.exec(style.textContent ?? "");
    if (!rule || seen.has(rule[1]!)) return;
    seen.add(rule[1]!);
    const values = new Map<string, string>();
    for (const declaration of rule[2]!.split(";")) {
      if (!declaration.trim()) continue;
      const pair = declaration.split(":").map((s) => s.trim());
      if (pair.length !== 2 || !paintProperties.has(pair[0]!) || values.has(pair[0]!)) return;
      values.set(pair[0]!, pair[1]!);
    }
    if (
      values.get("fill") === "none" &&
      /^#[\da-f]{6}$/iu.test(values.get("stroke") ?? "") &&
      Number(values.get("stroke-opacity")) === 1 &&
      Number(values.get("fill-opacity")) === 1 &&
      Number(values.get("stroke-width")) > 0
    )
      classes.add(rule[1]!);
  }
  const visit = (parent: Element) => {
    let previous: Element | undefined;
    let previousStyle = "";
    let count = 0;
    let data = "";
    for (const element of Array.from(parent.childNodes).filter(
      (node): node is Element => node.nodeType === 1,
    )) {
      const kind = element.localName;
      const className = element.getAttribute("class") ?? "";
      const native = nativeStroke(element, parent);
      const candidate = native ?? element;
      const next = candidate.getAttribute("d") ?? "";
      const style = native
        ? JSON.stringify(
            Array.from(candidate.attributes)
              .filter((a) => a.name !== "d")
              .map((a) => [a.name, a.value])
              .sort(),
          )
        : `class:${className}`;
      const eligible =
        (native !== null ||
          (kind === "path" &&
            classes.has(className) &&
            element.attributes.length === 2 &&
            !Array.from(element.childNodes).some((node) => node.nodeType === 1))) &&
        /^\s*M/u.test(next);
      if (
        eligible &&
        previous &&
        previousStyle === style &&
        count < 64 &&
        data.length + next.length < 65_536
      ) {
        data += ` ${next}`;
        previous.setAttribute("d", data);
        parent.removeChild(candidate);
        count += 1;
      } else {
        previous = eligible ? candidate : undefined;
        previousStyle = style;
        count = eligible ? 1 : 0;
        data = eligible ? next : "";
      }
      if (kind === "g" && Array.from(element.attributes).every((a) => groupAttributes.has(a.name)))
        visit(element);
    }
  };
  visit(root);
}
