import type { PatentApi } from "../../../shared/ipc/contract.js";
import type { AppResult } from "../../../shared/ipc/result.js";
import { isHarmonyPlatform } from "../../../shared/platform.js";

export async function requestApplicationExit(
  application: Pick<PatentApi["application"], "requestQuit">,
  closeWindow: () => void,
  platform?: string,
): Promise<AppResult<void>> {
  if (isHarmonyPlatform(platform)) {
    if (!application.requestQuit) throw new Error("Protected application quit is unavailable");
    return application.requestQuit();
  }
  closeWindow();
  return { ok: true, value: undefined };
}
