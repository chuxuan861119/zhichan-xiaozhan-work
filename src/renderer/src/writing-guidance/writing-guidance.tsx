import { ChevronRight, Route, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PatentBookKind } from "../../../shared/patent/model";
import { SpatialPresence } from "../shared/spatial-presence";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";
import { guidanceGroups, guidancePosition, guidanceTasks, visibleGuidanceTarget } from "./model";
import { GUIDANCE_PROGRESS_EVENT, type GuidanceProgress } from "./progress";
import { GUIDANCE_QUICK_EVENT } from "./tool-tutorial";
import "./writing-guidance.css";

export const GUIDANCE_TOUR_EVENT = "patent-workbench:show-editor-introduction";
const tour = [
  ["五书，在这里切换", "在这里切换文档，按自己的顺序写。", ".menu-bar"],
  ["常用编辑工具", "常用编辑和导出功能在这里。", ".tool-bar"],
  [
    "跟随文档的功能栏",
    "功能栏随文档变化，可从边缘展开。",
    ".patent-global-function-rail, .patent-global-function-rail__collapsed-toggle",
  ],
  ["正文是你的写作空间", "在这里写正文，内容会自动保存。", ".tiptap, .drawings-editor"],
  ["需要写作思路时，点这里", "需要帮助时，点“快速工具教程”。", "[data-writing-guidance-entry]"],
];
type View = "home" | "route" | "group" | "task" | "locate" | "tour" | "hint" | null;
type Props = {
  introductionSeen: boolean;
  onIntroductionSeen(): void;
  enabled: boolean;
  ownerKey: string;
  book: PatentBookKind | null;
  scope: "single" | "left" | "right";
  onNavigate(book: PatentBookKind): Promise<void> | void;
  readSelection?(): string;
  onOpenPractice?(): void;
};
function blockingDialog() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
    ),
  ].some(
    (el) =>
      el.getBoundingClientRect().width > 0 &&
      !el.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}
export function WritingGuidance({
  introductionSeen,
  onIntroductionSeen,
  enabled,
  ownerKey,
  book,
  scope,
  onNavigate,
  readSelection,
  onOpenPractice,
}: Props) {
  const shown = useRef(introductionSeen);
  if (introductionSeen) shown.current = true;
  const onSeen = useRef(onIntroductionSeen);
  onSeen.current = onIntroductionSeen;
  const markSeen = useCallback(() => {
    if (!shown.current) {
      shown.current = true;
      onSeen.current();
    }
  }, []);
  const [view, setView] = useState<View>(null);
  useEffect(() => {
    if (!enabled) return;
    const open = () => setView("home");
    window.addEventListener(GUIDANCE_QUICK_EVENT, open);
    return () => window.removeEventListener(GUIDANCE_QUICK_EVENT, open);
  }, [enabled]);
  const [group, setGroup] = useState(0);
  const [taskId, setTaskId] = useState("write");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completion, setCompletion] = useState("");
  const [stepHint, setStepHint] = useState("");
  const [geometry, setGeometry] = useState<{
    left: number;
    top: number;
    target: { left: number; top: number; width: number; height: number } | null;
    fallback: boolean;
    suspended: boolean;
  }>({ left: 20, top: 124, target: null, fallback: false, suspended: false });
  const entry = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  useSpatialViewMotion(card, `${view}:${step}:${taskId}`);
  const session = useRef(0);
  const expectedBook = useRef<PatentBookKind | null>(null);
  const previous = useRef({ ownerKey, book, enabled });
  const automaticTour = useRef(false);
  const current = useRef({ enabled, ownerKey, book, scope, view });
  current.current = { enabled, ownerKey, book, scope, view };
  const recommendedGroup =
    book === "description" || book === "abstract"
      ? 2
      : book === "description-drawings" || book === "abstract-drawing"
        ? 3
        : 0;
  const task = guidanceTasks.find((t) => t.id === taskId) ?? guidanceTasks[0]!;
  const close = useCallback((focus = false) => {
    session.current += 1;
    expectedBook.current = null;
    setView(null);
    setBusy(false);
    setError("");
    setCompletion("");
    if (focus) entry.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const old = previous.current;
    previous.current = { ownerKey, book, enabled };
    if (
      old.ownerKey !== ownerKey ||
      !enabled ||
      (old.book !== book && expectedBook.current !== book)
    )
      close();
    if (old.book !== book && expectedBook.current === book) expectedBook.current = null;
  }, [ownerKey, book, enabled, close]);

  useEffect(() => {
    if (view !== "locate") return;
    const progress = (event: Event) => {
      const detail = (event as CustomEvent<GuidanceProgress>).detail;
      if (!detail || detail.scope !== scope) return;
      if (task.id === "number" && detail.kind === "numbered")
        setCompletion(`已登记：${detail.label}`);
      if (task.id === "convert" && detail.kind === "copied") {
        expectedBook.current = "description";
        setCompletion(
          `已复制“${detail.label}”草稿，尚未写入正文。请在说明书合适位置粘贴，再核对技术内容。`,
        );
      }
    };
    window.addEventListener(GUIDANCE_PROGRESS_EVENT, progress);
    return () => window.removeEventListener(GUIDANCE_PROGRESS_EVENT, progress);
  }, [view, scope, task.id]);

  // First-use scheduling is inactive after the introduction has been shown.
  useEffect(() => {
    if (!enabled || !book || shown.current) return;
    let lastInput = Date.now();
    const touch = () => {
      lastInput = Date.now();
    };
    document.addEventListener("keydown", touch, true);
    document.addEventListener("pointerdown", touch, true);
    const timer = window.setInterval(() => {
      if (shown.current) {
        window.clearInterval(timer);
        document.removeEventListener("keydown", touch, true);
        document.removeEventListener("pointerdown", touch, true);
        return;
      }
      if (current.current.view) return;
      if (
        Date.now() - lastInput < 1800 ||
        !document.hasFocus() ||
        blockingDialog() ||
        visibleGuidanceTarget(document, ".data-safety-guide") ||
        visibleGuidanceTarget(document, '[role="menu"]')
      )
        return;
      markSeen();
      automaticTour.current = true;
      setStep(0);
      setView("tour");
      window.clearInterval(timer);
      document.removeEventListener("keydown", touch, true);
      document.removeEventListener("pointerdown", touch, true);
    }, 1000);
    return () => {
      clearInterval(timer);
      document.removeEventListener("keydown", touch, true);
      document.removeEventListener("pointerdown", touch, true);
    };
  }, [enabled, book, markSeen]);
  useEffect(() => {
    const replay = () => {
      if (!current.current.enabled || blockingDialog()) return;
      session.current += 1;
      expectedBook.current = null;
      setBusy(false);
      setError("");
      markSeen();
      automaticTour.current = false;
      setStep(0);
      setView("tour");
    };
    window.addEventListener(GUIDANCE_TOUR_EVENT, replay);
    return () => window.removeEventListener(GUIDANCE_TOUR_EVENT, replay);
  }, [markSeen]);
  useEffect(() => {
    if (!view) return;
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || blockingDialog()) return;
      // Let an open tool menu consume Escape first.
      if (visibleGuidanceTarget(document, '[role="menu"]')) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const pointer = (e: PointerEvent) => {
      if (
        !(e.target instanceof Node) ||
        card.current?.contains(e.target) ||
        entry.current?.contains(e.target)
      )
        return;
      if (view === "hint" || view === "tour") close();
    };
    const blur = () => close();
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("blur", blur);
    };
  }, [view, close]);

  useLayoutEffect(() => {
    if (!view || !enabled) return;
    let frame = 0;
    const scopedTarget = (selector: string) => {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        const owner = el.closest("[data-function-rail-owner], [data-function-rail-scope]");
        const id =
          owner?.getAttribute("data-function-rail-owner") ??
          owner?.getAttribute("data-function-rail-scope");
        if (
          id === scope &&
          visibleGuidanceTarget({ querySelectorAll: () => [el] } as unknown as ParentNode, "*")
        )
          return el;
      }
      return null;
    };
    const update = () => {
      frame = 0;
      let el: HTMLElement | null = null;
      let fallback = false;
      if (view === "hint") el = entry.current;
      else if (view === "tour")
        el =
          step === 2 || step === 3
            ? scopedTarget(tour[step]![2]!)
            : visibleGuidanceTarget(document, tour[step]![2]!);
      else if (view === "locate") {
        el = task.global
          ? visibleGuidanceTarget(document, task.selector)
          : scopedTarget(task.selector);
        let hint = "";
        if (task.id === "number" && !completion) {
          const button = scopedTarget(task.selector) as HTMLButtonElement | null;
          if (!readSelection?.().trim()) {
            hint = "先在正文中选中一个部件名称，例如“底座”；不要选中整句话。";
            el = scopedTarget(".tiptap") ?? el;
          } else if (button?.disabled) {
            hint = "已选中文字，但编号暂不可用。请先完成编号列表中的编辑或待处理核对，再继续。";
          } else if (button) {
            hint = "已可编号：点击“顺序编号”；如果图纸已有编号，请使用“自定义编号”。";
          }
        }
        if (task.id === "convert" && !completion) {
          const menu = scopedTarget(".claims-description-menu");
          hint = menu
            ? "选择“发明内容”或“具体实施方式”，查看生成的草稿；核对后点击“复制并跳转”。"
            : "先写好权利要求，再打开“说明书”工具，选择要生成的章节。这里只生成草稿，不会覆盖正文。";
          if (menu) el = menu;
          const editor = scopedTarget(".tiptap");
          const text = editor?.textContent?.trim() ?? "";
          if (editor && (!text || /^\d+[.．、]?\s*$/u.test(text))) {
            hint = "先在权利要求书中写入技术方案，再生成说明书草稿；空白正文不能转换。";
            el = editor;
          }
        }
        setStepHint(hint);
        if (!el && !task.global) {
          el = scopedTarget(".patent-global-function-rail__collapsed-toggle");
          fallback = Boolean(el);
        }
      }
      const rect = el?.getBoundingClientRect() ?? null;
      const target = rect
        ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: Math.min(rect.height, step === 3 && view === "tour" ? 120 : rect.height),
          }
        : null;
      const w = card.current?.offsetWidth || 326;
      const h = card.current?.offsetHeight || 260;
      const pos = guidancePosition(
        target
          ? ({
              ...rect,
              ...target,
              right: target.left + target.width,
              bottom: target.top + target.height,
            } as DOMRect)
          : null,
        w,
        h,
        innerWidth,
        innerHeight,
      );
      const next = {
        ...pos,
        target,
        fallback,
        suspended: blockingDialog(),
      };
      setGeometry((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new MutationObserver((records) => {
      if (
        records.some((r) => {
          const target = r.target instanceof Element ? r.target : r.target.parentElement;
          return target && !target.closest(".writing-guidance-card, .writing-guidance-ring");
        })
      )
        schedule();
    });
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "aria-expanded", "disabled", "class"],
    });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (card.current) resize?.observe(card.current);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("selectionchange", schedule);
    update();
    return () => {
      observer.disconnect();
      resize?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("selectionchange", schedule);
    };
  }, [view, enabled, step, scope, task, completion, readSelection]);

  const start = async (destination = task.book) => {
    const token = ++session.current;
    const owner = ownerKey;
    setBusy(true);
    setError("");
    expectedBook.current = destination;
    try {
      await onNavigate(destination);
      if (
        token !== session.current ||
        current.current.ownerKey !== owner ||
        !current.current.enabled
      )
        return;
      setView("locate");
    } catch (e) {
      if (token === session.current)
        setError(e instanceof Error ? e.message : "暂时无法定位，请继续手工编辑。");
    } finally {
      if (token === session.current) {
        setBusy(false);
        if (current.current.book === destination) expectedBook.current = null;
      }
    }
  };
  const choose = (id: string) => {
    session.current += 1;
    expectedBook.current = null;
    setBusy(false);
    setError("");
    setTaskId(id);
    setCompletion("");
    setStepHint("");
    setView("task");
  };
  if (!enabled) return null;
  const at = geometry.target;
  return (
    <>
      <button
        ref={entry}
        type="button"
        className="writing-guidance-entry"
        data-writing-guidance-entry
        aria-expanded={Boolean(view)}
        aria-controls="writing-guidance-card"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          if (onOpenPractice) {
            markSeen();
            close();
            onOpenPractice();
            return;
          }
          if (event.detail === 0 && (!view || view === "hint"))
            requestAnimationFrame(() =>
              card.current
                ?.querySelector<HTMLButtonElement>("button")
                ?.focus({ preventScroll: true }),
            );
          markSeen();
          if (view && view !== "hint" && view !== "tour") close();
          else {
            setView("home");
            setError("");
          }
        }}
      >
        <Route size={15} />
        快速工具教程
      </button>
      {createPortal(
        <SpatialPresence>
          {view ? (
            <>
              <SpatialPresence>
                {at && !geometry.suspended && (
                  <div
                    className="writing-guidance-ring"
                    aria-hidden="true"
                    style={{
                      left: at.left - 3,
                      top: at.top - 3,
                      width: at.width + 6,
                      height: at.height + 6,
                    }}
                  />
                )}
              </SpatialPresence>
              <aside
                ref={card}
                id="writing-guidance-card"
                className="writing-guidance-card"
                onMouseDown={(event) => {
                  if (event.target instanceof Element && event.target.closest("button"))
                    event.preventDefault();
                }}
                aria-label={view === "tour" ? "首次界面介绍" : "快速工具教程"}
                hidden={geometry.suspended}
                style={{ left: geometry.left, top: geometry.top }}
              >
                <header>
                  <span>
                    <Route size={15} />
                    {view === "tour" ? `认识工作台 · ${step + 1} / 5` : "快速工具教程"}
                  </span>
                  <button type="button" aria-label="关闭快速工具教程" onClick={() => close(true)}>
                    <X size={16} />
                  </button>
                </header>
                {view === "hint" ? (
                  <>
                    <h2>想看看怎么写？</h2>
                    <p>点“快速工具教程”，选择当前要做的事。</p>
                  </>
                ) : view === "tour" ? (
                  <>
                    <h2>{tour[step]![0]}</h2>
                    <p>{tour[step]![1]}</p>
                    <div className="writing-guidance-actions">
                      {step > 0 && (
                        <button type="button" onClick={() => setStep(step - 1)}>
                          上一步
                        </button>
                      )}
                      <button type="button" onClick={() => close(true)}>
                        跳过
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => {
                          if (step < 4) setStep(step + 1);
                          else if (automaticTour.current) setView("hint");
                          else close(true);
                        }}
                      >
                        {step === 4 ? "开始写作" : "下一步"}
                      </button>
                    </div>
                  </>
                ) : view === "home" ? (
                  <>
                    <h2>从当前文档开始</h2>
                    <button
                      className="writing-guidance-choice"
                      type="button"
                      onClick={() => {
                        setGroup(recommendedGroup);
                        setView("group");
                      }}
                    >
                      {recommendedGroup === 2
                        ? "完善说明书"
                        : recommendedGroup === 3
                          ? "整理附图"
                          : "撰写权利要求"}
                      <ChevronRight size={15} />
                    </button>
                    <details className="spatial-disclosure">
                      <summary>其他写作任务</summary>
                      {[
                        ["撰写权利要求", 0],
                        ["完善说明书", 2],
                        ["整理附图", 3],
                      ]
                        .filter(([, index]) => index !== recommendedGroup)
                        .map(([label, index]) => (
                          <button
                            className="writing-guidance-choice"
                            type="button"
                            key={label}
                            onClick={() => {
                              setGroup(Number(index));
                              setView("group");
                            }}
                          >
                            {label}
                            <ChevronRight size={15} />
                          </button>
                        ))}
                    </details>
                    <footer>
                      <button type="button" onClick={() => setView("route")}>
                        查看推荐顺序
                      </button>
                    </footer>
                  </>
                ) : view === "route" ? (
                  <>
                    <h2>一条推荐路线</h2>
                    {guidanceGroups.map((g, i) => (
                      <button
                        className="writing-guidance-choice"
                        type="button"
                        key={g.title}
                        onClick={() => {
                          setGroup(i);
                          setView("group");
                        }}
                      >
                        <small>0{i + 1}</small>
                        {g.title}
                        <ChevronRight size={15} />
                      </button>
                    ))}
                    <footer>
                      <button type="button" onClick={() => setView("home")}>
                        返回起点
                      </button>
                    </footer>
                  </>
                ) : view === "group" ? (
                  <>
                    <h2>{guidanceGroups[group]!.title}</h2>
                    {(group === 2
                      ? ["description", "convert", "dual", "supplement"]
                      : guidanceGroups[group]!.ids
                    ).map((id) => (
                      <button
                        className="writing-guidance-choice"
                        type="button"
                        key={id}
                        onClick={() => choose(id)}
                      >
                        {guidanceTasks.find((t) => t.id === id)!.title}
                        <ChevronRight size={15} />
                      </button>
                    ))}
                    <footer>
                      <button type="button" onClick={() => setView("home")}>
                        换个起点
                      </button>
                      <button type="button" onClick={() => setView("route")}>
                        查看路线
                      </button>
                    </footer>
                  </>
                ) : (
                  <>
                    <h2>{task.title}</h2>
                    <p aria-live="polite">
                      {view === "task"
                        ? task.description
                        : completion
                          ? completion
                          : geometry.fallback
                            ? "点击蓝框展开功能栏。"
                            : !at
                              ? "目标暂不可见，请展开功能栏或滚动页面。"
                              : stepHint || task.instruction}
                    </p>
                    {error && <p role="alert">{error}</p>}
                    <div className="writing-guidance-actions">
                      {view === "task" ? (
                        <>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={busy}
                            onClick={() => void start()}
                          >
                            {busy ? "正在定位…" : "带我操作"}
                          </button>
                          <button type="button" disabled={busy} onClick={() => setView("route")}>
                            暂时跳过
                          </button>
                        </>
                      ) : (
                        <>
                          {task.id === "convert" && completion && book !== "description" && (
                            <button
                              type="button"
                              disabled={busy}
                              className="primary-button"
                              onClick={() => void start("description")}
                            >
                              去说明书粘贴
                            </button>
                          )}
                          {task.id === "number" && completion && (
                            <button
                              type="button"
                              className="primary-button"
                              onClick={() => setCompletion("")}
                            >
                              继续登记
                            </button>
                          )}
                          {task.id === "number" && completion && (
                            <button type="button" onClick={() => choose("marks")}>
                              填入说明书
                            </button>
                          )}
                          <button
                            type="button"
                            className={completion ? undefined : "primary-button"}
                            onClick={() => close(true)}
                          >
                            继续写作
                          </button>
                          <button type="button" onClick={() => setView("route")}>
                            了解其他操作
                          </button>
                        </>
                      )}
                    </div>
                    {(task.id === "figures" || task.id === "number" || task.id === "check") && (
                      <div className="writing-guidance-related">
                        {(task.id === "figures"
                          ? ["cad", "flowchart"]
                          : task.id === "number"
                            ? ["locator"]
                            : ["ai"]
                        ).map((id) => (
                          <button type="button" key={id} disabled={busy} onClick={() => choose(id)}>
                            {guidanceTasks.find((t) => t.id === id)?.title}
                            <ChevronRight size={13} />
                          </button>
                        ))}
                      </div>
                    )}
                    <footer>
                      <button type="button" disabled={busy} onClick={() => setView("home")}>
                        换个起点
                      </button>
                    </footer>
                  </>
                )}
              </aside>
            </>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </>
  );
}
