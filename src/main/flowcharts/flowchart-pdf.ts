import { SvgSanitizer } from "./svg-sanitizer.js";

/** Standalone vector line drawings; never execute raw editor HTML in the print window. */
export function buildFlowchartPdfHtml(svgs: readonly string[]): string {
  const sanitizer = new SvgSanitizer();
  const pages = svgs.map(
    (svg) => `<section>${sanitizer.sanitize(svg, { borderMm: 0 }).svg}</section>`,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page {size: A4 portrait; margin: 20mm;}
    * {box-sizing:border-box} html,body {margin:0;padding:0;background:white}
    section {width:170mm;height:256mm;display:flex;align-items:center;justify-content:center;break-after: page;break-inside:avoid}
    section:last-child {break-after:auto} svg {max-width:100%;max-height:100%;width:100%;height:auto}
  </style></head><body>${pages.join("")}</body></html>`;
}
