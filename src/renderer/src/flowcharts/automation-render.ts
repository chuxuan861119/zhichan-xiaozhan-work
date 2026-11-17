import type {
  AutomationGraphicRequest,
  AutomationGraphicResult,
} from "../../../shared/automation/graphics";
import { DrawioFrameMessageSchema } from "../../../shared/flowcharts/bridge";
import { DRAWIO_FRAME_ORIGIN, DrawioFrameBridge } from "./drawio-frame-bridge";

export async function renderAutomationFlowchart(
  request: Extract<AutomationGraphicRequest, { kind: "flowchart" }>,
): Promise<AutomationGraphicResult> {
  const iframe = document.createElement("iframe");
  iframe.width = "1024";
  iframe.height = "768";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  const context = {
    sessionId: "automation-render",
    projectId: request.projectId,
    projectRevision: request.projectRevision,
  };
  const bridge = new DrawioFrameBridge(iframe, context, { timeoutMs: 45_000 });
  let receive: (event: MessageEvent<unknown>) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pageId = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("流程图加载超时")), 45_000);
      receive = (event) => {
        if (event.origin !== DRAWIO_FRAME_ORIGIN || event.source !== iframe.contentWindow) return;
        const parsed = DrawioFrameMessageSchema.safeParse(event.data);
        if (!parsed.success) return;
        const message = parsed.data;
        if (
          message.sessionId !== context.sessionId ||
          message.projectId !== context.projectId ||
          message.projectRevision !== context.projectRevision
        )
          return;
        if (message.type === "error") reject(new Error("流程图加载失败"));
        if (message.type === "ready") {
          const page = message.pages[request.pageIndex];
          if (!page) reject(new Error("流程图页码超出范围"));
          else resolve(page.id);
        }
      };
      window.addEventListener("message", receive);
      iframe.onload = () => {
        try {
          bridge.configure();
          const bytes = Uint8Array.from(atob(request.source), (c) => c.charCodeAt(0));
          bridge.load(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch (error) {
          reject(error);
        }
      };
      iframe.src = `${DRAWIO_FRAME_ORIGIN}/adapter.html`;
      document.body.append(iframe);
    });
    clearTimeout(timer);
    window.removeEventListener("message", receive);
    const data = await bridge.requestExport({
      format: "svg",
      pageId,
      selectionOnly: request.selectedCellIds.length > 0,
      ...(request.selectedCellIds.length ? { selectedCellIds: request.selectedCellIds } : {}),
    });
    let svg = data;
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",");
      if (comma < 0 || !data.slice(0, comma).startsWith("data:image/svg+xml"))
        throw new Error("流程图格式无效");
      svg = data.slice(0, comma).includes(";base64")
        ? new TextDecoder().decode(
            Uint8Array.from(atob(data.slice(comma + 1)), (c) => c.charCodeAt(0)),
          )
        : decodeURIComponent(data.slice(comma + 1));
    }
    // Do not mount exported markup: the main process sanitizes and rasterizes it.
    const dom = new DOMParser().parseFromString(svg, "image/svg+xml");
    const viewBox = (dom.documentElement.getAttribute("viewBox") ?? "")
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    const width = Math.ceil(
      viewBox[2] ?? Number.parseFloat(dom.documentElement.getAttribute("width") ?? ""),
    );
    const height = Math.ceil(
      viewBox[3] ?? Number.parseFloat(dom.documentElement.getAttribute("height") ?? ""),
    );
    const bytes = new TextEncoder().encode(svg);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { data: btoa(binary), width, height, mediaType: "image/svg+xml", pageId };
  } finally {
    clearTimeout(timer);
    window.removeEventListener("message", receive);
    bridge.dispose();
    iframe.remove();
  }
}
