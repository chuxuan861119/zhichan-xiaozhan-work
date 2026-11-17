import type { LibraryPatentSummary } from "../../../shared/library/model";

export type PatentLibraryMonthGroup = Readonly<{
  key: string;
  label: string;
  patents: readonly LibraryPatentSummary[];
  defaultExpanded: boolean;
}>;

type MonthKey = Readonly<{
  key: string;
  label: string;
}>;

function monthKey(value: Date): MonthKey {
  const year = value.getFullYear();
  const month = value.getMonth() + 1;
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    label: `${year}年${month}月`,
  };
}

function defaultExpandedMonthKeys(now: Date): ReadonlySet<string> {
  const current = monthKey(now).key;
  const previous = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)).key;
  return new Set([current, previous]);
}

export function buildPatentLibraryGroups(
  patents: readonly LibraryPatentSummary[],
  now: Date,
  filtered: boolean,
): readonly PatentLibraryMonthGroup[] {
  const byMonth = new Map<string, { label: string; patents: LibraryPatentSummary[] }>();
  for (const patent of patents) {
    const createdAt = new Date(patent.createdAt);
    const month = monthKey(createdAt);
    const group = byMonth.get(month.key);
    if (group) group.patents.push(patent);
    else byMonth.set(month.key, { label: month.label, patents: [patent] });
  }

  const defaultExpandedKeys = defaultExpandedMonthKeys(now);
  return [...byMonth.entries()]
    .toSorted(([left], [right]) => right.localeCompare(left))
    .map(([key, group]) => ({
      key,
      label: group.label,
      patents: group.patents.toSorted((left, right) => {
        const timestampDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        return timestampDifference !== 0
          ? timestampDifference
          : left.patentId.localeCompare(right.patentId);
      }),
      defaultExpanded: filtered || defaultExpandedKeys.has(key),
    }));
}
