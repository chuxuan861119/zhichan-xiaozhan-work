import type {
  AutomationGraphicFailure,
  AutomationGraphicRequest,
  AutomationGraphicResult,
} from "../../shared/automation/graphics";
import { pdfPreview, renderDrawing } from "./drawing-markup/render";
import { renderAutomationFlowchart } from "./flowcharts/automation-render";

declare global {
  interface Window {
    automationRender(
      request: AutomationGraphicRequest,
    ): Promise<AutomationGraphicResult | AutomationGraphicFailure>;
    automationTiles?: { readTile(id: string): Promise<Uint8Array> };
  }
}
async function encode(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("图片编码失败"));
    reader.readAsDataURL(new Blob([Uint8Array.from(bytes)]));
  });
}
window.automationRender = async (request) => {
  if (request.kind === "flowchart") return renderAutomationFlowchart(request);
  const bytes = Uint8Array.from(atob(request.source), (value) => value.charCodeAt(0));
  if (request.kind === "pdf-preview") {
    const rendered = await pdfPreview(bytes, request.pageNumber);
    return {
      data: await encode(rendered.bytes),
      width: rendered.width,
      height: rendered.height,
      totalPages: rendered.totalPages,
      mediaType: "image/png",
    };
  }
  try {
    const rendered = await renderDrawing(
      request.project,
      request.region,
      bytes,
      request.mediaType,
      request.widthMm,
      request.dpi,
      {
        autoAdjustLabelSize: request.autoAdjustLabelSize,
        // Automation receives the stored patent-preview asset, whose CAD label
        // proxies are hidden; the raster composer must paint semantic labels.
        nativeLabelsRemoved: Boolean(request.project.cad?.unified),
        autoLabelScale: request.autoLabelScale ?? 1,
        readCadDetail: async (assetId: string) => {
          const encoded = request.frozenCadSources?.[assetId];
          if (!encoded) throw new Error("局部放大冻结图形未加载。");
          return Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
        },
        ...(request.fitToPage ? { fitToPage: request.fitToPage } : {}),
        ...(request.tiledIndex
          ? {
              tiled: { sessionId: "", assetId: "", index: request.tiledIndex, overviewUrl: "" },
              readTile: (id: string) => {
                if (!window.automationTiles) throw new Error("分块图纸读取服务不可用。");
                return window.automationTiles.readTile(id);
              },
            }
          : {}),
      },
    );
    return {
      data: await encode(rendered.bytes),
      width: rendered.width,
      height: rendered.height,
      mediaType: "image/jpeg",
      outputWidthMm: rendered.widthMm,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "图纸生成失败，请检查选区后重试。" };
  }
};
