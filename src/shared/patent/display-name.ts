export function patentDisplayName(patent: { name: string | null; createdAt: string }): string {
  if (patent.name !== null) return patent.name;
  const created = new Date(patent.createdAt);
  const digits = [
    created.getFullYear(),
    created.getMonth() + 1,
    created.getDate(),
    created.getHours(),
    created.getMinutes(),
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join("");
  return `未命名专利 ${digits}`;
}
