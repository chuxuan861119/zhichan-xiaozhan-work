import type { CSSProperties } from "react";

export function cadLineOptionStyle(width = 1.5, dash = ""): CSSProperties {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 16"><path d="M2 8H62" fill="none" stroke="black" stroke-width="${width}" stroke-dasharray="${dash}"/></svg>`;
  return {
    "--cad-line-sample": `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
  } as CSSProperties;
}
