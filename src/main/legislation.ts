import { readFile } from "node:fs/promises";
import { dialog, shell } from "electron";
import guidePath from "../renderer/src/legislation/assets/guidelines-2025.pdf?asset";
import { LEGISLATION, LegislationActionSchema } from "../shared/legislation.js";
import { legislationParagraphs } from "../shared/legislation-text.js";
import { writeExportFile } from "./platform/atomic-export-write.js";

export async function performLegislationAction(input: unknown): Promise<void> {
  const request = LegislationActionSchema.parse(input);
  const item = LEGISLATION.find((item) => item.id === request.id)!;
  if (request.action === "source") {
    await shell.openExternal(item.source);
    return;
  }
  const isPdf = request.id === "guidelines";
  const extension = isPdf ? "pdf" : "txt";
  const result = await dialog.showSaveDialog({
    title: "保存法规副本",
    defaultPath: `${item.title}（${item.version}）.${extension}`,
    filters: [{ name: isPdf ? "PDF 原文" : "纯文本", extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return;
  const bytes = isPdf
    ? await readFile(guidePath)
    : Buffer.from(
        `\ufeff${item.title}\r\n${item.version}\r\n来源：${item.source}\r\n${"note" in item && item.note ? `阅读提示（非原文）：${item.note}\r\n` : ""}\r\n${legislationParagraphs(request.id).join("\r\n\r\n")}`,
        "utf8",
      );
  await writeExportFile(result.filePath, bytes);
}
