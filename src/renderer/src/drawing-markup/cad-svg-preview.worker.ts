import { DOMParser as XmlDomParser, XMLSerializer as XmlSerializer } from "@xmldom/xmldom";
import type { CadSvgPreviewRequest } from "./cad-svg-preview-client";
import { prepareSvgPreview } from "./fixed-line-preview";

const xml = {
  parse: (source: string) =>
    new XmlDomParser().parseFromString(source, "image/svg+xml") as unknown as Document,
  serialize: (node: Node) => new XmlSerializer().serializeToString(node as never),
};
const sources = new Map<string, ReturnType<typeof prepareSvgPreview>>();

function prepared(request: CadSvgPreviewRequest) {
  const key = `${request.sourceId}:${request.project.width}:${request.project.height}`;
  let draw = sources.get(key);
  if (!draw) {
    if (!request.bytes) return null;
    draw = prepareSvgPreview(request.bytes, request.project, xml);
    sources.set(key, draw);
    if (sources.size > 8) sources.delete(sources.keys().next().value!);
  } else {
    sources.delete(key);
    sources.set(key, draw);
  }
  return draw;
}

self.onmessage = (event: MessageEvent<CadSvgPreviewRequest>) => {
  const request = event.data;
  try {
    const draw = prepared(request);
    if (!draw) {
      self.postMessage({ id: request.id, needsSource: true });
      return;
    }
    if (request.kind === "prepare") {
      self.postMessage({ id: request.id, supportsScreenStrokes: draw.supportsScreenStrokes });
      return;
    }
    if (!request.geometry) throw new Error("CAD preview viewport is missing");
    const svg = draw(
      request.geometry,
      request.screenStrokes,
      request.screenPixelScale,
      request.screenStrokeWidth,
    );
    // Blob serialization shares immutable data; construct it off the UI thread.
    self.postMessage({ id: request.id, blob: new Blob([svg], { type: "image/svg+xml" }) });
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : "CAD preview failed",
    });
  }
};
