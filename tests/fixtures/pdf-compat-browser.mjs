import { pdfDocument } from "../../src/renderer/src/drawing-markup/render";
import { createPdfPageRenderer } from "../../src/renderer/src/exports/pdf-page-renderer";

window.pdfCompat = { createPdfPageRenderer, pdfDocument };
