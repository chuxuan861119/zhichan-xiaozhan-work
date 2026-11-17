import { FlowchartPdfRequestSchema } from "../../shared/ipc/contract.js";
import { buildFlowchartPdfHtml } from "./flowchart-pdf.js";

test("keeps SVG paths and text as vectors and gives each drawing its own printed page", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0 L100 50" stroke="black"/><text x="5" y="20">R1</text></svg>';
  const html = buildFlowchartPdfHtml([svg, svg]);
  expect(html.match(/<svg /g)).toHaveLength(2);
  expect(html).toContain("break-after: page");
  expect(html).toContain("<text");
  expect(html).not.toContain("image/jpeg");
});
test("rejects scripts and external resources before PDF rendering", () => {
  expect(() =>
    buildFlowchartPdfHtml([
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ]),
  ).toThrow();
  expect(() =>
    buildFlowchartPdfHtml([
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/a.png"/></svg>',
    ]),
  ).toThrow();
});
test("requires an active session identity and a nonempty bounded page list", () => {
  expect(FlowchartPdfRequestSchema.safeParse({ svgs: [] }).success).toBe(false);
});
