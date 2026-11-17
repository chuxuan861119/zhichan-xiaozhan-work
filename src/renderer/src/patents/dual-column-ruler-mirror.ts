/** Keep passive ruler nodes mounted while selection/highlight attributes change. */
export function syncRulerMirror(current: Node, next: Node): void {
  if (current instanceof Element && next instanceof Element) {
    for (const attribute of Array.from(current.attributes)) {
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(next.attributes)) {
      if (current.getAttribute(attribute.name) !== attribute.value)
        current.setAttribute(attribute.name, attribute.value);
    }
  } else if (current.nodeValue !== next.nodeValue) {
    current.nodeValue = next.nodeValue;
  }
  Array.from(next.childNodes).forEach((child, index) => {
    const existing = current.childNodes.item(index);
    if (!existing) current.appendChild(child.cloneNode(true));
    else if (existing.nodeName !== child.nodeName)
      current.replaceChild(child.cloneNode(true), existing);
    else syncRulerMirror(existing, child);
  });
  for (const extra of Array.from(current.childNodes).slice(next.childNodes.length))
    current.removeChild(extra);
}
