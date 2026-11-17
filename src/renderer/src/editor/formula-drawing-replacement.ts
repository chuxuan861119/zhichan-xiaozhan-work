import type { ChemicalPreviewAssetDescriptor } from "../../../shared/document/model";
import type { ReplacementPreview } from "../shared/figure-replacement-dialog";
import type { FormulaDrawingRequest } from "./formula-drawing-request";

export type FormulaDrawingReplacement = {
  png: Uint8Array;
  outputWidthMm: number;
  descriptor?: ChemicalPreviewAssetDescriptor;
};

/** The exact rendered bytes are used for both the comparison and the replacement. */
export async function renderFormulaDrawingReplacement(
  sessionId: string,
  request: FormulaDrawingRequest,
  outputWidthMm: number,
): Promise<ReplacementPreview<FormulaDrawingReplacement>> {
  let value: FormulaDrawingReplacement;
  if (request.kind === "chemical-structure") {
    if (!request.svg) throw new Error("结构式源图不可用，请返回结构式编辑器重新生成。");
    const result = await window.patentApi.chemistry.rasterizePreview({
      sessionId,
      svg: request.svg,
      ...(request.source ? { source: request.source } : {}),
      outputWidthMm,
    });
    if (!result.ok) throw new Error(result.error.message);
    value = { png: result.value.preview, descriptor: result.value.descriptor, outputWidthMm };
  } else {
    const result = await window.patentApi.formulaDrawings.render({
      sessionId,
      latex: request.latex,
      outputWidthMm,
    });
    if (!result.ok) throw new Error(result.error.message);
    value = { png: result.value.png, outputWidthMm };
  }
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(value.png).buffer], { type: "image/png" }),
  );
  return {
    url,
    value,
    outputWidthMm,
    note: "按原图宽度生成清晰成图，与实际替换内容一致",
    dispose: () => URL.revokeObjectURL(url),
  };
}
