import type {
  TemporaryExportResult,
  TemporaryImageApi,
  TemporaryRasterExport,
} from "../../../../shared/ipc/temporary-images";
import { TemporaryLayerProjectSchema } from "../../../../shared/ipc/temporary-images";
import type { KlecksPortIdentity } from "./klecks-command-port";
import type { KlecksFrameClient } from "./klecks-frame-client";

/** Export tickets are never case saved/applied acknowledgements. */
export async function exportKlecksTemporaryRaster(
  identity: KlecksPortIdentity,
  name: string,
  options: TemporaryRasterExport["options"],
  projects: Pick<KlecksFrameClient["projects"], "freeze" | "discard">,
  api: Pick<TemporaryImageApi, "exportRaster">,
): Promise<TemporaryExportResult> {
  const frozen = await projects.freeze(identity);
  try {
    if (!frozen.composite) throw new Error("编辑器未返回合成图片，未导出。");
    const result = await api.exportRaster({
      bytes: Uint8Array.from(frozen.composite),
      suggestedName: name,
      options,
    });
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    await projects.discard(identity, frozen.ticket);
  }
}
export async function exportKlecksTemporaryPsd(
  identity: KlecksPortIdentity,
  name: string,
  projects: Pick<KlecksFrameClient["projects"], "freeze" | "discard">,
  api: Pick<TemporaryImageApi, "exportPsd">,
  density = 72,
): Promise<TemporaryExportResult> {
  const frozen = await projects.freeze(identity);
  try {
    if (!frozen.composite) throw new Error("编辑器未返回合成图片，未导出PSD。");
    const project = TemporaryLayerProjectSchema.parse(frozen.project);
    const result = await api.exportPsd({
      project,
      composite: Uint8Array.from(frozen.composite),
      suggestedName: name,
      density,
    });
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    await projects.discard(identity, frozen.ticket);
  }
}
