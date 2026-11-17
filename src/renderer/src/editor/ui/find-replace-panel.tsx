import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MotionPresence } from "../../app/motion-presence";
import { confirmAppAction } from "../../shared/app-dialog";
import { DialogCloseIcon } from "../../shared/dialog-close-icon";
import { SpatialCollapse } from "../../shared/spatial-collapse";
import { useDialogDrag } from "../../shared/use-dialog-drag";
import { setFindReplaceHighlights } from "../extensions/find-replace-highlights";
import {
  CHINESE_PUNCTUATION_PATTERN,
  type DetailedSearchResult,
  type FindOptions,
  type FindSearchMode,
  prepareFindSearch,
  replaceAllLiteral,
  replaceCurrentMatch,
  selectWrappedMatch,
  withReplacementContext,
} from "../find-replace";
import { startFindSearch } from "../find-search-task";

type FindReplacePanelProps = {
  editor: Editor | null;
  mode: "find" | "replace";
  query?: string;
  replacement?: string;
  onQueryChange?(value: string): void;
  onReplacementChange?(value: string): void;
  options?: FindOptions;
  onOptionsChange?(options: FindOptions): void;
  onModeChange?(mode: "find" | "replace"): void;
  onShortcut?(mode: "find" | "replace"): void;
  onClose(): void;
};

type SpecialItem = {
  label: string;
  description: string;
  code: string;
  wildcardCode?: string;
  regexCode?: string;
};

type SpecialTarget = "find" | "replace";

type InputSelection = {
  start: number;
  end: number;
};

const FIND_SPECIAL_ITEMS: SpecialItem[] = [
  {
    label: "任意数字",
    description: "匹配任意一个 Unicode 数字，例如 1、２",
    code: "^#",
    regexCode: "\\p{Nd}",
  },
  {
    label: "任意字母",
    description: "匹配任意一个中英文等语言的字母",
    code: "^$",
    regexCode: "\\p{L}",
  },
  {
    label: "任意汉字",
    description: "匹配任意一个汉字",
    code: "^汉",
    regexCode: "\\p{Script=Han}",
  },
  {
    label: "任意字符",
    description: "匹配任意一个普通文字字符",
    code: "^?",
    wildcardCode: "?",
    regexCode: ".",
  },
  {
    label: "任意中文标点",
    description: "匹配书名号、括号、顿号、句号等中文标点",
    code: "^中标",
    regexCode: CHINESE_PUNCTUATION_PATTERN,
  },
  {
    label: "任意空白",
    description: "匹配一个或多个空格、制表符或不间断空格",
    code: "^w",
    regexCode: "[ \\t\\u00a0]+",
  },
  { label: "手动换行", description: "匹配文档中的手动换行", code: "^l" },
  { label: "制表符", description: "匹配一个制表符", code: "^t", regexCode: "\\t" },
  {
    label: "不间断空格",
    description: "匹配一个不会自动换行的空格",
    code: "^s",
    regexCode: "\\u00a0",
  },
  { label: "分页符", description: "匹配文档中的分页符", code: "^m" },
  { label: "脱字符", description: "匹配字符 ^ 本身", code: "^^", regexCode: "\\^" },
];

const REPLACE_SPECIAL_ITEMS: SpecialItem[] = [
  {
    label: "原查找内容",
    description: "在替换结果中保留本次匹配到的原文字",
    code: "^&",
    regexCode: "$&",
  },
  { label: "手动换行", description: "在替换结果中插入手动换行", code: "^l" },
  { label: "制表符", description: "在替换结果中插入制表符", code: "^t" },
  { label: "不间断空格", description: "在替换结果中插入不间断空格", code: "^s" },
  { label: "脱字符", description: "在替换结果中插入字符 ^", code: "^^" },
];

function effectiveSearchMode(options: FindOptions): FindSearchMode {
  return options.searchMode ?? (options.useRegex ? "regex" : "literal");
}

function insertAtSelection(
  input: HTMLInputElement | null,
  value: string,
  selection: InputSelection,
  code: string,
  onChange: (value: string) => void,
) {
  onChange(`${value.slice(0, selection.start)}${code}${value.slice(selection.end)}`);
  requestAnimationFrame(() => {
    const caret = selection.start + code.length;
    input?.focus();
    input?.setSelectionRange(caret, caret);
  });
}

function SpecialCharacterMenu({
  kind,
  inputRef,
  value,
  searchMode,
  onChange,
}: {
  kind: "find" | "replace";
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  searchMode: FindSearchMode;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const drag = useDialogDrag<HTMLElement>({
    positionKey: `special-character:${kind}`,
    memory: "session",
    movable: open,
  });
  const dialogRef = drag.surfaceRef;
  const selectionRef = useRef<InputSelection>({ start: value.length, end: value.length });
  const items = (kind === "find" ? FIND_SPECIAL_ITEMS : REPLACE_SPECIAL_ITEMS).filter(
    (item) => kind === "replace" || searchMode !== "regex" || item.regexCode,
  );
  const dialogTitle = kind === "find" ? "选择查找特殊字符" : "选择替换特殊字符";
  const rememberSelection = () => {
    const input = inputRef.current;
    selectionRef.current = {
      start: input?.selectionStart ?? value.length,
      end: input?.selectionEnd ?? input?.selectionStart ?? value.length,
    };
  };
  const restoreInput = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
    });
  };
  const closeDialog = () => {
    setOpen(false);
    restoreInput();
  };
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      dialog?.querySelector<HTMLButtonElement>(".special-character-dialog__option")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, dialogRef]);
  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  return (
    <div className="find-replace-panel__special">
      <button
        type="button"
        aria-label="特殊字符"
        aria-expanded={open}
        onMouseDown={rememberSelection}
        onClick={() => {
          rememberSelection();
          setOpen((current) => !current);
        }}
      >
        特殊字符
      </button>
      {createPortal(
        <MotionPresence>
          {open ? (
            // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: backdrop dismisses; keyboard close is handled in the dialog.
            <div
              className="special-character-dialog-backdrop"
              onClick={(event) => {
                if (event.target === event.currentTarget) closeDialog();
              }}
            >
              <section
                ref={dialogRef}
                className="special-character-dialog"
                style={drag.style}
                data-dragging={drag.dragging}
                role="dialog"
                aria-modal="true"
                aria-label={dialogTitle}
                onKeyDown={handleDialogKeyDown}
              >
                <header ref={drag.titleBarRef}>
                  <div>
                    <h2>{dialogTitle}</h2>
                  </div>
                  <button
                    type="button"
                    className="special-character-dialog__close dialog-close-button dialog-close-control"
                    aria-label={`关闭${dialogTitle}`}
                    onClick={closeDialog}
                  >
                    <DialogCloseIcon />
                  </button>
                </header>
                <div className="special-character-dialog__options">
                  {items.map((item) => {
                    const code =
                      searchMode === "wildcard"
                        ? (item.wildcardCode ?? item.code)
                        : searchMode === "regex"
                          ? (item.regexCode ?? item.code)
                          : item.code;
                    return (
                      <button
                        key={item.label}
                        type="button"
                        className="special-character-dialog__option"
                        aria-label={`插入${item.label} ${code}`}
                        title={item.description}
                        onClick={() => {
                          insertAtSelection(
                            inputRef.current,
                            value,
                            selectionRef.current,
                            code,
                            onChange,
                          );
                          setOpen(false);
                        }}
                      >
                        <code>{code}</code>
                        <strong>{item.label}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : null}
        </MotionPresence>,
        document.body,
      )}
    </div>
  );
}

export function FindReplacePanel({
  editor,
  mode,
  query,
  replacement,
  onQueryChange,
  onReplacementChange,
  options = {},
  onOptionsChange,
  onModeChange,
  onShortcut,
  onClose,
}: FindReplacePanelProps) {
  const [localQuery, setLocalQuery] = useState("");
  const [localReplacement, setLocalReplacement] = useState("");
  const [message, setMessage] = useState("");
  const activeQuery = query ?? localQuery;
  const activeReplacement = replacement ?? localReplacement;
  const changeQuery = onQueryChange ?? setLocalQuery;
  const changeReplacement = onReplacementChange ?? setLocalReplacement;
  const queryId = useId();
  const replacementId = useId();
  const queryRef = useRef<HTMLInputElement>(null);
  const replacementRef = useRef<HTMLInputElement>(null);
  const confirmationEditor = useRef(editor);
  useEffect(() => {
    confirmationEditor.current = editor;
    return () => {
      confirmationEditor.current = null;
    };
  }, [editor]);
  const [specialTarget, setSpecialTarget] = useState<SpecialTarget>("find");
  const [, setSelectionVersion] = useState(0);
  const [docVersion, setDocVersion] = useState(0);
  void docVersion;
  const documentRef = useRef(editor?.state.doc);
  if (!editor?.state.doc.eq(documentRef.current ?? editor.state.doc) || !documentRef.current)
    documentRef.current = editor?.state.doc;
  const searchDocument = documentRef.current;
  const optionsKey = JSON.stringify(options);
  const [completedSearch, setCompletedSearch] = useState<{
    document: typeof searchDocument;
    query: string;
    optionsKey: string;
    result: DetailedSearchResult;
  } | null>(null);
  const searchPending = Boolean(
    editor &&
      activeQuery &&
      (completedSearch?.document !== searchDocument ||
        completedSearch?.query !== activeQuery ||
        completedSearch?.optionsKey !== optionsKey),
  );
  const emptyResult = useMemo<DetailedSearchResult>(() => ({ matches: [], error: null }), []);
  const searchResult =
    searchPending || !activeQuery ? emptyResult : (completedSearch?.result ?? emptyResult);
  const nextAfterReplace = useRef<number | null>(null);
  const pendingNavigation = useRef<{
    document: typeof searchDocument;
    query: string;
    optionsKey: string;
    direction: "next" | "previous";
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: These values identify a new search intent; document-only changes must retain replacement navigation.
  useEffect(() => {
    nextAfterReplace.current = null;
    setMessage("");
  }, [editor, activeQuery, optionsKey]);
  useEffect(() => {
    if (!searchDocument || !activeQuery) return;
    const searchOptions: FindOptions = JSON.parse(optionsKey);
    const cancelSearch = startFindSearch(
      {
        chunks: prepareFindSearch(searchDocument, searchOptions),
        query: activeQuery,
        options: searchOptions,
      },
      (result) => {
        setCompletedSearch({ document: searchDocument, query: activeQuery, optionsKey, result });
        const navigation = pendingNavigation.current;
        pendingNavigation.current = null;
        if (
          navigation?.document === searchDocument &&
          navigation.query === activeQuery &&
          navigation.optionsKey === optionsKey &&
          editor &&
          !editor.isDestroyed &&
          editor.state.doc.eq(searchDocument)
        ) {
          const position =
            navigation.direction === "next"
              ? editor.state.selection.to
              : editor.state.selection.from;
          const match = selectWrappedMatch(result.matches, position, navigation.direction);
          if (match) editor.chain().setTextSelection(match).scrollIntoView().run();
          setMessage(result.error ?? (match ? "" : "未找到"));
        }
        if (
          nextAfterReplace.current !== null &&
          editor &&
          !editor.isDestroyed &&
          editor.state.doc.eq(searchDocument)
        ) {
          const next = selectWrappedMatch(result.matches, nextAfterReplace.current, "next");
          nextAfterReplace.current = null;
          if (next) editor.chain().setTextSelection(next).scrollIntoView().run();
          setMessage(
            result.error ??
              (result.matches.length
                ? `已替换 1 处，${result.matches.length} 个匹配`
                : "已替换 1 处"),
          );
        }
      },
    );
    return () => {
      cancelSearch();
      pendingNavigation.current = null;
    };
  }, [editor, searchDocument, activeQuery, optionsKey]);
  const matches = searchResult.matches;
  const currentMatchIndex = editor
    ? matches.findIndex(
        (match) =>
          match.from === editor.state.selection.from && match.to === editor.state.selection.to,
      )
    : -1;
  const hasMatches = matches.length > 0;
  const searchMode = effectiveSearchMode(options);
  const syntaxError = searchResult.error;
  const effectiveSpecialTarget = mode === "find" ? "find" : specialTarget;
  const specialInputRef = effectiveSpecialTarget === "replace" ? replacementRef : queryRef;
  const specialValue = effectiveSpecialTarget === "replace" ? activeReplacement : activeQuery;
  const changeSpecialValue = effectiveSpecialTarget === "replace" ? changeReplacement : changeQuery;

  useEffect(() => queryRef.current?.focus(), []);

  useEffect(() => {
    if (mode === "find") setSpecialTarget("find");
  }, [mode]);

  useEffect(() => {
    if (!editor) return;
    const refreshSelection = () => setSelectionVersion((version) => version + 1);
    editor.on("selectionUpdate", refreshSelection);
    return () => {
      editor.off("selectionUpdate", refreshSelection);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    setFindReplaceHighlights(
      editor,
      matches,
      currentMatchIndex >= 0 ? (matches[currentMatchIndex] ?? null) : null,
    );
  }, [editor, matches, currentMatchIndex]);

  useEffect(() => {
    if (!editor) return;
    return () => setFindReplaceHighlights(editor, [], null);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const refreshDocument = () => setDocVersion((version) => version + 1);
    editor.on("update", refreshDocument);
    return () => {
      editor.off("update", refreshDocument);
    };
  }, [editor]);

  const move = (direction: "next" | "previous") => {
    if (searchPending) {
      pendingNavigation.current = {
        document: searchDocument,
        query: activeQuery,
        optionsKey,
        direction,
      };
      return;
    }
    if (!editor) {
      setMessage("当前书册不支持文本查找");
      return;
    }
    const position = direction === "next" ? editor.state.selection.to : editor.state.selection.from;
    const match = selectWrappedMatch(matches, position, direction);
    if (!match) {
      setMessage(activeQuery ? "未找到" : "请输入查找内容");
      return;
    }
    editor.chain().setTextSelection(match).scrollIntoView().run();
    setMessage("");
  };

  const replaceCurrent = () => {
    if (
      searchPending ||
      !completedSearch?.document ||
      !editor?.state.doc.eq(completedSearch.document)
    )
      return;
    if (!editor) {
      setMessage("当前书册不支持文本替换");
      return;
    }
    const { from, to } = editor.state.selection;
    const current = matches.find((match) => match.from === from && match.to === to);
    if (!current) {
      move("next");
      return;
    }
    let result: ReturnType<typeof replaceCurrentMatch>;
    try {
      result = replaceCurrentMatch(
        editor,
        current,
        activeQuery,
        activeReplacement,
        options,
        withReplacementContext(
          searchResult.matches.filter((match) => match === current),
          prepareFindSearch(editor.state.doc, options),
          activeReplacement,
        ),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "替换失败");
      return;
    }
    if (!result?.replaced) {
      setMessage("替换内容与原内容相同");
      return;
    }
    nextAfterReplace.current = current.from;
    editor
      .chain()
      .setTextSelection(Math.min(result.caretPosition, editor.state.doc.content.size))
      .scrollIntoView()
      .focus(undefined, { scrollIntoView: false })
      .run();
    setMessage("已替换 1 处，正在重新查找…");
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: jsdom and the supported Electron runtime do not expose the search element consistently.
    <form
      className="find-replace-panel function-rail-transient-panel"
      role="search"
      aria-label="查找和替换"
      onSubmit={(event) => event.preventDefault()}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          if (document.querySelector(".special-character-dialog")) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        const findMode = findShortcutMode(event);
        if (!findMode) return;
        event.preventDefault();
        event.stopPropagation();
        onShortcut?.(findMode);
      }}
    >
      <div className="find-replace-panel__header">
        <fieldset className="find-replace-panel__mode-switch">
          <legend className="sr-only">查找或替换</legend>
          <button
            type="button"
            className={mode === "find" ? "is-active" : undefined}
            aria-pressed={mode === "find"}
            onClick={() => onModeChange?.("find")}
          >
            查找
          </button>
          <button
            type="button"
            className={mode === "replace" ? "is-active" : undefined}
            aria-pressed={mode === "replace"}
            onClick={() => onModeChange?.("replace")}
          >
            替换
          </button>
        </fieldset>
        <button
          type="button"
          className="find-replace-panel__close dialog-close-button"
          aria-label="关闭查找"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="find-replace-panel__field">
        <label htmlFor={queryId}>查找内容</label>
        <div className="find-replace-panel__input-row">
          <input
            id={queryId}
            ref={queryRef}
            aria-label="查找内容"
            value={activeQuery}
            placeholder="查找内容"
            onFocus={() => setSpecialTarget("find")}
            onChange={(event) => {
              changeQuery(event.target.value);
              setMessage("");
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              move(event.shiftKey ? "previous" : "next");
            }}
          />
        </div>
      </div>
      <SpatialCollapse open={mode === "replace"} parentGap="var(--transient-panel-gap, 8px)">
        {mode === "replace" ? (
          <div className="find-replace-panel__field">
            <label htmlFor={replacementId}>替换为</label>
            <div className="find-replace-panel__input-row">
              <input
                id={replacementId}
                ref={replacementRef}
                aria-label="替换为"
                value={activeReplacement}
                placeholder="替换为"
                onFocus={() => setSpecialTarget("replace")}
                onChange={(event) => changeReplacement(event.target.value)}
              />
            </div>
          </div>
        ) : null}
      </SpatialCollapse>
      <div className="find-replace-panel__search-tools">
        <label className="find-replace-panel__search-mode">
          <span>查找方式</span>
          <select
            aria-label="查找方式"
            value={searchMode}
            onChange={(event) => {
              const nextMode = event.target.value as FindSearchMode;
              onOptionsChange?.({
                ...options,
                searchMode: nextMode,
                useRegex: nextMode === "regex",
              });
              setMessage("");
            }}
          >
            <option value="literal">普通</option>
            <option value="wildcard">Word 通配符</option>
            <option value="regex">正则表达式</option>
          </select>
        </label>
        <SpecialCharacterMenu
          kind={effectiveSpecialTarget}
          inputRef={specialInputRef}
          value={specialValue}
          searchMode={searchMode}
          onChange={changeSpecialValue}
        />
      </div>
      <div className="find-replace-panel__options">
        <label>
          <input
            type="checkbox"
            checked={options.caseSensitive ?? false}
            onChange={(event) =>
              onOptionsChange?.({ ...options, caseSensitive: event.target.checked })
            }
          />
          区分大小写
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.wholeWord ?? false}
            onChange={(event) => onOptionsChange?.({ ...options, wholeWord: event.target.checked })}
          />
          全字匹配
        </label>
      </div>
      {searchMode === "literal" ? null : (
        <p className="find-replace-panel__hint">
          {searchMode === "wildcard"
            ? "支持 ?、*、[]、[!]、{}、@、<、> 和分组。"
            : "支持 JavaScript Unicode 正则表达式与 $1 分组替换。"}
        </p>
      )}
      <div className="find-replace-panel__actions">
        <button type="button" disabled={!hasMatches} onClick={() => move("previous")}>
          上一个
        </button>
        <button type="button" disabled={!hasMatches} onClick={() => move("next")}>
          下一个
        </button>
      </div>
      <SpatialCollapse open={mode === "replace"} parentGap="var(--transient-panel-gap, 8px)">
        {mode === "replace" ? (
          <div className="find-replace-panel__actions">
            <button type="button" disabled={!hasMatches || !editor} onClick={replaceCurrent}>
              替换
            </button>
            <button
              type="button"
              disabled={!hasMatches || !editor}
              onClick={async () => {
                if (!editor) return;
                if (
                  searchPending ||
                  !completedSearch?.document ||
                  !editor.state.doc.eq(completedSearch.document)
                )
                  return;
                const count = matches.length;
                if (count === 0) {
                  setMessage(activeQuery ? "未找到" : "请输入查找内容");
                  return;
                }
                const confirmedDocument = editor.state.doc;
                if (!(await confirmAppAction(`即将替换 ${count} 处，是否继续？`))) {
                  setMessage("已取消替换");
                  return;
                }
                if (
                  confirmationEditor.current !== editor ||
                  editor.isDestroyed ||
                  editor.state.doc !== confirmedDocument
                ) {
                  setMessage("文档已变化，请重新查找后替换");
                  return;
                }
                try {
                  const replaced = replaceAllLiteral(
                    editor,
                    activeQuery,
                    activeReplacement,
                    options,
                    withReplacementContext(
                      searchResult.matches,
                      prepareFindSearch(editor.state.doc, options),
                      activeReplacement,
                    ),
                  );
                  setMessage(
                    replaced ? `已替换 ${replaced} 处` : `找到 ${count} 处，替换内容与原内容相同`,
                  );
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : "替换失败");
                }
              }}
            >
              全部替换
            </button>
          </div>
        ) : null}
      </SpatialCollapse>
      <span aria-live="polite" className="find-replace-panel__count">
        {!activeQuery
          ? "请输入查找内容"
          : searchPending
            ? "正在查找全部内容…"
            : syntaxError
              ? syntaxError
              : hasMatches
                ? `${currentMatchIndex >= 0 ? currentMatchIndex + 1 : 0}/${matches.length}`
                : "未找到"}
      </span>
      <span aria-live="polite" className="find-replace-panel__message">
        {message}
      </span>
    </form>
  );
}

import { findShortcutMode } from "../../../../shared/platform";
