import { ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ContentSearchBook, ContentSearchState } from "../../../shared/library/content-search";
import { contentSearchText } from "../../../shared/library/content-search-text";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { patentDisplayName } from "../../../shared/patent/display-name";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";

export type ContentSearchTarget = {
  kind: ContentSearchBook["kind"];
  query: string;
  snippet?: string;
  location?: NonNullable<ContentSearchBook["locations"]>[number];
};
export type ContentSearchResultsSnapshot = {
  query: string;
  type: string;
  state: ContentSearchState;
  error: boolean;
  limit: number;
  expandedPatentIds: string[];
  details: Record<
    string,
    {
      books: ContentSearchBook[];
      hasMore: boolean;
      nextOffset: number | null;
    }
  >;
};
const labels: Record<ContentSearchBook["kind"], string> = {
  claims: "权利要求书",
  description: "说明书",
  "description-drawings": "说明书附图",
  abstract: "说明书摘要",
  "abstract-drawing": "摘要附图",
};
export function HighlightSearchText({ text, query }: { text: string; query: string }) {
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (const match of contentSearchText.matches(text, query)) {
    parts.push(
      text.slice(from, match.from),
      <mark key={match.from}>{text.slice(match.from, match.to)}</mark>,
    );
    from = match.to;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
type ResultsProps = {
  query: string;
  patents: LibraryPatentSummary[];
  type: string;
  onOpen: (patent: LibraryPatentSummary, target?: ContentSearchTarget, resultKey?: string) => void;
  selectedResultKey?: string | null;
  snapshot?: ContentSearchResultsSnapshot | null;
  onSnapshotChange?: (snapshot: ContentSearchResultsSnapshot) => void;
  refreshToken?: number;
  onUpdateIndex?: () => void;
};
let searchSequence = 0;
export function ContentSearchResults(props: ResultsProps) {
  return (
    <SearchResultsPage
      key={JSON.stringify([props.query, props.type, props.refreshToken])}
      {...props}
    />
  );
}
function SearchResultsPage({
  query,
  patents,
  type,
  onOpen,
  selectedResultKey,
  snapshot,
  onSnapshotChange,
  onUpdateIndex,
}: ResultsProps) {
  const restoredSnapshot = snapshot?.query === query && snapshot.type === type ? snapshot : null;
  const initialSnapshot = useRef(restoredSnapshot);
  const versionRef = useRef(restoredSnapshot?.state.indexVersion);
  const [state, setState] = useState<ContentSearchState | null>(restoredSnapshot?.state ?? null);
  const [pending, setPending] = useState(!restoredSnapshot);
  const [error, setError] = useState(restoredSnapshot?.error ?? false);
  const [versionChanged, setVersionChanged] = useState(false);
  const [limit, setLimit] = useState(restoredSnapshot?.limit ?? 30);
  const [after, setAfter] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(restoredSnapshot?.expandedPatentIds ?? []),
  );
  const [details, setDetails] = useState(restoredSnapshot?.details ?? {});
  const [detailPending, setDetailPending] = useState<Set<string>>(new Set());
  const [detailErrors, setDetailErrors] = useState<Set<string>>(new Set());
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailEpoch = useRef(0);
  const refreshResults = useCallback(() => {
    initialSnapshot.current = null;
    detailEpoch.current++;
    if (openTimer.current) clearTimeout(openTimer.current);
    setAfter(undefined);
    setDetails({});
    setDetailPending(new Set());
    setDetailErrors(new Set());
    setExpanded(new Set());
    setLimit(30);
    setVersionChanged(false);
    setAttempt((n) => n + 1);
  }, []);
  const sourceFingerprint = JSON.stringify(
    patents.map((p) => [p.patentId, p.revision, p.modifiedAt, p.recoveryState]),
  );
  const previousFingerprint = useRef(sourceFingerprint);
  useEffect(() => {
    if (previousFingerprint.current === sourceFingerprint) return;
    previousFingerprint.current = sourceFingerprint;
    refreshResults();
  }, [sourceFingerprint, refreshResults]);
  useEffect(() => {
    if (pending || error || versionChanged || !state) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await window.patentApi.contentSearch?.request({ action: "status" });
        if (disposed) return;
        if (result?.ok) {
          const status = result.value;
          if (
            state.indexVersion &&
            status.indexVersion &&
            state.indexVersion !== status.indexVersion
          ) {
            setVersionChanged(true);
            return;
          }
          if (state.incomplete !== status.incomplete || state.running !== status.running)
            setState((previous) =>
              previous
                ? { ...previous, incomplete: status.incomplete, running: status.running }
                : previous,
            );
        }
      } catch {
        /* Retain usable results on a transient status failure; retry below. */
      }
      if (!disposed) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [pending, error, versionChanged, state]);
  useEffect(() => {
    const active = new Set(patents.map((patent) => patent.patentId));
    setState((previous) => {
      const hits = previous?.hits?.filter((hit) => active.has(hit.patentId));
      return previous && hits && hits.length !== previous.hits?.length
        ? { ...previous, hits }
        : previous;
    });
    setDetails((previous) => {
      const kept = Object.fromEntries(Object.entries(previous).filter(([id]) => active.has(id)));
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
  }, [patents]);
  useEffect(() => {
    let cancelled = false;
    let started = false;
    const searchId = `library-${++searchSequence}-${attempt}`;
    setPending(true);
    setError(false);
    const timer = setTimeout(async () => {
      try {
        const saved = initialSnapshot.current;
        if (saved && after === undefined && attempt === 0) {
          const status = await window.patentApi.contentSearch?.request({ action: "status" });
          if (cancelled) return;
          if (
            status?.ok &&
            !saved.error &&
            saved.state.indexVersion &&
            saved.state.sourceVersion &&
            saved.state.indexVersion === status.value.indexVersion &&
            saved.state.sourceVersion === status.value.sourceVersion
          )
            return;
          setDetails({});
        }
        started = true;
        const result = await window.patentApi.contentSearch?.request({
          action: "search",
          query,
          after,
          searchId,
          ...(after && versionRef.current ? { indexVersion: versionRef.current } : {}),
          ...(type === "invention" || type === "utility-model" ? { patentType: type } : {}),
        });
        if (cancelled) return;
        if (result?.ok && !result.value.cancelled) {
          if (result.value.versionChanged) {
            setVersionChanged(true);
            return;
          }
          versionRef.current = result.value.indexVersion;
          setVersionChanged(false);
          setError(Boolean(result.value.searchError));
          setState((previous) => ({
            ...result.value,
            hits: after
              ? [
                  ...new Map(
                    [...(previous?.hits ?? []), ...(result.value.hits ?? [])].map((hit) => [
                      hit.patentId,
                      hit,
                    ]),
                  ).values(),
                ]
              : (result.value.hits ?? []),
          }));
        } else setError(true);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setPending(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (started)
        void window.patentApi.contentSearch
          ?.request({ action: "cancel-search", searchId })
          .catch(() => {});
    };
  }, [query, type, after, attempt]);
  useEffect(() => {
    if (!state || pending) return;
    onSnapshotChange?.({
      query,
      type,
      state,
      error,
      limit,
      expandedPatentIds: [...expanded],
      details,
    });
  }, [details, error, expanded, limit, onSnapshotChange, pending, query, state, type]);
  useEffect(
    () => () => {
      detailEpoch.current++;
      if (openTimer.current) clearTimeout(openTimer.current);
    },
    [],
  );
  const queueOpen = (
    event: ReactMouseEvent<HTMLButtonElement>,
    patent: LibraryPatentSummary,
    target?: ContentSearchTarget,
    resultKey?: string,
  ) => {
    if (event.detail === 0) {
      onOpen(patent, target, resultKey);
      return;
    }
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      onOpen(patent, target, resultKey);
    }, 180);
  };
  const preventDoubleClickSelection = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1) event.preventDefault();
  };
  const loadDetails = async (patentId: string, append: boolean) => {
    const epoch = detailEpoch.current;
    const current = details[patentId];
    const offset = append ? (current?.nextOffset ?? 0) : 0;
    setDetailPending((pendingIds) => new Set(pendingIds).add(patentId));
    setDetailErrors((errorIds) => {
      const next = new Set(errorIds);
      next.delete(patentId);
      return next;
    });
    try {
      const result = await window.patentApi.contentSearch?.request({
        action: "search-details",
        query,
        patentId,
        offset,
        ...(versionRef.current ? { indexVersion: versionRef.current } : {}),
      });
      if (epoch !== detailEpoch.current) return;
      if (result?.ok && result.value.versionChanged) {
        setVersionChanged(true);
        return;
      }
      const hit = result?.ok ? result.value.hits?.[0] : undefined;
      if (!result?.ok || !hit) throw new Error("Detail search unavailable");
      if (result.value.incomplete)
        setState((previous) => (previous ? { ...previous, incomplete: true } : previous));
      setDetails((allDetails) => {
        const previous = append ? allDetails[patentId] : undefined;
        const books = new Map(previous?.books.map((book) => [book.kind, book]));
        for (const book of hit.books) {
          const old = books.get(book.kind);
          books.set(book.kind, {
            ...book,
            snippets: old ? [...old.snippets, ...book.snippets] : book.snippets,
            locations:
              old?.locations && book.locations
                ? [...old.locations, ...book.locations]
                : book.locations,
          });
        }
        return {
          ...allDetails,
          [patentId]: {
            books: [...books.values()],
            hasMore: Boolean(result.value.hasMore),
            nextOffset: result.value.nextOffset ?? null,
          },
        };
      });
    } catch {
      if (epoch !== detailEpoch.current) return;
      setDetailErrors((errorIds) => new Set(errorIds).add(patentId));
    } finally {
      if (epoch === detailEpoch.current)
        setDetailPending((pendingIds) => {
          const next = new Set(pendingIds);
          next.delete(patentId);
          return next;
        });
    }
  };
  const body = new Map(state?.hits?.map((hit) => [hit.patentId, hit.books]));
  const matches = patents.filter(
    (p) =>
      (type === "all" || p.patentType === type) &&
      (Boolean(contentSearchText.matches(patentDisplayName(p), query).next().value) ||
        Boolean(contentSearchText.matches(p.customer ?? "", query).next().value) ||
        body.has(p.patentId)),
  );
  return (
    <section className="content-search-results" aria-label="正文搜索结果" aria-busy={pending}>
      <p role="status">
        {pending
          ? "正在搜索…"
          : versionChanged
            ? "搜索内容已更新，请刷新结果后继续。"
            : error
              ? "正文搜索暂不可用，以下保留名称和客户匹配结果。"
              : `已找到 ${matches.length} 项专利${state?.hasMore ? "，还有更多结果" : ""}`}
        {!pending && state?.incomplete ? " · 部分内容待更新，结果可能不完整" : ""}
      </p>
      {!pending && state?.incomplete && onUpdateIndex ? (
        <button type="button" onClick={onUpdateIndex}>
          更新正文索引
        </button>
      ) : null}
      {versionChanged ? (
        <button type="button" onClick={refreshResults}>
          刷新搜索结果
        </button>
      ) : null}
      {
        <SpatialPresence>
          {!pending && error ? (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              重试搜索
            </button>
          ) : null}
        </SpatialPresence>
      }
      {
        <SpatialPresence>
          {!pending && !error && !matches.length ? (
            <p>暂无匹配结果。尚未索引的内容可能无法搜到。</p>
          ) : null}
        </SpatialPresence>
      }
      {matches.slice(0, limit).map((p, index) => {
        const books = body.get(p.patentId) ?? [];
        const detail = details[p.patentId];
        const totalMatches = books.reduce((count, book) => count + book.count, 0);
        const previewCount = books.reduce((count, book) => count + book.snippets.length, 0);
        const isExpanded = expanded.has(p.patentId);
        const displayedBooks = isExpanded && detail ? detail.books : books;
        const firstTextBook = books.find(
          (book) =>
            book.kind === "claims" || book.kind === "description" || book.kind === "abstract",
        );
        const firstTextSnippet = firstTextBook?.snippets[0];
        const duplicateCounts = new Map<string, number>();
        const allSnippets = displayedBooks.flatMap((book) =>
          book.snippets.map((text, snippetIndex) => {
            const location = book.locations?.[snippetIndex];
            const baseKey = `${book.kind}-${text}`;
            const occurrence = (duplicateCounts.get(baseKey) ?? 0) + 1;
            duplicateCounts.set(baseKey, occurrence);
            return {
              book,
              text,
              location,
              ordinal: location?.occurrence ?? snippetIndex,
              key: location ? `${book.kind}-${location.occurrence}` : `${baseKey}-${occurrence}`,
            };
          }),
        );
        const snippets = allSnippets;
        const detailsNeeded = totalMatches > previewCount;
        const canExpand = totalMatches > 3;
        const loadingDetails = detailPending.has(p.patentId);
        const detailFailed = detailErrors.has(p.patentId);
        return (
          <article key={p.patentId} className="content-search-result">
            <div className="content-search-result-heading">
              <span className="library-search-result-number">{index + 1}.</span>
              <button
                type="button"
                className={`content-search-result-title${selectedResultKey === `${p.patentId}:title` ? " is-selected" : ""}`}
                disabled={p.recoveryState !== "healthy"}
                onMouseDown={preventDoubleClickSelection}
                onDoubleClick={(event) => event.preventDefault()}
                onClick={(event) =>
                  queueOpen(
                    event,
                    p,
                    firstTextBook
                      ? {
                          kind: firstTextBook.kind,
                          query,
                          ...(firstTextBook.locations?.[0]
                            ? { location: firstTextBook.locations[0] }
                            : {}),
                          ...(firstTextSnippet ? { snippet: firstTextSnippet } : {}),
                        }
                      : undefined,
                    `${p.patentId}:title`,
                  )
                }
              >
                <HighlightSearchText text={patentDisplayName(p)} query={query} />
              </button>
            </div>
            <div className="content-search-result-meta">
              {p.patentType === "invention" ? "发明" : "实用新型"}
              {p.customer ? ` · ${p.customer}` : ""}
              {books.length
                ? ` · 正文 ${books.reduce((n, b) => n + b.count, 0)} 处匹配`
                : " · 名称或客户匹配"}
            </div>
            {snippets.slice(0, 3).map(({ book, text, key, location, ordinal }) => (
              <div className="content-search-match" key={key}>
                <div className="content-search-match-heading">
                  <span>
                    {index + 1}.
                    {displayedBooks
                      .slice(0, displayedBooks.indexOf(book))
                      .reduce((sum, item) => sum + item.count, 0) +
                      ordinal +
                      1}
                  </span>
                  <span>{labels[book.kind]}</span>
                </div>
                <button
                  type="button"
                  aria-label={`${labels[book.kind]}：${text}`}
                  className={`content-search-snippet${selectedResultKey === `${p.patentId}:${key}` ? " is-selected" : ""}`}
                  onMouseDown={preventDoubleClickSelection}
                  onDoubleClick={(event) => event.preventDefault()}
                  onClick={(event) =>
                    queueOpen(
                      event,
                      p,
                      { kind: book.kind, query, snippet: text, ...(location ? { location } : {}) },
                      `${p.patentId}:${key}`,
                    )
                  }
                >
                  <HighlightSearchText text={text} query={query} />
                </button>
              </div>
            ))}
            <SpatialCollapse open={isExpanded}>
              {snippets.slice(3).map(({ book, text, key, location, ordinal }) => (
                <div className="content-search-match" key={key}>
                  <div className="content-search-match-heading">
                    <span>
                      {index + 1}.
                      {displayedBooks
                        .slice(0, displayedBooks.indexOf(book))
                        .reduce((sum, item) => sum + item.count, 0) +
                        ordinal +
                        1}
                    </span>
                    <span>{labels[book.kind]}</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`${labels[book.kind]}：${text}`}
                    className={`content-search-snippet${selectedResultKey === `${p.patentId}:${key}` ? " is-selected" : ""}`}
                    onMouseDown={preventDoubleClickSelection}
                    onDoubleClick={(event) => event.preventDefault()}
                    onClick={(event) =>
                      queueOpen(
                        event,
                        p,
                        {
                          kind: book.kind,
                          query,
                          snippet: text,
                          ...(location ? { location } : {}),
                        },
                        `${p.patentId}:${key}`,
                      )
                    }
                  >
                    <HighlightSearchText text={text} query={query} />
                  </button>
                </div>
              ))}
            </SpatialCollapse>
            {canExpand ? (
              <button
                type="button"
                className="content-search-expand"
                disabled={loadingDetails}
                onClick={() => {
                  if (detailFailed) {
                    setExpanded((current) => new Set(current).add(p.patentId));
                    void loadDetails(p.patentId, false);
                    return;
                  }
                  const opening = !isExpanded;
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (opening) next.add(p.patentId);
                    else next.delete(p.patentId);
                    return next;
                  });
                  if (opening && detailsNeeded && (!detail || detailFailed))
                    void loadDetails(p.patentId, false);
                }}
              >
                {loadingDetails ? (
                  <LoaderCircle aria-hidden="true" className="content-search-expand__spinner" />
                ) : isExpanded ? (
                  <ChevronUp aria-hidden="true" />
                ) : (
                  <ChevronDown aria-hidden="true" />
                )}
                <span>
                  {loadingDetails
                    ? "正在读取全部匹配…"
                    : detailFailed
                      ? "重新加载全部匹配"
                      : isExpanded
                        ? "收起全部匹配"
                        : `展开全部 ${totalMatches} 处`}
                </span>
              </button>
            ) : null}
            {isExpanded && detail?.hasMore ? (
              <button
                type="button"
                className="content-search-load-more"
                disabled={loadingDetails}
                onClick={() => void loadDetails(p.patentId, true)}
              >
                {loadingDetails
                  ? "正在加载…"
                  : `继续加载（已显示 ${detail.books.reduce((count, book) => count + book.snippets.length, 0)} / ${totalMatches}）`}
              </button>
            ) : null}
          </article>
        );
      })}
      {matches.length > limit ? (
        <button type="button" onClick={() => setLimit((n) => n + 30)}>
          显示更多
        </button>
      ) : state?.hasMore && !error && !versionChanged ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setAfter(state.nextCursor ?? undefined);
            setLimit((n) => n + 30);
          }}
        >
          继续搜索
        </button>
      ) : null}
    </section>
  );
}
