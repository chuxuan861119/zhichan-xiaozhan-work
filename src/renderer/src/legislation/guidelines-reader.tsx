import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import guideUrl from "./assets/guidelines-2025.pdf?url";
import officialOutline from "./assets/guidelines-outline.json";
import "pdfjs-dist/legacy/web/pdf_viewer.css";

type OutlineItem = { title: string; dest: string | unknown[] | null; items: OutlineItem[] };
type Props = {
  pageControlsSlot: HTMLDivElement | null;
  query: string;
  search: { sequence: number; previous: boolean };
  zoom: number;
  initialPage: number;
  onPage(page: number): void;
};

export function GuidelinesReader({
  pageControlsSlot,
  query,
  search,
  zoom,
  initialPage,
  onPage,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const controls = useRef<{ viewer: PDFViewer; bus: EventBus; links: PDFLinkService } | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [page, setPage] = useState(initialPage);
  const [total, setTotal] = useState(0);
  const [matches, setMatches] = useState("");
  const pageCallback = useRef(onPage);
  pageCallback.current = onPage;
  const startingPage = useRef(initialPage);
  const lastSearch = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry deliberately recreates the PDF loading task.
  useEffect(() => {
    let disposed = false;
    let loading: PDFDocumentLoadingTask | undefined;
    let resize: ResizeObserver | undefined;
    let viewer: PDFViewer | undefined;
    setReady(false);
    setError("");
    void (async () => {
      const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const { PDFViewer, PDFLinkService, EventBus, PDFFindController } = await import(
        "pdfjs-dist/legacy/web/pdf_viewer.mjs"
      );
      if (disposed || !container.current || !pages.current) return;
      pdf.GlobalWorkerOptions.workerSrc = workerUrl;
      const bus = new EventBus();
      const links = new PDFLinkService({ eventBus: bus });
      links.externalLinkEnabled = false;
      const find = new PDFFindController({ eventBus: bus, linkService: links });
      viewer = new PDFViewer({
        container: container.current,
        viewer: pages.current,
        eventBus: bus,
        linkService: links,
        findController: find,
        annotationMode: 0,
      });
      links.setViewer(viewer);
      controls.current = { viewer, bus, links };
      bus.on("pagesinit", () => {
        if (disposed || !viewer) return;
        viewer.currentScaleValue = "page-width";
        viewer.currentPageNumber = Math.min(startingPage.current, viewer.pagesCount);
        setReady(true);
      });
      bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
        if (disposed) return;
        setPage(pageNumber);
        pageCallback.current(pageNumber);
      });
      bus.on(
        "updatefindmatchescount",
        ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
          if (!disposed) setMatches(`${matchesCount.current} / ${matchesCount.total}`);
        },
      );
      bus.on("updatefindcontrolstate", ({ state }: { state: number }) => {
        if (!disposed && state === 1) setMatches("无匹配结果");
      });
      bus.on("pagerendered", ({ error }: { error?: unknown }) => {
        if (!disposed && error) setError("页面显示失败，请重试或保存原文查看。");
      });
      loading = pdf.getDocument({ url: guideUrl, enableXfa: false });
      const doc = await loading.promise;
      if (disposed) return;
      setTotal(doc.numPages);
      links.setDocument(doc);
      viewer.setDocument(doc);
      const tree = await doc.getOutline();
      if (disposed) return;
      if (!disposed) setOutline(tree ?? []);
      resize = new ResizeObserver(() => {
        if (viewer?.currentScaleValue === "page-width") viewer.currentScaleValue = "page-width";
      });
      resize.observe(container.current);
    })().catch(() => {
      if (!disposed) setError("审查指南加载失败，请重试或保存原文查看。");
    });
    return () => {
      disposed = true;
      resize?.disconnect();
      controls.current = null;
      // PDF.js explicitly supports null to detach the document; its declaration omits null.
      viewer?.setDocument(null as unknown as PDFDocumentProxy);
      void loading?.destroy();
    };
  }, [retry]);

  useEffect(() => {
    if (!ready || !controls.current) return;
    controls.current.viewer.currentScaleValue = zoom === 0 ? "page-width" : String(zoom / 100);
  }, [zoom, ready]);
  useEffect(() => {
    if (!ready) return;
    setMatches(query ? "正在查找…" : "");
    const timer = setTimeout(
      () =>
        controls.current?.bus.dispatch("find", {
          source: container.current,
          type: "",
          query,
          caseSensitive: false,
          entireWord: false,
          highlightAll: true,
          findPrevious: false,
          matchDiacritics: false,
        }),
      200,
    );
    return () => clearTimeout(timer);
  }, [query, ready]);
  useEffect(() => {
    if (!ready || !search.sequence || lastSearch.current === search.sequence) return;
    lastSearch.current = search.sequence;
    controls.current?.bus.dispatch("find", {
      source: container.current,
      type: "again",
      query,
      highlightAll: true,
      caseSensitive: false,
      entireWord: false,
      findPrevious: search.previous,
    });
  }, [search, query, ready]);

  const renderOutline = (items: OutlineItem[]) =>
    items.map((item, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: official outline order is immutable.
      <li key={index}>
        <button
          type="button"
          disabled={!item.dest}
          onClick={() => {
            if (item.dest) void controls.current?.links.goToDestination(item.dest);
          }}
        >
          {item.title}
        </button>
        {item.items.length > 0 ? <ul>{renderOutline(item.items)}</ul> : null}
      </li>
    ));
  return (
    <div className="legislation-reader__columns">
      <nav className="legislation-reader__outline" aria-label="审查指南目录">
        <ul>{renderOutline(outline)}</ul>
        {ready && !outline.length
          ? officialOutline.map((item) => (
              <button
                type="button"
                key={item.page}
                onClick={() => {
                  if (controls.current) controls.current.viewer.currentPageNumber = item.page;
                }}
              >
                {item.title}
              </button>
            ))
          : null}
      </nav>
      <div className="legislation-reader__pdf-area">
        <span className="legislation-reader__pdf-badge">PDF</span>
        {pageControlsSlot
          ? createPortal(
              <div className="legislation-reader__page-controls">
                <button
                  type="button"
                  aria-label="上一页"
                  disabled={!ready || page <= 1}
                  onClick={() => {
                    if (controls.current) controls.current.viewer.currentPageNumber = page - 1;
                  }}
                >
                  <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" /> 上一页
                </button>
                <label>
                  页码{" "}
                  <input
                    aria-label="指南页码"
                    type="text"
                    inputMode="numeric"
                    value={page}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (
                        controls.current &&
                        Number.isInteger(value) &&
                        value > 0 &&
                        value <= total
                      )
                        controls.current.viewer.currentPageNumber = value;
                    }}
                  />
                </label>
                <span>/ {total}</span>
                <button
                  type="button"
                  aria-label="下一页"
                  disabled={!ready || page >= total}
                  onClick={() => {
                    if (controls.current) controls.current.viewer.currentPageNumber = page + 1;
                  }}
                >
                  下一页 <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                <span role="status">{matches}</span>
              </div>,
              pageControlsSlot,
            )
          : null}
        {error ? (
          <div role="alert">
            {error}{" "}
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </div>
        ) : !ready ? (
          <div role="status">正在加载官方原文…</div>
        ) : null}
        {/* biome-ignore lint/a11y/useSemanticElements: PDF.js requires an HTMLDivElement scroll container. */}
        <div
          ref={container}
          className="legislation-reader__pdf-scroll"
          role="region"
          aria-label="审查指南正文"
        >
          <div ref={pages} className="pdfViewer" />
        </div>
      </div>
    </div>
  );
}
