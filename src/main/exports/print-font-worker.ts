import { parentPort } from "node:worker_threads";
import { withBundledPrintFonts } from "./platform-print-fonts.js";

parentPort?.on(
  "message",
  ({ id, html, platform }: { id: number; html: string; platform: string }) => {
    try {
      parentPort?.postMessage({ id, html: withBundledPrintFonts(html, platform) });
    } catch (error) {
      parentPort?.postMessage({
        id,
        error: error instanceof Error ? error.message : "打印字体处理失败。",
      });
    }
  },
);
