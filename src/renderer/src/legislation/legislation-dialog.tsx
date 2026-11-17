import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LEGISLATION, LEGISLATION_CHECKED, type LegislationId } from "../../../shared/legislation";
import { legislationParagraphs } from "../../../shared/legislation-text";
import { StandardDialog } from "../shared/standard-dialog";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";
import { useSurfaceResizeMotion } from "../shared/use-surface-resize-motion";
import { CommonArticles } from "./common-articles";
import { GuidelinesReader } from "./guidelines-reader";
import { LegislationMenu } from "./legislation-menu";
import "./legislation-dialog.css";

export function LegislationDialog({ onClose }: { onClose(): void }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<LegislationId>("law");
  const [common, setCommon] = useState(false);
  useSpatialViewMotion(viewRef, `${selected}:${common}`);
  const [targetArticle, setTargetArticle] = useState("");
  const [query, setQuery] = useState("");
  const [matchCountSlot, setMatchCountSlot] = useState<HTMLSpanElement | null>(null);
  const [pageControlsSlot, setPageControlsSlot] = useState<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [maximizing, setMaximizing] = useState(false);
  const [search, setSearch] = useState({ sequence: 0, previous: false });
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const position = useRef<Record<string, number>>({ guidelines: 1 });
  const searchInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useSurfaceResizeMotion(dialogRef, expanded);
  useEffect(() => {
    const dialog = dialogRef.current;
    const onFind = (event: KeyboardEvent) => {
      if (
        !common &&
        selected !== "guidelines" &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    dialog?.addEventListener("keydown", onFind, true);
    return () => dialog?.removeEventListener("keydown", onFind, true);
  }, [common, selected]);
  // The app runs without a native menu (window.ts: Menu.setApplicationMenu(null)),
  // so Chromium never wires Ctrl+C to the copy command. Bridge selected law text
  // to the validated clipboard IPC so every text document is selectable and
  // copyable; the guidelines PDF keeps its own viewer behavior untouched.
  const copySelection = useCallback(async (selection: string) => {
    setActionError("");
    try {
      const clipboard = window.patentApi?.clipboard;
      if (clipboard) {
        const result = await clipboard.writeText(selection);
        if (!result.ok) throw new Error(result.error.code);
        return;
      }
      await navigator.clipboard.writeText(selection);
    } catch {
      setActionError("复制失败，请重试。");
    }
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    const onCopy = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "c" && event.key !== "Insert") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")
      )
        return;
      if (!common && selected === "guidelines") return;
      const selection = window.getSelection()?.toString() ?? "";
      if (!selection) return;
      event.preventDefault();
      event.stopPropagation();
      void copySelection(selection);
    };
    dialog?.addEventListener("keydown", onCopy, true);
    return () => dialog?.removeEventListener("keydown", onCopy, true);
  }, [common, selected, copySelection]);
  const item = LEGISLATION.find((item) => item.id === selected)!;
  async function toggleExpanded() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setMaximizing(true);
    setActionError("");
    try {
      const result = await window.patentApi.application.maximizeWindow();
      if (!result.ok) throw new Error(result.error.code);
      setExpanded(true);
    } catch {
      setActionError("无法最大化软件窗口，请重试。");
    } finally {
      setMaximizing(false);
    }
  }
  async function action(action: "source" | "save") {
    setActionError("");
    setBusy(true);
    try {
      if (!window.patentApi?.application.legislation) throw new Error("unavailable");
      const result = await window.patentApi.application.legislation({ id: selected, action });
      if (!result.ok) throw new Error(result.error.code);
    } catch {
      setActionError(
        action === "save" ? "保存副本失败，请重试。" : "无法打开官方来源，请检查系统浏览器设置。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <StandardDialog
      open
      dialogRef={dialogRef}
      title="专利法律法规"
      subtitle="官方原文 · 离线阅读"
      size="xl"
      onCancel={onClose}
      className={`legislation-dialog${expanded ? " legislation-dialog--expanded" : ""}`}
      bodyClassName="legislation-reader"
      headerActions={
        <button
          type="button"
          className="legislation-dialog__maximize dialog-close-button dialog-close-control"
          aria-label={expanded ? "还原窗口" : "最大化阅读"}
          title={expanded ? "还原窗口" : "最大化阅读"}
          disabled={maximizing}
          onClick={() => void toggleExpanded()}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            aria-hidden="true"
            focusable="false"
          >
            {expanded ? (
              <path d="M6 5V3h9v9h-2M3 6h9v9H3Z" />
            ) : (
              <rect x="3.5" y="3.5" width="11" height="11" />
            )}
          </svg>
        </button>
      }
    >
      <section
        ref={viewRef}
        className="legislation-reader__shell"
        aria-label="法规阅读器"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            searchInput.current?.focus();
          }
          if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
        }}
      >
        <div className="legislation-reader__top">
          <fieldset className="legislation-reader__tabs" aria-label="选择法规">
            {LEGISLATION.slice(0, 3).map((doc) => (
              <button
                type="button"
                key={doc.id}
                aria-pressed={!common && selected === doc.id}
                onClick={() => {
                  if (!common && doc.id === selected) return;
                  setCommon(false);
                  setTargetArticle("");
                  setSelected(doc.id);
                  setQuery("");
                  setSearch({ sequence: 0, previous: false });
                  setActionError("");
                }}
              >
                {doc.short}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={common}
              onClick={() => {
                setCommon(true);
                setActionError("");
              }}
            >
              常用法条
            </button>
            <LegislationMenu
              selected={common ? null : selected}
              onSelect={(id) => {
                setCommon(false);
                setTargetArticle("");
                setSelected(id);
                setQuery("");
                setSearch({ sequence: 0, previous: false });
                setActionError("");
              }}
            />
          </fieldset>
        </div>
        {common ? (
          <CommonArticles
            onOpen={(document, article) => {
              setSelected(document);
              setCommon(false);
              setQuery("");
              setSearch({ sequence: 0, previous: false });
              setTargetArticle(article);
            }}
          />
        ) : (
          <>
            <div className="legislation-reader__toolbar">
              <input
                ref={searchInput}
                type="search"
                aria-label="搜索当前文件"
                placeholder="搜索当前文件"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter")
                    setSearch((value) => ({
                      sequence: value.sequence + 1,
                      previous: event.shiftKey,
                    }));
                }}
              />
              {selected !== "guidelines" ? (
                <span ref={setMatchCountSlot} className="legislation-reader__match-count" />
              ) : null}
              <button
                type="button"
                disabled={!query.trim()}
                onClick={() =>
                  setSearch((value) => ({ sequence: value.sequence + 1, previous: true }))
                }
              >
                上一处
              </button>
              <button
                type="button"
                disabled={!query.trim()}
                onClick={() =>
                  setSearch((value) => ({ sequence: value.sequence + 1, previous: false }))
                }
              >
                下一处
              </button>
              <select
                aria-label="阅读缩放"
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              >
                <option value={0}>适合宽度</option>
                {[75, 100, 125, 150, 200].map((value) => (
                  <option key={value} value={value}>
                    {value}%
                  </option>
                ))}
              </select>
            </div>
            <div className="legislation-reader__metadata">
              <strong>{item.title}</strong>
              <span>
                {item.version} · {item.effective} 起施行
              </span>
            </div>
            {"note" in item && item.note ? (
              <p className="legislation-reader__note">阅读提示：{item.note}</p>
            ) : null}
            {selected === "guidelines" ? (
              <GuidelinesReader
                pageControlsSlot={pageControlsSlot}
                query={query.trim()}
                search={search}
                zoom={zoom}
                initialPage={position.current.guidelines ?? 1}
                onPage={(page) => {
                  position.current.guidelines = page;
                }}
              />
            ) : (
              <TextLegislation
                key={selected}
                matchCountSlot={matchCountSlot}
                targetArticle={targetArticle}
                paragraphs={legislationParagraphs(selected)}
                query={query.trim()}
                search={search}
                zoom={zoom || 100}
                initialScroll={position.current[selected] ?? 0}
                onScroll={(top) => {
                  position.current[selected] = top;
                }}
              />
            )}
          </>
        )}
        <footer
          className={`legislation-reader__footer${!common && selected === "guidelines" ? " legislation-reader__footer--pdf" : ""}`}
        >
          <span>核对日期 {LEGISLATION_CHECKED}</span>
          {!common && selected === "guidelines" ? (
            <div className="legislation-reader__pagination" ref={setPageControlsSlot} />
          ) : null}
          {common ? (
            <span>专利法（2020年修正）· 实施细则（2023年修订）</span>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => void action("source")}>
                官方来源 ↗
              </button>
              <button type="button" disabled={busy} onClick={() => void action("save")}>
                保存副本
              </button>
            </>
          )}
          {actionError ? <span role="alert">{actionError}</span> : null}
        </footer>
      </section>
    </StandardDialog>
  );
}

function TextLegislation({
  matchCountSlot,
  targetArticle,
  paragraphs,
  query,
  search,
  zoom,
  initialScroll,
  onScroll,
}: {
  matchCountSlot: HTMLSpanElement | null;
  targetArticle: string;
  paragraphs: readonly string[];
  query: string;
  search: { sequence: number; previous: boolean };
  zoom: number;
  initialScroll: number;
  onScroll(top: number): void;
}) {
  const article = useRef<HTMLElement>(null);
  const initialPosition = useRef(initialScroll);
  const lastSearch = useRef(0);
  const [current, setCurrent] = useState(0);
  const matches = useMemo(
    () =>
      paragraphs.reduce(
        (count, paragraph) => count + (query ? paragraph.split(query).length - 1 : 0),
        0,
      ),
    [paragraphs, query],
  );
  const chapters = useMemo(
    () =>
      paragraphs
        .map((text, index) => ({ text, index }))
        .filter(
          ({ text, index }) =>
            /^第[一二三四五六七八九十]+章/.test(text) &&
            !paragraphs.slice(index + 1).includes(text),
        ),
    [paragraphs],
  );
  useEffect(() => {
    if (article.current) article.current.scrollTop = initialPosition.current;
  }, []);
  useEffect(() => {
    if (targetArticle)
      article.current
        ?.querySelector('[data-article-target="true"]')
        ?.scrollIntoView?.({ block: "center" });
  }, [targetArticle]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at its first match.
  useEffect(() => {
    setCurrent(0);
  }, [query]);
  useEffect(() => {
    if (search.sequence && matches && lastSearch.current !== search.sequence) {
      lastSearch.current = search.sequence;
      setCurrent((value) => (value + (search.previous ? -1 : 1) + matches) % matches);
    }
  }, [search, matches]);
  useEffect(() => {
    if (query)
      article.current?.querySelectorAll("mark")[current]?.scrollIntoView?.({ block: "center" });
  }, [current, query]);
  let matchIndex = 0;
  return (
    <div className="legislation-reader__columns">
      <nav className="legislation-reader__outline" aria-label="条文目录">
        {chapters.map((chapter) => (
          <button
            type="button"
            key={chapter.index}
            onClick={() =>
              article.current
                ?.querySelector(`[data-paragraph="${chapter.index}"]`)
                ?.scrollIntoView({ block: "start" })
            }
          >
            {chapter.text}
          </button>
        ))}
      </nav>
      <div className="legislation-reader__text-area">
        {matchCountSlot
          ? createPortal(
              <span role="status">
                {query ? (matches ? `${current + 1} / ${matches} 处匹配` : "无匹配结果") : ""}
              </span>,
              matchCountSlot,
            )
          : null}
        <article
          ref={article}
          className="legislation-reader__text"
          aria-label="法规正文"
          style={{ fontSize: `${(16 * zoom) / 100}px` }}
          onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
        >
          {paragraphs.map((text, index) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable official paragraphs may contain identical text.
              key={`${index}-${text.slice(0, 10)}`}
              data-paragraph={index}
              data-article-target={
                targetArticle ? text.startsWith(`${targetArticle}　`) : undefined
              }
              className={
                chapters.some((chapter) => chapter.index === index)
                  ? "legislation-reader__chapter"
                  : undefined
              }
            >
              {query
                ? text.split(query).map((part, piece) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: immutable search fragments.
                    <Fragment key={piece}>
                      {piece > 0 ? (
                        <mark data-current={String(matchIndex++ === current)}>{query}</mark>
                      ) : null}
                      {part}
                    </Fragment>
                  ))
                : text}
            </p>
          ))}
        </article>
      </div>
    </div>
  );
}
