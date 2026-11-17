import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../../shared/ipc/result";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { canPermanentlyDeletePatent } from "../../../shared/library/trash-protection";
import { TRASH_RETENTION_MS } from "../../../shared/library/trash-retention";
import { patentDisplayName } from "../../../shared/patent/display-name";
import { confirmAppAction } from "../shared/app-dialog";
import { StandardDialog } from "../shared/standard-dialog";
import { useLibraryListMotion } from "./use-library-list-motion";
import "./trash-dialog.css";

type TrashItem =
  | { key: string; title: string; kind: "patent"; value: LibraryPatentSummary }
  | { key: string; title: string; kind: "document"; value: LibraryDocumentSummary };
type Props = {
  documents: LibraryDocumentSummary[];
  patents: LibraryPatentSummary[];
  loading: boolean;
  error: AppError | null;
  onRetry(): void;
  onClose(): void;
  onRestoreDocument(item: LibraryDocumentSummary): Promise<boolean>;
  onRestorePatent(item: LibraryPatentSummary): Promise<boolean>;
  onDeleteDocument(item: LibraryDocumentSummary): Promise<boolean>;
  onDeletePatent(item: LibraryPatentSummary): Promise<boolean>;
};
const DAY = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 10;
type SortField = "name" | "type" | "deleted" | "retention";
const titleCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
function typeLabel(item: TrashItem) {
  return item.kind === "document"
    ? "文档"
    : item.value.patentType === "invention"
      ? "发明"
      : "实用新型";
}
function deletedTime(item: TrashItem) {
  return item.value.deletedAt ? Date.parse(item.value.deletedAt) : Number.NaN;
}
function dateLabel(time: number) {
  return Number.isFinite(time)
    ? new Date(time).toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "待确认";
}
function itemDescription(item: TrashItem) {
  if (item.value.recoveryState === "quarantined") return "已保护性隔离，内容状态暂不可读取。";
  if (item.kind === "document") return item.value.snippet || "暂无正文摘要。";
  return null;
}
export function TrashDialog({
  documents,
  patents,
  loading,
  error,
  onRetry,
  onClose,
  onRestoreDocument,
  onRestorePatent,
  onDeleteDocument,
  onDeletePatent,
}: Props) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const deferredQuery = useDeferredValue(normalizedQuery);
  const [sort, setSort] = useState<{ field: SortField; descending: boolean }>({
    field: "deleted",
    descending: true,
  });
  const items = useMemo(
    () =>
      (
        [
          ...patents.map((value) => ({
            key: `patent:${value.patentId}`,
            title: patentDisplayName(value),
            kind: "patent" as const,
            value,
          })),
          ...documents.map((value) => ({
            key: `document:${value.libraryDocumentId}`,
            title: value.title,
            kind: "document" as const,
            value,
          })),
        ] satisfies TrashItem[]
      ).map((item, order) => ({
        ...item,
        order,
        searchTitle: item.title.toLocaleLowerCase(),
        time: deletedTime(item),
        type: typeLabel(item),
      })),
    [patents, documents],
  );
  const filteredItems = useMemo(
    () =>
      items
        .filter((item) => item.searchTitle.includes(deferredQuery))
        .sort((a, b) => {
          let comparison: number;
          if (sort.field === "name" || sort.field === "type") {
            comparison = titleCollator.compare(
              sort.field === "name" ? a.title : a.type,
              sort.field === "name" ? b.title : b.type,
            );
          } else {
            if (!Number.isFinite(a.time) || !Number.isFinite(b.time)) {
              if (Number.isFinite(a.time)) return -1;
              if (Number.isFinite(b.time)) return 1;
              return a.order - b.order;
            }
            comparison = a.time - b.time;
          }
          return (sort.descending ? -comparison : comparison) || a.order - b.order;
        }),
    [items, deferredQuery, sort],
  );
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const [pageInput, setPageInput] = useState("1");
  const visibleItems = filteredItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const wasBusyRef = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLTableSectionElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const keys = useMemo(() => items.map((item) => item.key).join("|"), [items]);
  const captureLayout = useLibraryListMotion(listRef, keys);
  const selectedKeySet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selected = useMemo(
    () => filteredItems.filter((item) => selectedKeySet.has(item.key)),
    [filteredItems, selectedKeySet],
  );
  const protectedItems = selected.filter(
    (item) => item.kind === "patent" && !canPermanentlyDeletePatent(item.value.deletedAt, now),
  );
  const selectedOnPage = visibleItems.filter((item) => selectedKeySet.has(item.key));
  const allSelected = visibleItems.length > 0 && selectedOnPage.length === visibleItems.length;
  useEffect(() => {
    setPage(currentPage);
    setPageInput(String(currentPage));
    if (listContainerRef.current) listContainerRef.current.scrollTop = 0;
  }, [currentPage]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const available = new Set(keys.split("|"));
    setSelectedKeys((previous) => previous.filter((key) => available.has(key)));
  }, [keys]);
  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = selectedOnPage.length > 0 && !allSelected;
  }, [selectedOnPage.length, allSelected]);
  useEffect(() => {
    if (busy) wasBusyRef.current = true;
    else if (wasBusyRef.current) {
      wasBusyRef.current = false;
      const target = restoreRef.current?.disabled ? closeRef.current : restoreRef.current;
      target?.focus({ preventScroll: true });
    }
  }, [busy]);
  const toggle = (key: string) => {
    if (busyRef.current || loading || error || normalizedQuery !== deferredQuery) return;
    setSelectedKeys((previous) =>
      previous.includes(key) ? previous.filter((value) => value !== key) : [...previous, key],
    );
    setMessage("");
    setFailed(false);
  };
  const operate = async (action: "restore" | "delete") => {
    if (
      busyRef.current ||
      loading ||
      error ||
      normalizedQuery !== deferredQuery ||
      selected.length === 0
    )
      return;
    if (action === "delete" && protectedItems.length > 0) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    const targets = [...selected];
    let completed = 0;
    try {
      if (action === "delete") {
        setMessage("等待删除确认…");
        const names = targets
          .slice(0, 3)
          .map((item) => `“${item.title}”`)
          .join("、");
        if (
          !(await confirmAppAction(
            `永久删除${names}${targets.length > 3 ? `等 ${targets.length} 项内容` : targets.length > 1 ? `（共 ${targets.length} 项）` : ""}？此操作不可恢复。`,
          ))
        ) {
          setMessage("");
          return;
        }
      }
      for (const target of targets) {
        const current = itemsRef.current.find((item) => item.key === target.key);
        if (!current) continue;
        if (
          action === "delete" &&
          current.kind === "patent" &&
          !canPermanentlyDeletePatent(current.value.deletedAt, Date.now())
        )
          throw new Error("protected");
        setMessage(
          `正在${action === "restore" ? "恢复" : "删除"} ${completed + 1} / ${targets.length} 项…`,
        );
        captureLayout();
        const result =
          current.kind === "patent"
            ? await (action === "restore" ? onRestorePatent : onDeletePatent)(current.value)
            : await (action === "restore" ? onRestoreDocument : onDeleteDocument)(current.value);
        if (!result) throw new Error("operation-failed");
        completed++;
        setSelectedKeys((previous) => previous.filter((key) => key !== current.key));
      }
      setMessage(
        completed
          ? `已${action === "restore" ? "恢复" : "永久删除"} ${completed} 项${action === "restore" ? "，可在专利库中查看" : ""}。`
          : "所选内容已发生变化，请重新选择。",
      );
    } catch {
      setFailed(true);
      setMessage(
        `${completed ? `已${action === "restore" ? "恢复" : "删除"} ${completed} 项。` : ""}其余内容未处理，请检查提示后重试。`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const locked = busy || loading || Boolean(error) || normalizedQuery !== deferredQuery;
  const changeQuery = (value: string) => {
    setQuery(value);
    setSelectedKeys([]);
    setPage(1);
    setMessage("");
    setFailed(false);
    if (listContainerRef.current) listContainerRef.current.scrollTop = 0;
  };
  const sortHeader = (field: SortField, label: string) => {
    const active = sort.field === field;
    const nextDescending = active ? !sort.descending : field === "deleted";
    const Icon = active ? (sort.descending ? ArrowDown : ArrowUp) : ArrowUpDown;
    return (
      <button
        type="button"
        className="trash-dialog__sort"
        aria-label={`按${label}排序`}
        title={`${label}：点击${nextDescending ? "降序" : "升序"}排序`}
        disabled={locked}
        onClick={() => {
          setSort({ field, descending: nextDescending });
          setPage(1);
          if (listContainerRef.current) listContainerRef.current.scrollTop = 0;
        }}
      >
        {label}
        <Icon size={12} aria-hidden="true" />
      </button>
    );
  };
  const ariaSort = (field: SortField) =>
    sort.field === field
      ? sort.descending
        ? ("descending" as const)
        : ("ascending" as const)
      : ("none" as const);
  const jumpToPage = () => {
    if (locked) return;
    const requested = /^\d+$/.test(pageInput) ? Number(pageInput) : currentPage;
    const next = Math.max(1, Math.min(pageCount, requested));
    setPage(next);
    setPageInput(String(next));
  };
  return (
    <StandardDialog
      open
      title="回收站"
      titleSuffix={
        <>
          <span className="trash-dialog__count" aria-hidden="true">
            {normalizedQuery ? `${filteredItems.length} / ${items.length}` : items.length} 项
          </span>
          <span className="trash-dialog__retention-note" aria-hidden="true">
            保留 1 年（365 天），过期后自动清理。
          </span>
        </>
      }
      headerActions={
        <div className="trash-dialog__search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            aria-label="搜索回收站题目"
            placeholder="搜索回收站"
            value={query}
            disabled={busy || loading || Boolean(error)}
            onChange={(event) => changeQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              aria-label="清空搜索"
              title="清空搜索"
              disabled={busy || loading || Boolean(error)}
              onClick={() => {
                changeQuery("");
                searchRef.current?.focus({ preventScroll: true });
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      }
      size="l"
      portal
      className="trash-dialog"
      bodyClassName="trash-dialog__body"
      onCancel={onClose}
      closeDisabled={busy}
      footer={
        <>
          <div className="trash-dialog__selection">
            {selected.length ? <div>已选择 {selected.length} 项</div> : null}
            <div className="trash-dialog__hint">
              <Info size={15} aria-hidden="true" />
              <span>专利删除后 24 小时内不能永久删除，可随时恢复。</span>
            </div>
          </div>
          <div className="trash-dialog__actions">
            <button
              type="button"
              className="trash-dialog__delete"
              disabled={locked || selected.length === 0 || protectedItems.length > 0}
              onClick={() => void operate("delete")}
            >
              永久删除
            </button>
            <button
              type="button"
              ref={restoreRef}
              className="primary-button trash-dialog__restore"
              disabled={locked || selected.length === 0}
              onClick={() => void operate("restore")}
            >
              <ArchiveRestore size={16} aria-hidden="true" />
              恢复
            </button>
            <button ref={closeRef} type="button" disabled={busy} onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      }
    >
      {loading ? (
        <p className="trash-dialog__notice" role="status">
          正在读取回收站…
        </p>
      ) : null}
      {error ? (
        <div className="trash-dialog__error" role="alert">
          <div>
            <strong>回收站暂时无法读取</strong>
            <p>已保留上次成功读取的结果。{error.message}</p>
          </div>
          <button type="button" disabled={loading || busy} onClick={onRetry}>
            重试读取回收站
          </button>
        </div>
      ) : null}
      {!items.length && !loading && !error ? (
        <div className="trash-dialog__empty">
          <Trash2 size={38} strokeWidth={1.4} aria-hidden="true" />
          <h3>回收站为空</h3>
          <p>删除的内容会保留在这里，方便找回。</p>
        </div>
      ) : null}
      {items.length > 0 && filteredItems.length === 0 && !loading && !error ? (
        <div className="trash-dialog__empty">
          <Search size={32} aria-hidden="true" />
          <h3>未找到匹配的题目</h3>
          <p>请调整关键词，搜索仅匹配题目。</p>
        </div>
      ) : null}
      {filteredItems.length > 0 ? (
        <div
          className="trash-dialog__list"
          ref={listContainerRef}
          aria-busy={normalizedQuery !== deferredQuery}
        >
          <table aria-label="已删除内容">
            <thead>
              <tr>
                <th className="trash-dialog__check">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label={pageCount > 1 ? "全选当前页" : "全选回收站内容"}
                    checked={allSelected}
                    disabled={locked}
                    onChange={() => {
                      const pageKeys = new Set(visibleItems.map((item) => item.key));
                      setSelectedKeys((previous) =>
                        allSelected
                          ? previous.filter((key) => !pageKeys.has(key))
                          : [...new Set([...previous, ...pageKeys])],
                      );
                      setMessage("");
                      setFailed(false);
                    }}
                  />
                </th>
                <th aria-sort={ariaSort("name")}>{sortHeader("name", "名称")}</th>
                <th className="trash-dialog__type" aria-sort={ariaSort("type")}>
                  {sortHeader("type", "类型")}
                </th>
                <th className="trash-dialog__date" aria-sort={ariaSort("deleted")}>
                  {sortHeader("deleted", "删除时间")}
                </th>
                <th className="trash-dialog__retention" aria-sort={ariaSort("retention")}>
                  {sortHeader("retention", "剩余保留")}
                </th>
              </tr>
            </thead>
            <tbody ref={listRef}>
              {visibleItems.map((item) => {
                const time = deletedTime(item);
                const protectedItem =
                  item.kind === "patent" && !canPermanentlyDeletePatent(item.value.deletedAt, now);
                const description = itemDescription(item);
                return (
                  <tr
                    key={item.key}
                    data-library-item-key={item.key}
                    data-selected={selectedKeySet.has(item.key) || undefined}
                    onClick={() => toggle(item.key)}
                  >
                    <td className="trash-dialog__check">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${item.title}`}
                        checked={selectedKeySet.has(item.key)}
                        disabled={locked}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => toggle(item.key)}
                      />
                    </td>
                    <th scope="row">
                      <span className="trash-dialog__name" title={item.title}>
                        {item.title}
                      </span>
                      {description ? (
                        <span className="trash-dialog__description" title={description}>
                          {description}
                        </span>
                      ) : null}
                      <span className="trash-dialog__mobile-date">删除于 {dateLabel(time)}</span>
                    </th>
                    <td className="trash-dialog__type">{item.type}</td>
                    <td className="trash-dialog__date">{dateLabel(time)}</td>
                    <td className="trash-dialog__retention">
                      <span title={`自动清理时间：${dateLabel(time + TRASH_RETENTION_MS)}`}>
                        {Number.isFinite(time)
                          ? `${Math.max(0, Math.ceil((time + TRASH_RETENTION_MS - now) / DAY))} 天`
                          : "待确认"}
                      </span>
                      {protectedItem ? (
                        <span
                          className="trash-dialog__protected"
                          title={
                            Number.isFinite(time)
                              ? `可永久删除时间：${dateLabel(time + DAY)}`
                              : "删除时间无法确认，暂不可永久删除。"
                          }
                        >
                          <ShieldCheck size={14} aria-hidden="true" />
                          {Number.isFinite(time) ? "保护中" : "时间待确认"}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {pageCount > 1 ? (
        <nav className="trash-dialog__pagination" aria-label="回收站分页">
          <span>
            共 {filteredItems.length} 项 · 每页 {PAGE_SIZE} 项
          </span>
          <div className="trash-dialog__page-controls">
            <button
              type="button"
              aria-label="上一页"
              title="上一页"
              disabled={locked || currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <label>
              <span>第</span>
              <input
                aria-label="跳转页码"
                title={`输入 1–${pageCount}，按回车或移出输入框跳转`}
                inputMode="numeric"
                value={pageInput}
                disabled={locked}
                onChange={(event) => setPageInput(event.target.value)}
                onBlur={jumpToPage}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    jumpToPage();
                  }
                }}
              />
              <span>/ {pageCount} 页</span>
            </label>
            <button
              type="button"
              aria-label="下一页"
              title="下一页"
              disabled={locked || currentPage === pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        </nav>
      ) : null}
      <p
        className={`trash-dialog__feedback${failed ? " is-error" : ""}`}
        role={failed ? "alert" : "status"}
        aria-live="polite"
      >
        {message}
      </p>
    </StandardDialog>
  );
}
