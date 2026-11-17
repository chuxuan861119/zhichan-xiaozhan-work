import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  GraduationCap,
  GripHorizontal,
  LayoutGrid,
  LocateFixed,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanonicalPatent, PatentBookKind } from "../../../shared/patent/model";
import {
  TUTORIAL_LESSONS,
  type TutorialContext,
  type TutorialLessonId,
  tutorialCompleted,
  tutorialLesson,
} from "../../../shared/tutorial/model";
import { confirmAppAction } from "../shared/app-dialog";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";
import { useDialogDrag } from "../shared/use-dialog-drag";
import { visibleGuidanceTarget } from "./model";
import { GUIDANCE_PROGRESS_EVENT, type GuidanceProgress } from "./progress";
import "./tool-tutorial.css";

export const TUTORIAL_OPEN_EVENT = "patent-workbench:open-tool-tutorial";
export const GUIDANCE_QUICK_EVENT = "patent-workbench:open-quick-guidance";
export function openToolTutorial() {
  window.dispatchEvent(new Event(TUTORIAL_OPEN_EVENT));
}
export function ToolTutorialLibraryEntry() {
  if (!window.patentApi?.tutorial || window.patentApi.tutorial.isSession) return null;
  return (
    <button type="button" className="tool-tutorial-entry" onClick={openToolTutorial}>
      <GraduationCap size={19} />
      快速工具教程
      <ChevronRight size={16} />
    </button>
  );
}
type Props = {
  patent: CanonicalPatent | null;
  onOpen(patentId: string, book: PatentBookKind): Promise<void>;
  onClose(patentId: string): Promise<boolean>;
  onNavigate(book: PatentBookKind): Promise<void>;
};

export function ToolTutorial(props: Props) {
  const api = window.patentApi?.tutorial;
  const isSession = api?.isSession ?? false;
  const callbacks = useRef(props);
  callbacks.current = props;
  const [context, setContext] = useState<TutorialContext | null>(null);
  const [directory, setDirectory] = useState(false);
  const [selected, setSelected] = useState<TutorialLessonId>("clear-format");
  const [busy, setBusy] = useState(isSession);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Set<TutorialLessonId>>(new Set());
  const [ring, setRing] = useState<DOMRect | null>(null);
  const pending = useRef(false);
  const exiting = useRef(false);
  const ringTarget = useRef<HTMLElement | null>(null);
  const hasRing = Boolean(ring);
  const drag = useDialogDrag<HTMLElement>({
    positionKey: "tool-tutorial-coach",
    memory: "session",
    movable: true,
    minTop: 100,
  });
  const lesson = tutorialLesson(context?.lessonId ?? selected);
  const index = TUTORIAL_LESSONS.findIndex((item) => item.id === lesson.id);
  const success = !!context && tutorialCompleted(context, props.patent, copied);

  useEffect(() => {
    const open = () => {
      setDirectory(true);
      setError("");
    };
    window.addEventListener(TUTORIAL_OPEN_EVENT, open);
    return () => window.removeEventListener(TUTORIAL_OPEN_EVENT, open);
  }, []);
  useEffect(() => {
    if (!isSession || !api) return;
    let live = true;
    void (async () => {
      try {
        const result = await api.read();
        if (!result.ok) throw new Error(result.error.message);
        if (!result.value) throw new Error("教学材料未准备好，请重新进入练习。");
        if (!live) return;
        setContext(result.value);
        setSelected(result.value.lessonId);
        await callbacks.current.onOpen(
          result.value.patentId,
          tutorialLesson(result.value.lessonId).book,
        );
        const ready = await api.ready();
        if (!ready.ok) throw new Error(ready.error.message);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : "练习未能打开，请重试。");
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, isSession]);
  useEffect(() => {
    if (!isSession || !context) return;
    setCopied(null);
    const progress = (event: Event) => {
      const detail = (event as CustomEvent<GuidanceProgress>).detail;
      if (detail?.kind === "copied") setCopied(detail.label);
    };
    window.addEventListener(GUIDANCE_PROGRESS_EVENT, progress);
    return () => window.removeEventListener(GUIDANCE_PROGRESS_EVENT, progress);
  }, [context, isSession]);
  useEffect(() => {
    if (!success) return;
    setCompleted((old) => (old.has(lesson.id) ? old : new Set([...old, lesson.id])));
  }, [success, lesson.id]);
  useEffect(() => {
    if (!hasRing) return;
    const update = () => {
      const target = ringTarget.current;
      if (!target?.isConnected) {
        setRing(null);
        return;
      }
      const bounds = target.getBoundingClientRect();
      if (!bounds.width || !bounds.height) setRing(null);
      else setRing(bounds);
    };
    const timer = window.setTimeout(() => setRing(null), 3500);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [hasRing]);

  async function exitTutorial() {
    if (exiting.current) return;
    exiting.current = true;
    setBusy(true);
    try {
      const result = await window.patentApi.application.requestQuit?.();
      if (!result?.ok)
        throw new Error(
          result && !result.ok ? result.error.message : "无法退出教学，请关闭教学窗口后重试。",
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "退出教学失败，请重试。");
      setCollapsed(false);
      setBusy(false);
      exiting.current = false;
    }
  }
  async function enter(id: TutorialLessonId, reset = false) {
    if (!api || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (
        isSession &&
        context &&
        (reset || !success) &&
        props.patent &&
        !(await confirmAppAction(
          reset
            ? "重新练习会恢复本课的原始示例，当前练习修改将不保留。"
            : "切换课程会载入新的练习材料，当前练习修改将不保留。",
        ))
      )
        return;
      setError("");
      setHint("");
      setRing(null);
      if (!isSession) {
        const result = await api.launch(id);
        if (!result.ok) throw new Error("教学窗口未能准备好。请稍后重试；当前专利保持不变。");
      } else {
        if (context && !(await callbacks.current.onClose(context.patentId)))
          throw new Error("当前练习尚未关闭，请检查保存提示后重试。");
        const result = await api.prepare(id);
        if (!result.ok) throw new Error(result.error.message);
        setContext(result.value);
        setSelected(id);
        setCopied(null);
        await callbacks.current.onOpen(result.value.patentId, tutorialLesson(id).book);
      }
      setDirectory(false);
      setCollapsed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "练习准备失败，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function locate() {
    if (!context || busy) return;
    setHint("");
    try {
      await callbacks.current.onNavigate(lesson.book);
      const toggle = visibleGuidanceTarget(
        document,
        ".patent-global-function-rail__collapsed-toggle",
      );
      toggle?.click();
      // The existing rail retains its own expansion motion; wait for its target to become visible.
      const start = Date.now();
      let target: HTMLElement | null = null;
      while (!target && Date.now() - start < 1000) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        target = visibleGuidanceTarget(document, lesson.selector);
      }
      if (!target) {
        setHint("请展开右侧功能栏，按本课提示找到对应工具。");
        return;
      }
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      ringTarget.current = target;
      setRing(target.getBoundingClientRect());
      setHint("蓝色框已标出工具位置。请在正文或图纸中完成操作。");
    } catch {
      setHint("请先打开本课示例，再定位工具。");
    }
  }
  if (!api) return null;
  return createPortal(
    <>
      {isSession && (
        <div className="tool-tutorial-banner" role="status">
          <span>
            <GraduationCap size={17} />
            <strong>快速工具教程</strong>
            <i />
            示例专利 · 本次修改仅用于教学
          </span>
          <button type="button" onClick={() => setDirectory(true)}>
            <LayoutGrid size={15} />
            课程目录
          </button>
        </div>
      )}
      <SpatialPresence>
        {directory && (
          <StandardDialog
            open
            title="快速工具教程"
            subtitle="在真实工具中动手练习，掌握专利撰写的专属功能。"
            size="xl"
            className="tool-tutorial-dialog"
            bodyClassName="tool-tutorial-directory"
            closeDisabled={!isSession && busy}
            onCancel={() => {
              if (isSession) void exitTutorial();
              else setDirectory(false);
            }}
            footer={
              <>
                <span className="tool-tutorial-footer-note">
                  {isSession
                    ? "每课都有独立的起始材料。"
                    : "点击进入练习，即同意打开独立教学窗口。"}
                </span>
                {isSession && (
                  <button type="button" disabled={busy} onClick={() => setDirectory(false)}>
                    返回练习
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void enter(selected)}
                >
                  {busy ? "正在准备教学窗口…" : isSession ? "开始这项练习" : "进入练习"}
                  {!busy && <ArrowRight size={16} />}
                </button>
              </>
            }
          >
            <aside className="tool-tutorial-intro">
              <div className="tool-tutorial-eyebrow">
                <Compass size={15} />
                快速工具教程
              </div>
              <h2>
                从知道工具，
                <br />
                到熟练使用。
              </h2>
              <p>用一份示例专利，练习文字处理软件中少见的专利撰写功能。</p>
              <div className="tool-tutorial-sample">
                <div>
                  <BookOpen size={18} />
                  <span>教学示例</span>
                  <span className="tool-tutorial-sample-tag">虚构材料</span>
                </div>
                <strong>可调节夹持装置</strong>
                <p>底座 · 夹持板 · 调节杆</p>
                <div className="tool-tutorial-mini-drawing" aria-hidden="true">
                  <svg viewBox="0 0 260 100">
                    <title>夹持装置示意图</title>
                    <path d="M25 72H232V86H25Z M65 23H144V72H65Z M144 45H205V57H144Z M205 33H222V66H205Z" />
                    <path d="M75 35H132 M40 79H220" />
                  </svg>
                </div>
              </div>
              <div className="tool-tutorial-isolation">
                <ShieldCheck size={20} />
                <div>
                  <strong>安心练习，独立隔离</strong>
                  <p>不会在正式专利库生成文件。每次新进入恢复原始示例；当前工作窗口继续保留。</p>
                </div>
              </div>
              <p className="tool-tutorial-clipboard-note">
                转换课程使用系统剪贴板。教学内容是起稿示例，仍需专业核对。
              </p>
              {!isSession && props.patent && (
                <button
                  type="button"
                  className="tool-tutorial-quick"
                  disabled={busy}
                  onClick={() => {
                    setDirectory(false);
                    window.dispatchEvent(new Event(GUIDANCE_QUICK_EVENT));
                  }}
                >
                  查看原有撰写路线
                  <ChevronRight size={14} />
                </button>
              )}
            </aside>
            <div className="tool-tutorial-courses">
              <div className="tool-tutorial-courses-heading">
                <strong>选择一项开始</strong>
                <span>9 项专属工具 · 可自由选择</span>
              </div>
              {["文字整理", "权利要求", "附图标记", "图纸"].map((group) => (
                <section key={group}>
                  <h3>{group}</h3>
                  <div>
                    {TUTORIAL_LESSONS.filter((item) => item.group === group).map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`tool-tutorial-course ${selected === item.id ? "is-selected" : ""}`}
                        aria-pressed={selected === item.id}
                        disabled={busy}
                        onClick={() => setSelected(item.id)}
                      >
                        <span className="tool-tutorial-course-number">
                          {completed.has(item.id) ? (
                            <Check size={16} />
                          ) : (
                            String(TUTORIAL_LESSONS.indexOf(item) + 1).padStart(2, "0")
                          )}
                        </span>
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.summary}</small>
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {error && (
                <p role="alert" className="tool-tutorial-error">
                  {error}
                </p>
              )}
            </div>
          </StandardDialog>
        )}
      </SpatialPresence>
      {isSession && (
        <section
          className={`tool-tutorial-coach ${collapsed ? "is-collapsed" : ""}`}
          ref={drag.surfaceRef}
          style={{ ...drag.style, ...(drag.style.top !== undefined ? { bottom: "auto" } : {}) }}
          aria-label="快速工具教程任务"
        >
          <header ref={drag.titleBarRef} onPointerDown={drag.onPointerDown}>
            <span>
              <GraduationCap size={18} />
              <strong>快速工具教程</strong>
              <small>{String(index + 1).padStart(2, "0")} / 09</small>
            </span>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              aria-label={collapsed ? "展开练习引导" : "折叠练习引导"}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
            >
              <ChevronDown size={17} />
            </button>
            <button
              type="button"
              aria-label="关闭教程"
              title="退出教学"
              onClick={() => void exitTutorial()}
            >
              <X size={16} />
            </button>
            <GripHorizontal className="tool-tutorial-grip" size={15} aria-hidden="true" />
          </header>
          <SpatialCollapse open={!collapsed}>
            <div className="tool-tutorial-coach-body">
              <div className="tool-tutorial-coach-group">{lesson.group}</div>
              <h2>{lesson.title}</h2>
              <p>{lesson.summary}</p>
              <ol>
                {lesson.steps.map((step, at) => (
                  <li key={step}>
                    <span>{success ? <Check size={12} /> : at + 1}</span>
                    {step}
                  </li>
                ))}
              </ol>
              <div className={`tool-tutorial-result ${success ? "is-success" : ""}`} role="status">
                {busy ? (
                  "正在准备练习材料…"
                ) : success ? (
                  <>
                    <Check size={17} />
                    {lesson.result}
                  </>
                ) : (
                  "完成操作后，这里会显示检查结果。"
                )}
              </div>
              {error && (
                <p className="tool-tutorial-error" role="alert">
                  {error}
                  <button
                    type="button"
                    disabled={busy || !context}
                    onClick={() => {
                      if (context)
                        void callbacks.current
                          .onOpen(context.patentId, lesson.book)
                          .then(() => setError(""))
                          .catch((cause: unknown) =>
                            setError(
                              cause instanceof Error ? cause.message : "示例打开失败，请重试。",
                            ),
                          );
                    }}
                  >
                    重新打开示例
                  </button>
                </p>
              )}
              {hint && (
                <p className="tool-tutorial-hint" role="status">
                  {hint}
                </p>
              )}
              <div className="tool-tutorial-coach-actions">
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={busy || !context}
                  onClick={() => void locate()}
                >
                  <LocateFixed size={15} />
                  定位工具
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !success}
                  onClick={() => {
                    const next = TUTORIAL_LESSONS[index + 1];
                    if (next) void enter(next.id);
                    else void exitTutorial();
                  }}
                >
                  {index === 8 ? "完成教学" : "下一项"}
                  <ArrowRight size={15} />
                </button>
              </div>
              <footer>
                <button
                  type="button"
                  disabled={busy || !context}
                  onClick={() => void enter(lesson.id, true)}
                >
                  <RotateCcw size={13} />
                  重新练习
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSelected(lesson.id);
                    setDirectory(true);
                  }}
                >
                  <LayoutGrid size={13} />
                  目录
                </button>
                <button type="button" disabled={busy} onClick={() => void exitTutorial()}>
                  <X size={13} />
                  {success ? "完成教学" : "退出教学"}
                </button>
              </footer>
            </div>
          </SpatialCollapse>
        </section>
      )}
      <SpatialPresence>
        {ring && !directory && (
          <div
            className="tool-tutorial-ring"
            aria-hidden="true"
            style={{
              left: ring.left - 4,
              top: ring.top - 4,
              width: ring.width + 8,
              height: ring.height + 8,
            }}
          />
        )}
      </SpatialPresence>
    </>,
    document.body,
  );
}
