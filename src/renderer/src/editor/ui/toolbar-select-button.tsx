import { createElement, useEffect, useRef } from "react";

export function ToolbarSelectButton() {
  const labelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const label = labelRef.current;
    if (!label) return;
    const update = () =>
      label.classList.toggle("is-overflowing", label.scrollWidth > label.clientWidth);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const content = new MutationObserver(update);
    resize?.observe(label);
    content.observe(label, { childList: true, subtree: true, characterData: true });
    update();
    return () => {
      resize?.disconnect();
      content.disconnect();
    };
  }, []);
  return (
    <button type="button">
      {createElement("selectedcontent", { className: "toolbar-selected-label", ref: labelRef })}
    </button>
  );
}
