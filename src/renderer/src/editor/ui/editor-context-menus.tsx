import type { Editor } from "@tiptap/core";
import { NodeSelection, type SelectionBookmark } from "@tiptap/pm/state";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Italic,
  Redo2,
  Scissors,
  Search,
  Settings2,
  Sigma,
  Subscript,
  Superscript,
  Table2,
  Trash2,
  Underline,
  Undo2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  defaultDocumentFontSizePt,
  displayDocumentFont,
  documentFontOptions,
} from "../../../../shared/document/font-policy";
import { platformEditorShortcut } from "../../../../shared/platform";
import type { EditorCommandBus } from "../../app/command-bus";
import { useOptionalPatentFunctionRail } from "../../patents/function-rail/function-rail-context";
import { showAppAlert } from "../../shared/app-dialog";
import { createSpatialFloatingPaintMotion } from "../../shared/spatial-floating-paint-motion";
import { SpatialPresence } from "../../shared/spatial-presence";
import type { EditorCommand } from "../commands";
import { inspectionSelectionKey } from "../extensions/inspection-selection";
import type { TableCommand } from "../table/table-commands";
import { pasteIntoMenuEditor, runMenuClipboard, selectContextTarget } from "./editor-menu-state";
import "./editor-context-menus.css";
import "./toolbar-dropdowns.css";
import { ColorPicker } from "./color-picker";
import { EditorObjectTools } from "./editor-object-tools";
import { ToolbarSelectButton } from "./toolbar-select-button";

const PREFERENCE_KEY = "pwb-selection-toolbar-enabled";
const PREFERENCE_EVENT = "pwb-selection-toolbar-change";
const appendMenuToBody = () => document.body;
function readPreference() {
  try {
    return localStorage.getItem(PREFERENCE_KEY) !== "false";
  } catch {
    return true;
  }
}
type Props = {
  editor: Editor;
  editorId: string;
  commandBus: EditorCommandBus;
  onFind?(mode: "find" | "replace", text?: string): void;
  onNumber?(): void;
  onDependentClaim?(): void;
  onEditObject?(position: number): void;
};
type Context = { x: number; y: number; keyboard: boolean };

export function EditorContextMenus(props: Props) {
  const { editor, editorId, commandBus } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const [context, setContext] = useState<Context | null>(null);
  const [section, setSection] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(readPreference);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [, refresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const fixedPosition = useRef<{ left: string; top: string } | null>(null);
  const bookmark = useRef<SelectionBookmark | null>(null);
  const applying = useRef(false);
  const blocked = useRef(false);
  const dragging = useRef(false);
  const bubbleVisible = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      // Tiptap can finish a queued selection update after unregistering its
      // plugin. A retained editor must not reattach this emptied React portal.
      mounted.current = false;
    };
  }, []);
  const contextRef = useRef(context);
  contextRef.current = context;
  const rail = useOptionalPatentFunctionRail();
  const key = `selection-menu-${editorId}`;
  const scope = useCallback(
    () =>
      editor.view.dom.closest<HTMLElement>(
        "[data-function-rail-scope], .standard-workspace-pane",
      ) ?? document.body,
    [editor],
  );
  const visible = useCallback(
    () => !editor.isDestroyed && editor.view.dom.getClientRects().length > 0,
    [editor],
  );
  const close = () => {
    setContext(null);
    setSection(null);
    blocked.current = true;
  };

  const shouldShow = useCallback(
    () =>
      mounted.current &&
      enabledRef.current &&
      !inspectionSelectionKey.getState(editor.state) &&
      !blocked.current &&
      !dragging.current &&
      !contextRef.current &&
      visible() &&
      editor.isEditable &&
      !editor.view.composing &&
      commandBus.hasNonEmptyTextSelection(editorId) &&
      (editor.isFocused || !!bubble.current?.contains(document.activeElement)) &&
      !document.querySelector("[aria-modal='true']"),
    [editor, editorId, commandBus, visible],
  );
  const floatingMotion = useMemo(() => createSpatialFloatingPaintMotion(), []);
  useEffect(() => () => floatingMotion.dispose(), [floatingMotion]);
  // Stable props avoid a plugin-update transaction / parent-render feedback loop.
  const positioning = useMemo(
    () => ({
      strategy: "fixed" as const,
      placement: "top" as const,
      offset: 8,
      // The editor survives layout switches, but its pane/scope does not.
      // Resolve the current boundary for every Floating UI calculation.
      shift: () => ({ boundary: scope(), padding: 8 }),
      flip: () => ({ boundary: scope(), padding: 8 }),
      onShow: () => {
        bubbleVisible.current = true;
        const element = bubble.current;
        if (!element) return;
        floatingMotion.prepare();
        // BubbleMenu attaches visibly before its asynchronous position calculation.
        // Keep the previous coordinates hidden until onUpdate supplies the new ones.
        element.style.visibility = "hidden";
        element.style.opacity = "0";
        queueMicrotask(() => {
          if (!editor.isDestroyed && element.isConnected)
            editor.view.dispatch(editor.state.tr.setMeta(key, "updatePosition"));
        });
      },
      onHide: () => {
        bubbleVisible.current = false;
        if (bubble.current) floatingMotion.exit(bubble.current);
        fixedPosition.current = null;
      },
      onUpdate: () => {
        const element = bubble.current;
        if (!element) return;
        // Only formatting locks the controls under the pointer. New selections
        // and asynchronous positioning corrections must use their own coordinates.
        if (fixedPosition.current) {
          element.style.left = fixedPosition.current.left;
          element.style.top = fixedPosition.current.top;
        }
        element.style.opacity = "1";
        floatingMotion.enter(element);
      },
    }),
    [scope, editor, key, floatingMotion],
  );
  useEffect(() => {
    const preference = () => setEnabled(readPreference());
    window.addEventListener(PREFERENCE_EVENT, preference);
    return () => window.removeEventListener(PREFERENCE_EVENT, preference);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poke = () => {
      if (editor.isDestroyed) return;
      const show = shouldShow();
      if (show !== bubbleVisible.current)
        editor.view.dispatch(editor.state.tr.setMeta(key, show ? "show" : "hide"));
    };
    const dismiss = () => {
      blocked.current = true;
      setContext(null);
      setSection(null);
      poke();
    };
    const selection = () => {
      if (applying.current) return;
      fixedPosition.current = null;
      blocked.current = false;
      setContext(null);
      setSection(null);
      bookmark.current = editor.state.selection.getBookmark();
      refresh((value) => value + 1);
    };
    const transaction = ({
      transaction: tr,
    }: {
      transaction: import("@tiptap/pm/state").Transaction;
    }) => {
      if (applying.current) return;
      if (tr.docChanged) dismiss();
    };
    const pointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (root.current?.contains(event.target) || bubble.current?.contains(event.target)) return;
      if (!editor.view.dom.contains(event.target)) {
        if (contextRef.current || bubbleVisible.current || shouldShow()) dismiss();
        return;
      }
      if (event.button === 2) event.preventDefault();
      else {
        dragging.current = true;
        dismiss();
      }
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (!contextRef.current) {
        blocked.current = false;
        poke();
      }
    };
    const open = (x: number, y: number, keyboard: boolean, target?: EventTarget | null) => {
      if (!visible() || editor.view.composing) return;
      if (!keyboard) {
        const hit = editor.view.posAtCoords({ left: x, top: y });
        if (!hit) return;
        const object =
          target instanceof Element
            ? target.closest(
                ".patent-figure, .patent-inline-figure, [data-type='inline-math'], [data-type='block-math'], .chemical-structure",
              )
            : null;
        selectContextTarget(editor, hit.pos, object ? editor.view.posAtDOM(object, 0) : undefined);
      }
      editor.view.focus();
      commandBus.setEditorFocus(editorId);
      bookmark.current = editor.state.selection.getBookmark();
      blocked.current = true;
      setSection(null);
      setContext({ x, y, keyboard });
      refresh((value) => value + 1);
      poke();
    };
    const rightClick = (event: MouseEvent) => {
      if ((event.target as Element)?.closest?.("input, textarea, math-field, button")) return;
      event.preventDefault();
      event.stopPropagation();
      open(event.clientX, event.clientY, false, event.target);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const point = editor.view.coordsAtPos(editor.state.selection.head);
        open(point.left, point.bottom, true);
      } else if (event.key === "Escape") dismiss();
    };
    const scroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        (root.current?.contains(event.target) || bubble.current?.contains(event.target))
      )
        return;
      // Selection/layout changes can scroll the page just after opening a menu.
      // Dismiss that menu on user intent (wheel/touch/scrollbar pointer), not layout scrolls.
      if (event.type === "scroll" && contextRef.current) return;
      // One hide transaction per input burst; repeated wheel/scroll events must
      // not invalidate every editor subscriber and rerender the whole workbench.
      if (!blocked.current || contextRef.current) dismiss();
      clearTimeout(timer);
      timer = setTimeout(() => {
        blocked.current = false;
        poke();
      }, 150);
    };
    editor.on("selectionUpdate", selection);
    editor.on("transaction", transaction);
    editor.view.dom.addEventListener("contextmenu", rightClick);
    editor.view.dom.addEventListener("keydown", keyboard);
    const windowBlur = () => {
      if (bubble.current?.querySelector('.custom-color-popup[data-color-sampling="true"]')) return;
      dismiss();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("pointerup", up);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("wheel", scroll, true);
    document.addEventListener("touchmove", scroll, true);
    window.addEventListener("resize", scroll);
    window.addEventListener("blur", windowBlur);
    return () => {
      clearTimeout(timer);
      editor.off("selectionUpdate", selection);
      editor.off("transaction", transaction);
      editor.view.dom.removeEventListener("contextmenu", rightClick);
      editor.view.dom.removeEventListener("keydown", keyboard);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("wheel", scroll, true);
      document.removeEventListener("touchmove", scroll, true);
      window.removeEventListener("resize", scroll);
      window.removeEventListener("blur", windowBlur);
    };
  }, [editor, editorId, commandBus, key, visible, shouldShow]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: position the newly opened submenu.
  useLayoutEffect(() => {
    if (!context || !root.current) return;
    const panel = root.current;
    const bounds = scope().getBoundingClientRect();
    const left = Math.max(8, bounds.left + 8);
    const right = Math.min(window.innerWidth - 8, bounds.right - 8);
    panel.style.maxWidth = `${Math.max(180, right - left)}px`;
    panel.style.left = `${Math.max(left, Math.min(context.x, right - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(8, Math.min(context.y, window.innerHeight - panel.offsetHeight - 8))}px`;
    const submenu = Array.from(panel.querySelectorAll<HTMLElement>(".editor-context-submenu")).find(
      (element) => !element.closest("[inert]"),
    );
    const trigger = panel.querySelector<HTMLElement>('[aria-expanded="true"]');
    if (submenu && trigger) {
      const menuRect = panel.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      submenu.style.maxWidth = `${Math.max(180, right - left)}px`;
      const nextLeft =
        menuRect.right + 4 + submenu.offsetWidth <= right
          ? menuRect.right + 4
          : menuRect.left - submenu.offsetWidth - 4;
      submenu.style.left = `${Math.max(left, nextLeft)}px`;
      submenu.style.top = `${Math.max(8, Math.min(triggerRect.top, window.innerHeight - submenu.offsetHeight - 8))}px`;
    }
    if (context.keyboard)
      panel
        .querySelector<HTMLElement>(
          ".editor-object-tools button:not(:disabled), [role='menuitem']:not(:disabled)",
        )
        ?.focus({ preventScroll: true });
  }, [context, section, scope]);

  const execute = (action: () => unknown, keep = false, focusEditor = true) => {
    if (!visible()) {
      close();
      return;
    }
    if (keep && bubbleVisible.current && bubble.current?.isConnected)
      fixedPosition.current = {
        left: bubble.current.style.left,
        top: bubble.current.style.top,
      };
    applying.current = true;
    try {
      if (bookmark.current)
        editor.view.dispatch(
          editor.state.tr.setSelection(bookmark.current.resolve(editor.state.doc)),
        );
      if (focusEditor) editor.view.focus();
      commandBus.setEditorFocus(editorId);
      const result = action();
      if (result === false) showAppAlert("当前无法执行此操作，请重新选择内容后重试。");
      bookmark.current = editor.state.selection.getBookmark();
      if (!keep) close();
      refresh((value) => value + 1);
    } catch {
      close();
      showAppAlert("文档或选区已变化，请重新选择后操作。");
    } finally {
      applying.current = false;
    }
  };
  const capabilities = commandBus.getEditorCapabilities(editorId);
  const textSelected = commandBus.hasNonEmptyTextSelection(editorId);
  const node = editor.state.selection instanceof NodeSelection ? editor.state.selection.node : null;
  const tableActive = editor.isActive("table");
  const format = commandBus.getFormatState(editorId);
  const formatCommand = (command: EditorCommand) =>
    execute(() => commandBus.execute(editorId, command), true);
  const fonts = documentFontOptions();
  const font = format.mixedFontFamily ? "" : displayDocumentFont(format.fontFamily);
  const size = format.mixedFontSize ? "" : String(format.fontSizePt ?? defaultDocumentFontSizePt());
  const iconButton = (label: string, icon: ReactNode, command: EditorCommand, pressed: boolean) => (
    <button
      type="button"
      aria-label={label}
      className={label.startsWith("删除") ? "is-danger" : undefined}
      title={label}
      aria-pressed={pressed}
      disabled={!editor.isEditable}
      onClick={() => formatCommand(command)}
    >
      {icon}
    </button>
  );
  const formatting = (
    <div className="editor-mini-format" role="toolbar" aria-label="选区格式">
      <div className="editor-mini-row">
        <select
          aria-label="字体"
          value={font}
          disabled={!editor.isEditable}
          onChange={(event) =>
            execute(() => commandBus.setFontFamily(editorId, event.target.value), true)
          }
        >
          <ToolbarSelectButton />
          {format.mixedFontFamily ? (
            <option value="" disabled hidden aria-label="混合字体" />
          ) : null}
          {fonts.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="字号"
          value={size}
          disabled={!editor.isEditable}
          onChange={(event) =>
            execute(() => commandBus.setFontSizePt(editorId, Number(event.target.value)), true)
          }
        >
          <ToolbarSelectButton />
          {format.mixedFontSize ? <option value="" disabled hidden aria-label="混合字号" /> : null}
          {size && !["10.5", "12", "14"].includes(size) ? (
            <option value={size}>{size}</option>
          ) : null}
          <option value="10.5">五号</option>
          <option value="12">小四</option>
          <option value="14">四号</option>
        </select>
        {iconButton("加粗", <Bold />, "bold", format.bold)}
        {iconButton("斜体", <Italic />, "italic", format.italic)}
        {iconButton("下划线", <Underline />, "underline", format.underline)}
      </div>
      <div className="editor-mini-row">
        <ColorPicker
          value={format.color ?? "#000000"}
          disabled={!editor.isEditable}
          onSelect={(color, preserveSelection = true, focusEditor = true) =>
            execute(
              () => commandBus.setColor(editorId, color, preserveSelection, focusEditor),
              true,
              focusEditor,
            )
          }
        />
        <ColorPicker
          kind="highlight"
          value={format.highlightColor ?? "#FFFF00"}
          disabled={!editor.isEditable}
          onSelect={(color, preserveSelection = true, focusEditor = true) =>
            execute(
              () => commandBus.setHighlightColor(editorId, color, preserveSelection, focusEditor),
              true,
              focusEditor,
            )
          }
        />
        {iconButton("上标", <Superscript />, "superscript", format.superscript)}
        {iconButton("下标", <Subscript />, "subscript", format.subscript)}
        <span className="editor-mini-divider" />
        {iconButton("左对齐", <AlignLeft />, "align-left", format.alignment === "left")}
        {iconButton("居中", <AlignCenter />, "align-center", format.alignment === "center")}
        {iconButton("右对齐", <AlignRight />, "align-right", format.alignment === "right")}
        {iconButton("两端对齐", <AlignJustify />, "align-justify", format.alignment === "justify")}
      </div>
    </div>
  );
  const item = (
    label: string,
    action: () => unknown,
    disabled = false,
    icon?: ReactNode,
    shortcut?: string,
  ) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      aria-label={label}
      disabled={disabled}
      className={label.startsWith("删除") ? "is-danger" : undefined}
      onClick={() => execute(action)}
    >
      <span className="editor-context-icon">{icon}</span>
      <span>{label}</span>
      {shortcut ? <kbd>{platformEditorShortcut(shortcut)}</kbd> : null}
    </button>
  );
  const group = (label: string, contents: ReactNode) => (
    <>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={section === label}
        onClick={() => setSection(section === label ? null : label)}
      >
        <span className="editor-context-icon">
          <Settings2 />
        </span>
        {label}
        <ChevronRight className="editor-context-chevron" />
      </button>
      {
        <SpatialPresence>
          {section === label ? (
            <div
              className="editor-context-menu editor-context-submenu editor-menu-surface"
              role="menu"
              aria-label={label}
            >
              {contents}
            </div>
          ) : null}
        </SpatialPresence>
      }
    </>
  );
  const property = () => {
    rail?.pin();
  };
  const tableItem = (label: string, command: TableCommand) => {
    const selection = commandBus.getTableSelection(editorId);
    const blocked =
      command === "delete-row"
        ? !selection.canDeleteRow
        : command === "delete-column"
          ? !selection.canDeleteColumn
          : command === "add-row-before"
            ? !selection.canAddRowBefore
            : command === "distribute-rows"
              ? selection.rowCount < 2
              : false;
    return item(
      label,
      () => {
        const done = commandBus.runTableCommand(editorId, command);
        if (!done && (command === "fit-page" || command === "auto-fit-content"))
          showAppAlert("表格无法在正文宽度内完整显示，请减少列数或拆成多张表。");
        return done;
      },
      !editor.isEditable || blocked,
    );
  };
  const preservePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || event.target.closest("input, select")) return;
    if (event.button === 0) event.preventDefault();
  };
  const menuKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      editor.view.focus();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    const objectTool = (event.target as Element).closest(".editor-object-tools");
    if (
      ![
        "ArrowDown",
        "ArrowUp",
        "Home",
        "End",
        ...(objectTool ? ["ArrowLeft", "ArrowRight"] : []),
      ].includes(event.key) ||
      (event.target as Element).closest("select,input")
    )
      return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ".editor-object-tools button:not(:disabled), [role='menuitem']:not(:disabled)",
      ),
    ).filter((element) => !element.closest("[inert]"));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) + items.length) %
            items.length;
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    <>
      <BubbleMenu
        ref={bubble}
        editor={editor}
        pluginKey={key}
        appendTo={appendMenuToBody}
        updateDelay={150}
        options={positioning}
        shouldShow={shouldShow}
        className="editor-selection-menu editor-menu-surface"
        data-editor-menu-owner={editorId}
        onPointerDown={preservePointer}
        onKeyDown={menuKeys}
      >
        {formatting}
      </BubbleMenu>
      {createPortal(
        <SpatialPresence>
          {context ? (
            <div
              ref={root}
              className="editor-context-menu editor-menu-surface"
              role="menu"
              aria-label="文档右键菜单"
              data-editor-menu-owner={editorId}
              onPointerDown={preservePointer}
              onKeyDown={menuKeys}
              onContextMenu={(event) => event.preventDefault()}
              style={{ left: context.x, top: context.y }}
            >
              {textSelected ? (
                formatting
              ) : (
                <EditorObjectTools
                  editor={editor}
                  editorId={editorId}
                  commandBus={commandBus}
                  execute={(action) => execute(action, true)}
                  onProperties={rail ? property : undefined}
                />
              )}
              {item(
                "剪切",
                () => runMenuClipboard(editor, "cut"),
                editor.state.selection.empty || !editor.isEditable,
                <Scissors />,
                "Ctrl+X",
              )}
              {item(
                "复制",
                () => runMenuClipboard(editor, "copy"),
                editor.state.selection.empty,
                <Copy />,
                "Ctrl+C",
              )}
              {item(
                "粘贴",
                async () => {
                  if (
                    !(await pasteIntoMenuEditor(editor, () => window.patentApi.clipboard.paste()))
                  )
                    showAppAlert("无法粘贴，剪贴板可能为空或编辑目标已改变，请重试。");
                },
                !editor.isEditable,
                <ClipboardPaste />,
                "Ctrl+V",
              )}
              <hr />
              {item(
                "撤销",
                () => commandBus.execute(editorId, "undo"),
                !editor.isEditable || !commandBus.getHistoryState(editorId).canUndo,
                <Undo2 />,
                "Ctrl+Z",
              )}
              {item(
                "重做",
                () => commandBus.execute(editorId, "redo"),
                !editor.isEditable || !commandBus.getHistoryState(editorId).canRedo,
                <Redo2 />,
                "Ctrl+Y",
              )}
              {!textSelected && !node ? group("文字格式", formatting) : null}
              {tableActive
                ? group(
                    "表格",
                    <>
                      {tableItem("上方插入行", "add-row-before")}
                      {tableItem("下方插入行", "add-row-after")}
                      {tableItem("左侧插入列", "add-column-before")}
                      {tableItem("右侧插入列", "add-column-after")}
                      {item(
                        "合并单元格",
                        () => commandBus.runTableCommand(editorId, "merge-cells"),
                        !editor.isEditable || !editor.can().mergeCells(),
                      )}
                      {item(
                        "拆分单元格",
                        () => commandBus.runTableCommand(editorId, "split-cell"),
                        !editor.isEditable || !editor.can().splitCell(),
                      )}
                      {tableItem("自动分配列宽", "auto-fit-content")}
                      {tableItem("平均分布列宽", "distribute-columns")}
                      {tableItem("平均分布行高", "distribute-rows")}
                      {item(
                        "恢复自动行高",
                        () => commandBus.setTableFormatting(editorId, { autoHeight: true }),
                        !editor.isEditable,
                      )}
                      {tableItem("清空单元格内容", "clear-cells")}
                      {item(
                        "单元格左对齐",
                        () =>
                          commandBus.setTableCellAttribute(editorId, "horizontalAlignment", "left"),
                        !editor.isEditable,
                      )}
                      {item(
                        "单元格居中",
                        () =>
                          commandBus.setTableCellAttribute(
                            editorId,
                            "horizontalAlignment",
                            "center",
                          ),
                        !editor.isEditable,
                      )}
                      {item(
                        "单元格右对齐",
                        () =>
                          commandBus.setTableCellAttribute(
                            editorId,
                            "horizontalAlignment",
                            "right",
                          ),
                        !editor.isEditable,
                      )}
                      {tableItem("适配正文宽度", "fit-page")}
                      {item("表格属性", property, !rail, <Settings2 />)}
                      {tableItem("删除行", "delete-row")}
                      {tableItem("删除列", "delete-column")}
                      {tableItem("删除表格", "delete-table")}
                    </>,
                  )
                : null}
              {node ? (
                <>
                  {["figure", "inlineFigure"].includes(node.type.name)
                    ? item("图片设置", property, !rail, <Settings2 />)
                    : ["inlineMath", "blockMath", "chemicalStructure"].includes(node.type.name)
                      ? item(
                          "重新编辑",
                          () => callbacks.current.onEditObject?.(editor.state.selection.from),
                          !editor.isEditable,
                          <Sigma />,
                        )
                      : null}
                  {item(
                    "删除对象",
                    () => editor.commands.deleteSelection(),
                    !editor.isEditable,
                    <Trash2 />,
                  )}
                </>
              ) : null}
              {!node && editor.isEditable
                ? group(
                    "插入",
                    <>
                      {capabilities?.tables
                        ? item(
                            "插入表格",
                            () =>
                              commandBus.insertTable(editorId, {
                                rows: 2,
                                columns: 2,
                                headerRowCount: 0,
                                layoutMode: "fit-page",
                              }),
                            false,
                            <Table2 />,
                          )
                        : null}
                      {capabilities?.formulas
                        ? item(
                            "插入数学公式",
                            () => commandBus.openFormulaEditor(editorId),
                            false,
                            <Sigma />,
                          )
                        : null}
                      {capabilities?.chemistry
                        ? item("插入化学方程式", () =>
                            commandBus.openChemistryEditor(editorId, "equation"),
                          )
                        : null}
                      {capabilities?.chemicalStructures
                        ? item("插入化学结构式", () =>
                            commandBus.openChemistryEditor(editorId, "structure"),
                          )
                        : null}
                    </>,
                  )
                : null}
              {props.onNumber
                ? item(
                    "编号",
                    () => callbacks.current.onNumber?.(),
                    !textSelected || !editor.isEditable,
                  )
                : null}
              {props.onDependentClaim
                ? item(
                    "插入从属权利要求",
                    () => callbacks.current.onDependentClaim?.(),
                    !editor.isEditable,
                  )
                : null}
              <hr />
              {props.onFind ? (
                <>
                  {item(
                    "查找",
                    () =>
                      callbacks.current.onFind?.(
                        "find",
                        editor.state.doc.textBetween(
                          editor.state.selection.from,
                          editor.state.selection.to,
                          "\n",
                        ),
                      ),
                    false,
                    <Search />,
                    "Ctrl+F",
                  )}
                  {item(
                    "替换",
                    () => callbacks.current.onFind?.("replace"),
                    !editor.isEditable,
                    undefined,
                    "Ctrl+H",
                  )}
                </>
              ) : null}
              {item("全选", () => commandBus.selectAll(editorId), false, undefined, "Ctrl+A")}
              <hr />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={enabled}
                onClick={() => {
                  try {
                    localStorage.setItem(PREFERENCE_KEY, String(!enabled));
                  } catch {
                    showAppAlert("设置无法保存，本次会话仍可使用。");
                  }
                  setEnabled(!enabled);
                  window.dispatchEvent(new Event(PREFERENCE_EVENT));
                  close();
                }}
              >
                <span className="editor-context-icon">{enabled ? "✓" : ""}</span>显示选区工具栏
              </button>
            </div>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </>
  );
}
