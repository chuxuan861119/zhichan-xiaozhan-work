import { z } from "zod";
import { TabletWindowStateSchema } from "../../shared/ipc/contract.js";
import { AppOperationError } from "../app-operation-error.js";

export type HarmonyBridge = {
  callArkTSFunction?: (name: string, returnType: string, args: unknown[]) => unknown;
};

/** Only the main process calls fixed, reviewed native bindings. */
export function createHarmonySystem(bridge: HarmonyBridge, timeoutMs = 15_000) {
  function call(name: string, args: unknown[]): void {
    if (typeof bridge.callArkTSFunction !== "function") throw new Error("鸿蒙系统接口不可用。");
    bridge.callArkTSFunction(name, "void", args);
  }
  function response<T>(name: string, args: unknown[], schema: z.ZodType<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error("鸿蒙系统请求超时，请重试。"));
      }, timeoutMs);
      const callback = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parsed = schema.safeParse(value);
        if (parsed.success) resolve(parsed.data);
        else reject(new Error("鸿蒙系统返回值无效。"));
      };
      try {
        call(name, [...args, callback]);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  return {
    async readTabletWindow() {
      const value = await response("Workbench.ReadTabletWindow", [], z.string());
      return TabletWindowStateSchema.parse(JSON.parse(value));
    },
    async setTabletFocusMode(enabled: boolean) {
      const value = await response("Workbench.SetTabletFocus", [enabled], z.string());
      const result = JSON.parse(value);
      if (result?.error) throw new Error("无法切换平板专注模式，请退出系统分屏后重试。");
      return TabletWindowStateSchema.parse(result);
    },
    async readUsageActivity() {
      const value = await response("Workbench.ReadUsageActivity", [], z.string());
      return z
        .object({ active: z.boolean(), locked: z.boolean() })
        .strict()
        .parse(JSON.parse(value));
    },
    async readStartup() {
      const value = await response("Workbench.ReadStartup", [], z.string());
      const result = z
        .object({ ok: z.boolean(), enabled: z.boolean() })
        .strict()
        .parse(JSON.parse(value));
      if (!result.ok) throw new Error("无法读取系统启动状态，请检查系统设置后重试。");
      return result.enabled;
    },
    async openStartupSettings() {
      const code = await response("Workbench.OpenStartupSettings", [], z.number().int());
      if (code !== 0) throw new Error("系统设置未能打开，请从鸿蒙设置检查应用启动权限。");
    },
    async requireClipboardAccess() {
      const result = await response(
        "PermissionManagerAdapter.RequestPermissionCode",
        ["pasteboard"],
        z.number(),
      );
      if (result !== 0)
        throw new AppOperationError({ code: "CLIPBOARD_PERMISSION_DENIED", message: "denied" });
    },
    async restoreFileAccess() {
      const value = await response("Workbench.RestoreFileAccess", [], z.string());
      return z
        .object({
          restored: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
        })
        .strict()
        .parse(JSON.parse(value));
    },
    async persistOpenedFile(uri: string) {
      const code = await response("Workbench.PersistOpenedFile", [uri], z.number().int());
      if (code !== 0)
        throw Object.assign(new Error("外部文件授权失败，请从应用中重新选择文件。"), {
          code: "NO_PERMISSION",
        });
    },
  };
}
