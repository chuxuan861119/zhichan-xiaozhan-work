import { describe, expect, test } from "vitest";
import {
  createJpegPdf,
  getFlowchartExportExtension,
  getFlowchartExportMediaType,
  prepareFlowchartExport,
} from "./flowchart-download";

describe("flowchart computer exports", () => {
  test("sends SVG pages to the native vector PDF renderer", async () => {
    const renderPdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70, 45]));
    const svg = `data:image/svg+xml,${encodeURIComponent("<svg/>")}`;
    const result = await prepareFlowchartExport(svg, "pdf", { renderPdf });
    expect(renderPdf).toHaveBeenCalledWith(["<svg/>"]);
    expect(result).toEqual(new Uint8Array([37, 80, 68, 70, 45]));
  });
  test.each([
    ["drawio", "application/xml"],
    ["svg", "image/svg+xml"],
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["pdf", "application/pdf"],
  ] as const)("uses the real media type for %s", (format, mediaType) => {
    expect(getFlowchartExportMediaType(format)).toBe(mediaType);
  });

  test("uses the familiar .jpg extension for JPEG data", () => {
    expect(getFlowchartExportExtension("jpeg")).toBe("jpg");
  });

  test("creates a real single-page PDF around the rendered JPEG", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = createJpegPdf(jpeg, 640, 480);
    const header = new TextDecoder().decode(pdf.slice(0, 8));
    const body = new TextDecoder("latin1").decode(pdf);

    expect(header).toBe("%PDF-1.7");
    expect(body).toContain("/Subtype /Image");
    expect(body).toContain("/Filter /DCTDecode");
    expect(body).toContain("/Width 640 /Height 480");
    expect(body).toContain("startxref");
    expect(Array.from(pdf)).toContain(0xd8);
  });
});
