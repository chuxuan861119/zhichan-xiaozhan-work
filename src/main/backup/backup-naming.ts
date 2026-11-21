import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

export type BackupNameInfo = {
  documentType: "patent" | "library_document";
  documentId: string;
  displayName: string;
  revision: number;
  createdAt?: string | undefined;
  patentType?: "invention" | "utility-model" | "design" | undefined;
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
  preciseTime = false,
): string {
  const kind = info.documentType === "patent" ? "PAT" : "DOC";
  const created = info.createdAt ? new Date(info.createdAt) : null;
  if (!created || !Number.isFinite(created.getTime())) {
    return `PWB-AUTO-${kind}-${info.documentId}-r${info.revision}-${randomUUID()}.patdoc`;
  }
  const month = `${created.getFullYear()}-${pad(created.getMonth() + 1)}`;
  const date = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}_${pad(time.getHours())}-${pad(time.getMinutes())}${preciseTime ? `-${pad(time.getSeconds())}-${String(time.getMilliseconds()).padStart(3, "0")}` : ""}`;
  const type =
    info.documentType !== "patent"
      ? "文档"
      : info.patentType === "utility-model"
        ? "实用新型"
        : info.patentType === "invention"
          ? "发明"
          : info.patentType === "design"
            ? "外观设计"
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

/** Accept both existing minute names and precise public-storage timestamps. */
export function managedBackupTime(name: string): Date | undefined {
  const leaf = basename(name);
  if (!modernPattern.test(leaf)) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:-(\d{2})-(\d{3}))?_/u.exec(leaf);
  if (!match) return undefined;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const hour = Number(match[4]),
    minute = Number(match[5]);
  const second = Number(match[6] ?? 0),
    millisecond = Number(match[7] ?? 0);
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second &&
    date.getMilliseconds() === millisecond
    ? date
    : undefined;
}
