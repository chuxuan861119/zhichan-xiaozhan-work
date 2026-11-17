import {
  BookOpen,
  Bot,
  Braces,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Eraser,
  FileInput,
  FilePenLine,
  FileSearch,
  Files,
  FolderOpen,
  Image,
  LayoutTemplate,
  ListPlus,
  Monitor,
  PanelTop,
  Rocket,
  Scale,
  Settings2,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAgentCliAvailable, isNetworkAiAvailable } from "../../../shared/platform";
import { AiExperimentalNotice } from "./ai-experimental-notice";
import logo from "./clear-format-help-assets/logo-outline.png";
import { SpatialCollapse } from "./spatial-collapse";
import { StandardDialog } from "./standard-dialog";
import { ManualText, manualChapters, manualEntry, manualPages } from "./user-manual-content";
import { ManualExample } from "./user-manual-examples";
import "./user-guide-dialog.css";

const groups = [
  { title: "开始使用", start: 0, end: 6 },
  { title: "撰写与检查", start: 6, end: 14 },
  { title: "设置与数据", start: 14, end: 19 },
  { title: "查阅与支持", start: 19, end: 21 },
];
const directoryTitles: Record<string, string> = {
  认识工作界面: "认识界面",
  "启动、托盘与退出": "启动与退出",
  管理专利库: "专利库",
  导入现有文档: "导入文档",
  "五书、其他文档与同屏双显": "五书与双显",
  文字编辑与格式整理: "文字与格式",
  权利要求与说明书辅助写作: "权利要求与说明书",
  "附图、附图说明与附图标记": "附图与标记",
  "表格、公式与化学结构式": "表格、公式与结构式",
  AI纠错与小栈AI助手: "AI纠错与助手",
  "保存、快照与定时备份": "保存与备份",
  "法律法规、IPC与帮助工具": "法规与查询工具",
  常见问题与安全建议: "常见问题",
  一件专利的推荐写作顺序: "推荐写作顺序",
  关闭窗口不等于退出: "关闭与退出",
  "结构标尺、字数与缩放": "标尺、字数与缩放",
  发明内容开头设置: "段落开头设置",
  图片与对象的编辑边界: "图片与对象编辑",
  "常用官方网站、版本和第三方声明": "网站、版本与许可",
  点击关闭后软件仍在运行: "关闭后仍在运行",
  为什么某个按钮不可用: "按钮不可用",
  "点了说明书转换，但正文没有变化": "转换后正文未变化",
  增补编号提示无需增补: "提示无需增补",
  保存失败或编辑界面报错: "保存失败与报错",
  完整数据包无法导入: "数据包导入失败",
  反馈问题时提供什么: "如何反馈问题",
};
const presentation = [
  { icon: Rocket, summary: "从新建到交付，完成第一件专利。" },
  { icon: PanelTop, summary: "认识菜单、工具栏和功能介绍面板。" },
  { icon: Monitor, summary: "随时回到工作台，需要时再彻底退出。" },
  { icon: FolderOpen, summary: "集中管理专利，快速找到需要的文档。" },
  { icon: FileInput, summary: "导入原生专利文件，或从 Word 文档开始。" },
  { icon: Files, summary: "切换五书、管理其他文档，并排对照编辑。" },
  { icon: FilePenLine, summary: "调整文字与段落，一键整理多余格式。" },
  { icon: ListPlus, summary: "插入从权，辅助生成说明书草稿。" },
  { icon: Image, summary: "管理附图、标记与 CAD 标号，让图文对应。" },
  { icon: Braces, summary: "插入表格、公式与可继续编辑的化学结构式。" },
  { icon: Workflow, summary: "绘制流程图与电路图，保留工程数据。" },
  { icon: FileSearch, summary: "检查文字、编号与标点等常见格式性问题。" },
  { icon: Bot, summary: "综合检查、连续对话，辅助完善专利文档。" },
  { icon: Bot, summary: "授权外部 Agent 接入本机工作台，按范围执行任务。" },
  { icon: LayoutTemplate, summary: "将常用写作结构保存为自己的模板。" },
  { icon: Settings2, summary: "按写作习惯调整显示、操作与保护策略。" },
  { icon: ShieldCheck, summary: "分清保存、快照与备份，保护每一次修改。" },
  { icon: FolderOpen, summary: "用加密数据包把整个专利库迁入新电脑。" },
  { icon: Download, summary: "选择交付格式，核对版式后导出或打印。" },
  { icon: Scale, summary: "查阅法规、分类资料与常用官方来源。" },
  { icon: CircleHelp, summary: "遇到问题时，先保护资料，再按提示处理。" },
];

export function UserGuideDialog({ onClose }: { onClose(): void }) {
  const cliAvailable = isAgentCliAvailable();
  const pages = useMemo(
    () =>
      manualPages.filter((page) => {
        const title = manualEntry(manualChapters, page.chapterIndex).title;
        return (
          (cliAvailable || title !== "Agent CLI") &&
          (isNetworkAiAvailable() ||
            (title !== "AI纠错与小栈AI助手" &&
              !["AI连接失败", "AI Key 的系统保护与授权"].includes(page.title)))
        );
      }),
    [cliAvailable],
  );
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(0);
  const contentRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const page = manualEntry(pages, selected);
  const chapter = manualEntry(manualChapters, page.chapterIndex);
  const { icon: ChapterIcon, summary } = manualEntry(presentation, page.chapterIndex);
  const Icon = page.title === "清除多余格式" ? Eraser : ChapterIcon;
  useEffect(() => {
    if (expanded !== manualEntry(pages, selected).chapterIndex) return;
    const navigation = navigationRef.current;
    const active = navigation?.querySelector('[aria-current="page"]');
    if (!navigation || !active) return;
    const bounds = navigation.getBoundingClientRect();
    const target = active.getBoundingClientRect();
    if (target.bottom > bounds.bottom) navigation.scrollTop += target.bottom - bounds.bottom + 12;
    else if (target.top < bounds.top) navigation.scrollTop -= bounds.top - target.top + 12;
  }, [selected, expanded, pages]);
  const goTo = (index: number) => {
    setSelected(index);
    setExpanded(manualEntry(pages, index).chapterIndex);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };
  return (
    <StandardDialog
      open
      title="使用手册"
      size="xl"
      movable
      modeless
      resizable
      className="user-guide-window"
      onCancel={onClose}
      bodyClassName="user-guide"
    >
      <nav ref={navigationRef} className="user-guide__chapters" aria-label="手册目录">
        <div className="manual-nav-title">
          <BookOpen size={17} strokeWidth={1.5} aria-hidden="true" />
          知产小栈Work
        </div>
        {groups.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            {manualChapters.slice(group.start, group.end).map((item, offset) => {
              const chapterIndex = group.start + offset;
              const NavIcon = manualEntry(presentation, chapterIndex).icon;
              const chapterPages = pages
                .map((entry, index) => ({ ...entry, index }))
                .filter((entry) => entry.chapterIndex === chapterIndex);
              if (chapterPages.length === 0) return null;
              const single = chapterPages.length === 1;
              return (
                <div key={item.title} className="manual-chapter">
                  <button
                    type="button"
                    aria-label={item.title}
                    aria-expanded={single ? undefined : expanded === chapterIndex}
                    aria-current={single && page.chapterIndex === chapterIndex ? "page" : undefined}
                    className={
                      page.chapterIndex === chapterIndex ? "manual-chapter-active" : undefined
                    }
                    onClick={() => {
                      if (single) goTo(manualEntry(chapterPages, 0).index);
                      else setExpanded(expanded === chapterIndex ? -1 : chapterIndex);
                    }}
                  >
                    <NavIcon size={17} strokeWidth={1.5} aria-hidden="true" />
                    <span>{directoryTitles[item.title] ?? item.title}</span>
                    {!single && (
                      <ChevronDown
                        size={12}
                        className="manual-chapter-chevron"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  <SpatialCollapse open={!single && expanded === chapterIndex}>
                    <div className="manual-features">
                      {chapterPages.map((entry) => (
                        <button
                          type="button"
                          key={entry.index}
                          aria-label={
                            entry.title === item.title ? `${entry.title}概览` : entry.title
                          }
                          aria-current={selected === entry.index ? "page" : undefined}
                          onClick={() => goTo(entry.index)}
                        >
                          <span className="manual-feature-dot" aria-hidden="true" />
                          <span>
                            {entry.title === item.title
                              ? "概览"
                              : (directoryTitles[entry.title] ?? entry.title)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </SpatialCollapse>
                </div>
              );
            })}
          </section>
        ))}
      </nav>
      <div className="manual-reader">
        <article
          className="user-guide__content"
          ref={contentRef}
          aria-label={page.title}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable article supports keyboard scrolling.
          tabIndex={0}
        >
          <div className="manual-page" key={selected}>
            <header className="manual-hero">
              <svg
                className="manual-brand"
                viewBox="112 302 1028 696"
                preserveAspectRatio="xMaxYMid meet"
                aria-hidden="true"
              >
                {/* Exclude the bundled image's transparent margins, not the logo strokes. */}
                <image href={logo} width="1254" height="1254" />
              </svg>
              <div className="manual-eyebrow">
                {chapter.title}
                <span />
                功能指南
              </div>
              <h3>
                <Icon size={27} strokeWidth={1.5} aria-hidden="true" />
                {page.title}
              </h3>
              {page.chapterIndex === 12 && <AiExperimentalNotice feature={page.title} />}
              {page.title === chapter.title && <p>{summary}</p>}
            </header>
            {page.chapterIndex === 12 && (
              <aside className="manual-warning" role="note" aria-label="AI使用提醒">
                <ShieldCheck size={19} strokeWidth={1.5} aria-hidden="true" />
                <p>
                  <strong>需要注意：</strong>本功能需先配置 AI
                  模型；本功能运行时，会将文档或选中的文字上传至您配置的模型提供商，不建议将带有技术秘密的文档直接上传，请谨慎使用。
                </p>
              </aside>
            )}
            {["快速上手", "本地检查", "导出完整数据包"].includes(page.title) && (
              <section className="manual-card">
                <ManualExample
                  topic={page.title === "导出完整数据包" ? "完整数据迁移" : page.title}
                />
              </section>
            )}
            {page.intro && (
              <section className="manual-card">
                <ManualText text={page.intro} />
              </section>
            )}
            {page.sections.map((section, index) => (
              <section className="manual-card" key={section.title}>
                {(index > 0 || page.sections.length > 1) && <h4>{section.title}</h4>}
                <ManualExample topic={section.title} />
                <ManualText text={section.content} />
              </section>
            ))}
          </div>
        </article>
        <footer className="manual-pagination">
          <button
            type="button"
            aria-label="上一页"
            disabled={selected === 0}
            onClick={() => goTo(selected - 1)}
          >
            <ChevronLeft size={17} aria-hidden="true" />
            <span>上一页</span>
          </button>
          <div>
            <BookOpen size={15} strokeWidth={1.5} aria-hidden="true" />
            <span role="status" aria-label="手册页码" aria-live="polite">
              {selected + 1} / {pages.length}
            </span>
          </div>
          <button
            type="button"
            aria-label="下一页"
            disabled={selected === pages.length - 1}
            onClick={() => goTo(selected + 1)}
          >
            <span>下一页</span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </footer>
      </div>
    </StandardDialog>
  );
}
