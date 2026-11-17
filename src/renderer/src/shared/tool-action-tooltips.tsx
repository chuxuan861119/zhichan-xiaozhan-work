import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { platformEditorShortcut, platformShortcut } from "../../../shared/platform";
import {
  CUSTOM_SHORTCUT_ACTIONS,
  fixedShortcutsFor,
  type ShortcutSettings,
} from "../../../shared/settings/shortcuts";
import { CAD_MARKUP_HELP_TARGET, CadMarkupHelp } from "./cad-markup-help";
import { CLEAR_FORMAT_HELP_TARGET, ClearFormatHelp } from "./clear-format-help";
import { DEPENDENT_CLAIM_HELP_TARGET, DependentClaimHelp } from "./dependent-claim-help";
import { DESCRIPTION_HELP_TARGET, DescriptionHelp } from "./description-help";
import { DRAWING_AI_HELP_TARGET, DrawingAiHelp } from "./drawing-ai-help";
import { DRAWING_LIST_HELP_TARGET, DrawingListHelp } from "./drawing-list-help";
import { NUMBER_BRACKETS_HELP_TARGET, NumberBracketsHelp } from "./number-brackets-help";
import { QUICK_CHECK_HELP_TARGET, QuickCheckHelp } from "./quick-check-help";
import { REFERENCE_NUMBER_HELP_TARGET, ReferenceNumberHelp } from "./reference-number-help";
import { SUPPLEMENT_NUMBER_HELP_TARGET, SupplementNumberHelp } from "./supplement-number-help";
import "./tool-action-tooltips.css";
import { SpatialPresence } from "./spatial-presence";

const CHEMISTRY_SCOPE =
  '.ketcher-editor-shell :is([data-testid="top-toolbar"], [data-testid="left-toolbar"], [data-testid="right-toolbar"], [data-testid="bottom-toolbar"])';
const MINI_TOOLS_SCOPE = ".editor-menu-surface .editor-mini-format";
const SCOPE = `.tool-bar, .patent-global-function-rail-slot, ${CHEMISTRY_SCOPE}, ${MINI_TOOLS_SCOPE}`;
const DESCRIPTIONS: Record<string, string> = {
  新建: "新建专利文档",
  "导入 PATDOC": "打开本地专利文件",
  保存: "保存当前专利",
  导出: "选择文档导出格式",
  打印: "打开打印预览",
  撤销: "撤销上一步操作",
  重做: "恢复已撤销的操作",
  粗体: "加粗所选文字",
  斜体: "倾斜所选文字",
  下划线: "为所选文字添加下划线",
  上标: "将所选文字设为上标",
  下标: "将所选文字设为下标",
  左对齐: "段落靠左对齐",
  居中: "段落居中对齐",
  右对齐: "段落靠右对齐",
  两端对齐: "段落左右两端对齐",
  项目符号: "切换项目符号列表",
  编号: "切换有序列表",
  查找: "查找文档中的文字",
  替换: "查找并替换文字",
  更多工具: "展开其余工具",
  清除多余格式: "清理正文中的多余格式",
  本地检查: "检查文字、编号与标点等常见格式性问题",
  "AI 纠错": "使用 AI 检查文字问题",
  小栈AI助手: "起草、润色和讨论专利内容",
  顺序编号: "为所选关键词顺序编号",
  自定义编号: "为所选关键词指定编号",
  插入从权: "插入一条从属权利要求",
  说明书: "将权利要求整理为说明书段落",
  发明内容: "复制发明内容段落并跳转",
  具体实施方式: "复制实施方式段落并跳转",
  附图排序: "调整附图排列顺序",
  导入图片: "导入图片作为附图",
  填入说明书: "将附图标记填入说明书",
  定位问题: "跳转并高亮问题位置",
  移出标记: "移出登记，保留正文和编号",
  上一处: "定位上一处问题",
  下一处: "定位下一处问题",
};

export function toolActionDetails(button: HTMLElement, settings: ShortcutSettings, title: string) {
  const label = (button.getAttribute("aria-label") || button.textContent || title)
    .replace(/\s+/gu, " ")
    .trim();
  const compact = Boolean(button.closest(MINI_TOOLS_SCOPE));
  if (compact) return { label, description: label, shortcut: "", compact };
  const actionLabel = label === "完成排序" ? "附图排序" : label;
  const custom = CUSTOM_SHORTCUT_ACTIONS.find((action) => action.label === actionLabel);
  // A rail "复制" copies a complete list, unlike the editor's Ctrl+C selection command.
  const shortcuts = custom
    ? settings[custom.id]
      ? [settings[custom.id]]
      : []
    : button.closest(".tool-bar, .table-rail-panel")
      ? fixedShortcutsFor(label)
      : [];
  const hint = title.split("\n")[0]?.trim() ?? "";
  const usableHint =
    hint &&
    hint !== label &&
    !/^(?:未设置快捷键|快捷键[：:]|(?:Ctrl|Alt|Shift)\+)/u.test(hint) &&
    !hint.startsWith(`${label}（`);
  const disabled = button.matches(":disabled, [aria-disabled='true']");
  const list = button.closest(".drawing-explanation-rail")
    ? "附图说明"
    : button.closest(".reference-mark-panel")
      ? "附图标记"
      : null;
  const listDescription =
    list && (label === "复制" || label === "填入说明书")
      ? label === "复制"
        ? `复制${list}到剪贴板`
        : `将${list}填入说明书`
      : null;
  return {
    label,
    compact,
    description:
      disabled && usableHint
        ? hint
        : listDescription || DESCRIPTIONS[label] || (usableHint ? hint : label),
    shortcut:
      [
        ...new Set(
          shortcuts
            .filter((value): value is string => typeof value === "string")
            .map((value) => (custom ? platformShortcut(value) : platformEditorShortcut(value))),
        ),
      ].join(" / ") || (custom ? "暂未设置快捷键" : ""),
  };
}

export function tooltipPosition(
  anchor: DOMRect,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const gap = 8;
  const left = Math.max(gap, Math.min(anchor.left, viewportWidth - width - gap));
  const top =
    anchor.bottom + gap + height <= viewportHeight - gap
      ? anchor.bottom + gap
      : Math.max(gap, anchor.top - height - gap);
  return { left, top };
}

export function ToolActionTooltips({ settings }: { settings: ShortcutSettings }) {
  const id = useId();
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{
    button: HTMLElement;
    details: ReturnType<typeof toolActionDetails>;
  } | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  useEffect(() => {
    let active: HTMLElement | null = null;
    let trigger: "pointer" | "focus" = "pointer";
    let savedTitle: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      setTip(null);
      if (active) {
        const descriptions = (active.getAttribute("aria-describedby") || "")
          .split(" ")
          .filter((part) => part && part !== id);
        if (descriptions.length) active.setAttribute("aria-describedby", descriptions.join(" "));
        else active.removeAttribute("aria-describedby");
      }
    };
    const reset = () => {
      hide();
      if (active) {
        if (savedTitle !== null && !active.hasAttribute("title"))
          active.setAttribute("title", savedTitle);
      }
      active = null;
      savedTitle = null;
    };
    const targetButton = (target: EventTarget | null) => {
      const button =
        target instanceof Element
          ? target.closest<HTMLElement>("button, [role='button'], [role='switch']")
          : null;
      if (
        document.documentElement.dataset.referenceMarkDragging === "true" &&
        button?.matches(".reference-mark-panel__drag-handle")
      )
        return null;
      return button?.closest(SCOPE) &&
        !button.closest('[data-tool-tooltip="off"]') &&
        !button.matches(".patent-global-function-rail__collapsed-toggle") &&
        (!button.closest("[role='dialog']") || button.closest(CHEMISTRY_SCOPE)) &&
        !button.matches(DEPENDENT_CLAIM_HELP_TARGET) &&
        !button.matches(NUMBER_BRACKETS_HELP_TARGET) &&
        !button.matches(DESCRIPTION_HELP_TARGET) &&
        !button.matches(SUPPLEMENT_NUMBER_HELP_TARGET) &&
        !button.matches(DRAWING_AI_HELP_TARGET) &&
        !button.matches(REFERENCE_NUMBER_HELP_TARGET) &&
        !button.matches(DRAWING_LIST_HELP_TARGET) &&
        !button.matches(CAD_MARKUP_HELP_TARGET) &&
        !button.matches(CLEAR_FORMAT_HELP_TARGET) &&
        !button.matches(QUICK_CHECK_HELP_TARGET)
        ? button
        : null;
    };
    const enter = (event: Event) => {
      // The editor may restore its focus asynchronously after a rail action.
      // This must not dismiss a tooltip while the pointer stays on a button.
      if (event.type === "focusin" && active && trigger === "pointer") return;
      trigger = event.type === "focusin" ? "focus" : "pointer";
      const button = targetButton(event.target);
      if (button === active) return;
      reset();
      if (!button) return;
      active = button;
      savedTitle = button.getAttribute("title");
      const details = toolActionDetails(button, settings, savedTitle ?? "");
      if (!details.label) return;
      button.removeAttribute("title");
      timer = setTimeout(
        () => {
          if (!button.isConnected) {
            reset();
            return;
          }
          button.setAttribute(
            "aria-describedby",
            [button.getAttribute("aria-describedby"), id].filter(Boolean).join(" "),
          );
          setTip({ button, details });
        },
        button.closest(CHEMISTRY_SCOPE) ? 120 : 350,
      );
    };
    const leave = (event: PointerEvent | FocusEvent) => {
      if ((event.type === "focusout") !== (trigger === "focus")) return;
      if (!(event.target instanceof Node) || !active?.contains(event.target)) return;
      if (active && !(event.relatedTarget instanceof Node && active.contains(event.relatedTarget)))
        reset();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
      if (event.key === "Tab") reset();
    };
    // Capture also covers disabled controls and dynamically mounted rail panels, without wrappers.
    document.addEventListener("pointermove", enter, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusin", enter, true);
    document.addEventListener("focusout", leave, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("scroll", reset, true);
    window.addEventListener("resize", reset);
    window.addEventListener("blur", reset);
    const observer = new MutationObserver(() => {
      if (active && !active.isConnected) reset();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      reset();
      document.removeEventListener("pointermove", enter, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusin", enter, true);
      document.removeEventListener("focusout", leave, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("scroll", reset, true);
      window.removeEventListener("resize", reset);
      window.removeEventListener("blur", reset);
    };
  }, [settings, id]);

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return;
    const rect = tipRef.current.getBoundingClientRect();
    setPosition(
      tooltipPosition(
        tip.button.getBoundingClientRect(),
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [tip]);

  return (
    <>
      <ClearFormatHelp settings={settings} />
      <NumberBracketsHelp />
      <QuickCheckHelp settings={settings} />
      <DependentClaimHelp settings={settings} />
      <DescriptionHelp />
      <SupplementNumberHelp settings={settings} />
      <DrawingAiHelp settings={settings} />
      <ReferenceNumberHelp settings={settings} />
      <DrawingListHelp />
      <CadMarkupHelp settings={settings} />
      {createPortal(
        <SpatialPresence>
          {tip ? (
            <div
              id={id}
              role="tooltip"
              ref={tipRef}
              className={`tool-action-tooltip${tip.details.compact ? " tool-action-tooltip--compact" : ""}`}
              style={position}
            >
              <span className="tool-action-tooltip__description">{tip.details.description}</span>
              {tip.details.shortcut ? (
                <span className="tool-action-tooltip__shortcut">
                  {tip.details.shortcut === "暂未设置快捷键" ? (
                    tip.details.shortcut
                  ) : (
                    <>
                      快捷键：<kbd>{tip.details.shortcut}</kbd>
                    </>
                  )}
                </span>
              ) : null}
            </div>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </>
  );
}
