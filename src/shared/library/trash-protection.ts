export const PATENT_TRASH_PROTECTION_MS = 24 * 60 * 60 * 1000;

export function canPermanentlyDeletePatent(deletedAt: string | null, now = Date.now()): boolean {
  const deleted = deletedAt === null ? Number.NaN : Date.parse(deletedAt);
  return Number.isFinite(deleted) && now - deleted >= PATENT_TRASH_PROTECTION_MS;
}
