import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

export type BackupNameInfo = {
  documentType: "patent" | "library_document";
  documentId: string;
  displayName: string;
  revision: number;
  createdAt?: string | undefined;
  patentType?: "invention" | "utility-model" | undefined;
  customer?: string | null | undefined;
};
const legacyPattern =
  /^PWB-AUTO-(PAT|DOC)-([0-9a-f-]+)-r(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.patdoc$/i;
const modernPattern = /_PWB2-(PAT|DOC)-([0-9a-f]{12})-r(\d+)-([0-9a-f]{8})\.patdoc$/i;
const fingerprint = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 12);
const pad = (value: number) => String(value).padStart(2, "0");
function safeLabel(value: string, max: number): string {
  return (
    Array.from(
      value
        .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
        .replace(/\.{2,}/gu, "_")
        .trim(),
    )
      .slice(0, max)
      .join("")
      .replace(/[. ]+$/u, "") || "未命名"
  );
}
export function backupRelativeName(
  info: BackupNameInfo,
  time: Date,
  token = randomUUID().slice(0, 8),
): string {
  const kind = info.documentType === "patent" ? "PAT" : "DOC";
  const created = info.createdAt ? new Date(info.createdAt) : null;
  if (!created || !Number.isFinite(created.getTime())) {
    return `PWB-AUTO-${kind}-${info.documentId}-r${info.revision}-${randomUUID()}.patdoc`;
  }
  const month = `${created.getFullYear()}-${pad(created.getMonth() + 1)}`;
  const date = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}_${pad(time.getHours())}-${pad(time.getMinutes())}`;
  const type =
    info.documentType !== "patent"
      ? "文档"
      : info.patentType === "utility-model"
        ? "实用新型"
        : info.patentType === "invention"
          ? "发明"
          : "专利";
  const customer = info.customer?.trim() ? `_${safeLabel(info.customer, 24)}` : "";
  return `${month}/${date}_${type}_${safeLabel(info.displayName, 48)}${customer}_PWB2-${kind}-${fingerprint(info.documentId)}-r${info.revision}-${token}.patdoc`;
}
export function managedBackupIdentity(
  name: string,
  info?: Pick<BackupNameInfo, "documentType" | "documentId" | "revision">,
): boolean {
  const leaf = basename(name);
  const legacy = legacyPattern.exec(leaf);
  const modern = modernPattern.exec(leaf);
  const match = legacy ?? modern;
  if (!match) return false;
  if (!info) return true;
  return (
    match[1] === (info.documentType === "patent" ? "PAT" : "DOC") &&
    match[2] === (legacy ? info.documentId : fingerprint(info.documentId)) &&
    Number(match[3]) === info.revision
  );
}
export function backupNameToken(name: string): string | undefined {
  return modernPattern.exec(basename(name))?.[4];
}
