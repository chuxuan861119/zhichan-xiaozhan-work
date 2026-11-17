import type { PrintPageRange } from "./model.js";

export type PageRangeSelection =
  | { mode: "all" }
  | { mode: "current" }
  | { mode: "custom"; source: string };

export type ResolvePageRangesResult =
  | { ok: true; pageRanges: PrintPageRange[] | undefined }
  | { ok: false; error: string };

const CUSTOM_RANGE_SEGMENT_PATTERN = /^\d+(?:-\d+)?$/u;

function validateTotalPages(totalPages: number): string | null {
  if (!Number.isInteger(totalPages) || totalPages < 1) return "总页数无效。";

  return null;
}

function validateOneBasedPage(page: number, totalPages: number, label: string): string | null {
  if (!Number.isInteger(page)) return `${label}必须是整数。`;
  if (page < 1) return "页码必须从 1 开始。";
  if (page > totalPages) return `页码不能超过总页数 ${totalPages}。`;

  return null;
}

function mergePageRanges(ranges: PrintPageRange[]): PrintPageRange[] {
  const sortedRanges = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
  const mergedRanges: PrintPageRange[] = [];

  for (const range of sortedRanges) {
    const lastRange = mergedRanges.at(-1);

    if (lastRange && range.from <= lastRange.to + 1) {
      lastRange.to = Math.max(lastRange.to, range.to);
      continue;
    }

    mergedRanges.push({ ...range });
  }

  return mergedRanges;
}

function resolveCustomPageRanges(source: string, totalPages: number): ResolvePageRangesResult {
  const compactSource = source.replace(/\s+/gu, "");
  if (compactSource.length === 0) return { ok: false, error: "请输入页码范围。" };

  const ranges: PrintPageRange[] = [];
  for (const segment of compactSource.split(",")) {
    if (segment.length === 0) {
      return { ok: false, error: "页码范围包含空片段，请检查逗号。" };
    }

    if (!CUSTOM_RANGE_SEGMENT_PATTERN.test(segment)) {
      return { ok: false, error: "页码范围只能包含数字、逗号和短横线。" };
    }

    const [startSource, endSource] = segment.split("-");
    const startPage = Number(startSource);
    const endPage = endSource === undefined ? startPage : Number(endSource);

    const startError = validateOneBasedPage(startPage, totalPages, "起始页");
    if (startError) return { ok: false, error: startError };

    const endError = validateOneBasedPage(endPage, totalPages, "结束页");
    if (endError) return { ok: false, error: endError };

    if (endPage < startPage) {
      return { ok: false, error: "结束页不能小于起始页。" };
    }

    ranges.push({ from: startPage - 1, to: endPage - 1 });
  }

  return { ok: true, pageRanges: mergePageRanges(ranges) };
}

export function resolvePageRanges(
  selection: PageRangeSelection,
  currentPage: number,
  totalPages: number,
): ResolvePageRangesResult {
  try {
    const totalPagesError = validateTotalPages(totalPages);
    if (totalPagesError) return { ok: false, error: totalPagesError };

    switch (selection.mode) {
      case "all":
        return { ok: true, pageRanges: undefined };
      case "current": {
        const currentPageError = validateOneBasedPage(currentPage, totalPages, "当前页");
        if (currentPageError) return { ok: false, error: currentPageError };

        return { ok: true, pageRanges: [{ from: currentPage - 1, to: currentPage - 1 }] };
      }
      case "custom":
        return resolveCustomPageRanges(selection.source, totalPages);
      default:
        return { ok: false, error: "未知的页码范围模式。" };
    }
  } catch {
    return { ok: false, error: "页码范围解析失败，请检查输入。" };
  }
}
