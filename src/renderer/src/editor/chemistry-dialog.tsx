import { useEditorSessionVisible } from "../shared/editor-session-scope";
import katex from "katex";
import {
  createElement,
  type Dispatch,
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ChemicalStructureSource } from "../../../shared/chemistry/structure-source";
import type { ChemicalPreviewAssetDescriptor } from "../../../shared/document/model";
import type { LibrarySaveState } from "../../../shared/library/model";
import { MotionPresence, useMotionPresenceClosing } from "../app/motion-presence";
import type { ChemicalEditorMode, KetcherAdapter } from "../chemistry/ketcher-adapter";
import { StructureTimeoutError, withStructureTimeout } from "../chemistry/structure-timeout";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { FigureDrawingActions } from "../shared/figure-drawing-actions";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { useRetainedTransientVisibility } from "../shared/transient-function-rail-slot";
import { useDialogDrag } from "../shared/use-dialog-drag";
import { getChemicalPhysicalLetter } from "./chemical-keyboard-input";
import {
  applyChemicalSuggestion,
  type ChemicalMathField,
  type ChemicalScriptMode,
  enterChemicalScript,
  exitChemicalScript,
  insertChemicalPhysicalLetter,
  readChemicalSuggestionContext,
  toggleSelectedChemicalScript,
} from "./chemical-mathfield-adapter";
import {
  applyReactionCondition,
  captureReactionCondition,
  type ReactionConditionTarget,
} from "./chemical-reaction-condition";
import {
  type ChemicalScriptSuggestion,
  suggestChemicalScripts,
} from "./chemical-script-suggestions";
import { normalizeChemicalEquation, unwrapChemicalEquation } from "./chemistry-equation";
import { ChemicalPeriodicPanel } from "./ui/chemical-periodic-panel";
import { ChemicalSuggestionBar } from "./ui/chemical-suggestion-bar";
import { FormulaPositionSwitch } from "./ui/formula-position-switch";

type ChemicalMode = "inline" | "block";

export type ChemicalEquationDraft = {
  kind: "equation";
  mode: ChemicalMode;
  source: string;
};

export type ChemicalStructureDraft = {
  kind: "structure";
  ketSource: string;
  editorMode?: ChemicalEditorMode;
  previewAssetId: string;
  previewDescriptor: ChemicalPreviewAssetDescriptor;
};

export type ChemicalStructureDrawing = {
  descriptor: ChemicalPreviewAssetDescriptor;
  png: Uint8Array;
  svg?: string;
  source?: ChemicalStructureSource;
};

export type ChemistryDialogRequest =
  | { type: "new"; initialKind?: "equation" | "structure" }
  | { type: "edit"; kind: "equation"; mode: ChemicalMode; source: string }
  | {
      type: "edit";
      kind: "structure";
      ketSource: string;
      editorMode?: ChemicalEditorMode;
      targetKey?: string;
    };

export type ChemistryDialogProps = {
  open?: boolean;
  displayMode?: "modal" | "modeless";
  positionKey?: string;
  sessionId: string;
  request: ChemistryDialogRequest;
  drawingsOnly?: boolean;
  onConfirm(draft: ChemicalEquationDraft | ChemicalStructureDraft): void | Promise<void>;
  onCancel(): void;
  onKindChange?(kind: "equation" | "structure"): void;
  supportsStructures?: boolean;
  errorMessage?: string | null;
  saveState?: LibrarySaveState;
  onRetrySave?(): void | Promise<void>;
  onInsertEquationToDrawings?(latex: string): void | Promise<void>;
  onInsertStructureToDrawings?(drawing: ChemicalStructureDrawing): void | Promise<void>;
  onReplaceEquationToDrawings?(latex: string): void | Promise<void>;
  onReplaceStructureToDrawings?(drawing: ChemicalStructureDrawing): void | Promise<void>;
  loadMathlive?(): Promise<unknown>;
};

export const STRUCTURES_UNAVAILABLE_MESSAGE = "当前书册暂不支持化学结构式。";

const KetcherEditor = lazy(async () => {
  const module = await import("../chemistry/ketcher-editor");
  return { default: module.KetcherEditor };
});

const EQUATION_SYMBOLS = [
  { label: "加号", symbol: "+", source: " + " },
  { label: "生成", symbol: "→", source: "\\rightarrow " },
  { label: "可逆", symbol: "⇌", source: "\\rightleftharpoons " },
  { label: "平衡", symbol: "↔", source: "\\leftrightarrow " },
  { label: "沉淀", symbol: "↓", source: "\\downarrow " },
  { label: "气体", symbol: "↑", source: "\\uparrow " },
  {
    label: "反应条件",
    symbol: "→",
    source: String.raw`\xrightarrow{条件} `,
    previewFormula: String.raw`\xrightarrow{条件}`,
  },
  { label: "上标", symbol: "xⁿ", source: "^{}" },
  { label: "下标", symbol: "xₙ", source: "_{}" },
  { label: "电荷", symbol: "x⁺", source: "^{+}" },
  { label: "括号", symbol: "( )", source: "({})" },
] as const;

function initialState(request: ChemistryDialogRequest): {
  activeKind: "equation" | "structure";
  equation: { mode: ChemicalMode; source: string };
  structureKet: string;
  structureMode: ChemicalEditorMode;
} {
  if (request.type === "new") {
    return {
      activeKind: request.initialKind ?? "equation",
      equation: { mode: "inline", source: "" },
      structureKet: "",
      structureMode: "molecule",
    };
  }
  if (request.kind === "equation") {
    return {
      activeKind: "equation",
      equation: { mode: request.mode, source: unwrapChemicalEquation(request.source) },
      structureKet: "",
      structureMode: "molecule",
    };
  }
  return {
    activeKind: "structure",
    equation: { mode: "inline", source: "" },
    structureKet: request.ketSource,
    structureMode: request.editorMode ?? "molecule",
  };
}

function equationErrorMessage(code: string): string {
  switch (code) {
    case "CHEMICAL_EQUATION_EMPTY":
      return "请输入化学方程式。";
    case "CHEMICAL_EQUATION_TOO_LARGE":
      return "化学方程式过长，无法插入。";
    case "CHEMICAL_EQUATION_NESTED_CE":
      return "化学方程式不能重复包含 \\ce 命令。";
    default:
      return "化学方程式语法有误，请修改后再插入。";
  }
}

function blockChemicalImeComposition(event: Event): void {
  event.stopImmediatePropagation();
}

function ketcherDraftErrorMessage(code: string): string {
  switch (code) {
    case "EMPTY_STRUCTURE":
      return "请先在结构编辑器中绘制化学结构式。";
    case "KET_TOO_LARGE":
      return "化学结构过于复杂，请简化后再插入。";
    case "KETCHER_DISPOSED":
      return "结构编辑器已重置，请重新打开后再试。";
    case "KETCHER_TIMEOUT":
      return "结构式操作超时，请重试。画布未被清除。";
    default:
      return "无法读取当前化学结构，请检查后重试。";
  }
}

function previewErrorMessage(code: string): string {
  switch (code) {
    case "CHEMICAL_PREVIEW_TOO_LARGE":
      return "结构式预览尺寸过大，请简化结构后重试。";
    case "INVALID_KETCHER_SVG":
    case "UNSAFE_KETCHER_SVG":
      return "当前结构无法生成安全预览，请修改结构后重试。";
    default:
      return "生成结构式预览失败，请重试。";
  }
}

function appendChemicalToken(source: string, token: string): string {
  const current = source.trim();
  if (!current) return String.raw`\ce{${token.trim()}}`;
  if (current.startsWith(String.raw`\ce{`) && current.endsWith("}")) {
    const body = current.slice(4, -1).trimEnd();
    const separator = body && !body.endsWith(" ") && !token.startsWith(" ") ? " " : "";
    return String.raw`\ce{${body}${separator}${token}}`;
  }
  return String.raw`\ce{${current}${token}}`;
}

const UNICODE_SUBSCRIPTS: Record<string, string> = {
  "₀": "0",
  "₁": "1",
  "₂": "2",
  "₃": "3",
  "₄": "4",
  "₅": "5",
  "₆": "6",
  "₇": "7",
  "₈": "8",
  "₉": "9",
};

const UNICODE_SUPERSCRIPTS: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁺": "+",
  "⁻": "-",
};

/** 将易粘贴的 Unicode 上下标转为 MathLive 可编辑的 LaTeX 语法。 */
function normalizeConditionLatex(value: string): string {
  return value
    .replace(/[₀₁₂₃₄₅₆₇₈₉]+/gu, (digits) => {
      return `_{${[...digits].map((digit) => UNICODE_SUBSCRIPTS[digit]).join("")}}`;
    })
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/gu, (digits) => {
      return `^{${[...digits].map((digit) => UNICODE_SUPERSCRIPTS[digit]).join("")}}`;
    });
}

function reactionConditionToken(upper: string, lower: string, reversible: boolean): string {
  // 条件允许标准 LaTeX（如 MnO_{2}）；渲染层以 trust: false 隔离不受信命令。
  const u = normalizeConditionLatex(upper.trim());
  const l = normalizeConditionLatex(lower.trim());
  const cmd = reversible ? "\\xrightleftharpoons" : "\\xrightarrow";
  if (u && l) return `${cmd}[${l}]{${u}} `;
  if (u) return `${cmd}{${u}} `;
  if (l) return `${cmd}[${l}]{} `;
  return `${cmd}{} `;
}

const UPPER_PRESETS = [
  { label: "MnO₂", value: "MnO_{2}" },
  { label: "Pt", value: "Pt" },
  { label: "浓 H₂SO₄", value: "浓 H_{2}SO_{4}" },
  { label: "Ni", value: "Ni" },
  { label: "Fe", value: "Fe" },
  { label: "Cu", value: "Cu" },
  { label: "Pd/C", value: "Pd/C" },
  { label: "NaOH", value: "NaOH" },
] as const;

const GENERAL_PRESETS = [
  { label: "Δ 加热", value: "\u0394" },
  { label: "高温", value: "高温" },
  { label: "加压", value: "加压" },
  { label: "光照", value: "光照" },
  { label: "hν", value: "h\\nu" },
  { label: "回流", value: "回流" },
  { label: "搅拌", value: "搅拌" },
  { label: "室温", value: "室温" },
  { label: "冰浴", value: "冰浴" },
  { label: "通电", value: "通电" },
] as const;

function ReactionConditionModal({
  upper,
  lower,
  reversible,
  setUpper,
  setLower,
  setReversible,
  onInsert,
  onCancel,
  editing,
  errorMessage,
}: {
  upper: string;
  lower: string;
  reversible: boolean;
  setUpper: Dispatch<SetStateAction<string>>;
  setLower: Dispatch<SetStateAction<string>>;
  setReversible: Dispatch<SetStateAction<boolean>>;
  onInsert(): void;
  onCancel(): void;
  editing: boolean;
  errorMessage: string | null;
}) {
  const [showLower, setShowLower] = useState(Boolean(lower));
  const initialConditions = useRef({ upper, lower });
  const [history, setHistory] = useState<{ upper: string; lower: string }[]>([]);
  const [historyPos, setHistoryPos] = useState(-1);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const upperInputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const upperInputId = useId();
  const lowerInputId = useId();

  useEffect(() => {
    upperInputRef.current?.focus();
  }, []);

  const pushHistory = useCallback(
    (u: string, l: string) => {
      setHistory((prev) => {
        const next = prev.slice(0, historyPos + 1);
        next.push({ upper: u, lower: l });
        return next;
      });
      setHistoryPos((p) => p + 1);
    },
    [historyPos],
  );

  const undo = useCallback(() => {
    if (historyPos < 0) return;
    const pos = historyPos - 1;
    if (pos >= 0) {
      const snap = history[pos];
      if (!snap) return;
      setHistoryPos(pos);
      setUpper(snap.upper);
      setLower(snap.lower);
    } else {
      setHistoryPos(pos);
      setUpper(initialConditions.current.upper);
      setLower(initialConditions.current.lower);
    }
  }, [history, historyPos, setUpper, setLower]);

  const redo = useCallback(() => {
    if (historyPos >= history.length - 1) return;
    const pos = historyPos + 1;
    const snap = history[pos];
    if (!snap) return;
    setHistoryPos(pos);
    setUpper(snap.upper);
    setLower(snap.lower);
  }, [history, historyPos, setUpper, setLower]);

  const addCondition = useCallback(
    (value: string, target: "upper" | "lower") => {
      const current = target === "upper" ? upper : lower;
      const parts = current.split("、").filter(Boolean);
      if (parts.includes(value)) return;
      const next = parts.length ? `${current}、${value}` : value;
      // Record once in the event handler, never inside a replayable state updater.
      if (target === "upper") setUpper(next);
      else setLower(next);
      pushHistory(target === "upper" ? next : upper, target === "lower" ? next : lower);
    },
    [upper, lower, pushHistory, setUpper, setLower],
  );

  useEffect(() => {
    if (!previewRef.current) return;
    const u = normalizeConditionLatex(upper.trim());
    const l = normalizeConditionLatex(lower.trim());
    const cmd = reversible ? "\\xrightleftharpoons" : "\\xrightarrow";
    let formula: string;
    if (u && l) {
      formula = String.raw`\ce{A ${cmd}[${l}]{${u}} B}`;
    } else if (u) {
      formula = String.raw`\ce{A ${cmd}{${u}} B}`;
    } else if (l) {
      formula = String.raw`\ce{A ${cmd}[${l}]{} B}`;
    } else {
      formula = String.raw`\ce{A ${cmd}{} B}`;
    }
    try {
      katex.render(formula, previewRef.current, {
        throwOnError: false,
        strict: "warn",
        trust: false,
      });
    } catch {
      previewRef.current.innerHTML = "";
    }
  }, [upper, lower, reversible]);

  const isInsertable = !!upper.trim() || !!lower.trim();

  return (
    <div className="chemistry-condition-overlay">
      <button
        type="button"
        className="chemistry-condition-backdrop"
        aria-label="关闭反应条件弹窗"
        onClick={onCancel}
      />
      <div
        className="chemistry-condition-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="chemistry-condition-modal-header">
          <h3 id={titleId}>反应条件</h3>
          <div className="chemistry-condition-header-actions">
            <button
              type="button"
              className="chemistry-icon-btn"
              title="撤销"
              disabled={historyPos < 0}
              onClick={undo}
            >
              ↩
            </button>
            <button
              type="button"
              className="chemistry-icon-btn"
              title="重做"
              disabled={historyPos >= history.length - 1}
              onClick={redo}
            >
              ↪
            </button>
            <button
              type="button"
              aria-label="关闭反应条件"
              className="chemistry-modal-close dialog-close-button dialog-close-control"
              onClick={onCancel}
            >
              <DialogCloseIcon />
            </button>
          </div>
        </div>

        {/* 实时预览（始终显示） */}
        <div className="chemistry-condition-preview" ref={previewRef} />

        {/* 箭头上方条件 */}
        <label className="chemistry-condition-label" htmlFor={upperInputId}>
          箭头上方（催化剂优先）
        </label>
        <input
          id={upperInputId}
          ref={upperInputRef}
          type="text"
          className="chemistry-condition-input"
          placeholder="如 MnO₂、Pt……"
          value={upper}
          onChange={(e) => {
            setUpper(e.currentTarget.value);
            pushHistory(e.currentTarget.value, lower);
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229 &&
              isInsertable
            ) {
              e.preventDefault();
              onInsert();
            }
          }}
        />

        {/* 箭头下方条件（可折叠） */}
        <SpatialCollapse open={Boolean(showLower)}>
          {showLower ? (
            <>
              <label className="chemistry-condition-label" htmlFor={lowerInputId}>
                箭头下方（辅助条件）
              </label>
              <div className="chemistry-condition-lower-row">
                <input
                  id={lowerInputId}
                  type="text"
                  className="chemistry-condition-input"
                  placeholder="如 Δ、hν……"
                  value={lower}
                  onChange={(e) => {
                    setLower(e.currentTarget.value);
                    pushHistory(upper, e.currentTarget.value);
                  }}
                />
                <button
                  type="button"
                  className="chemistry-condition-collapse"
                  onClick={() => {
                    setShowLower(false);
                  }}
                >
                  收起
                </button>
              </div>
            </>
          ) : null}
        </SpatialCollapse>
        {!showLower && (
          <button
            type="button"
            className="chemistry-condition-add-lower"
            onClick={() => setShowLower(true)}
          >
            ＋ 添加箭头下方条件
          </button>
        )}

        {/* 快捷按钮 */}
        <div className="chemistry-condition-section">
          <p className="chemistry-condition-section-title">
            {showLower ? "上方常用（催化剂）" : "常用（点击填入上方）"}
          </p>
          <div className="chemistry-condition-presets">
            {UPPER_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className={`chemistry-condition-chip${
                  upper.split("、").includes(preset.value) ? " is-selected" : ""
                }`}
                onClick={() => addCondition(preset.value, "upper")}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="chemistry-condition-section">
          <p className="chemistry-condition-section-title">通用条件</p>
          <div className="chemistry-condition-presets">
            {GENERAL_PRESETS.map((item) => {
              const target = showLower ? lower : upper;
              const isSelected = target.split("、").includes(item.value);
              return (
                <button
                  key={item.label}
                  type="button"
                  className={`chemistry-condition-chip${isSelected ? " is-selected" : ""}`}
                  onClick={() => addCondition(item.value, showLower ? "lower" : "upper")}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        {errorMessage ? <p role="alert">{errorMessage}</p> : null}
        <div className="chemistry-condition-modal-footer">
          <button
            type="button"
            className={`chemistry-condition-arrow-switch${reversible ? " is-active" : ""}`}
            title={
              reversible
                ? "当前为双向箭头，点击切换为单向箭头"
                : "当前为单向箭头，点击切换为双向箭头"
            }
            onClick={() => setReversible((value: boolean) => !value)}
          >
            切换 <span aria-hidden="true">⇌</span>
          </button>
          <div className="chemistry-condition-footer-actions">
            <button type="button" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!isInsertable}
              onClick={onInsert}
            >
              {editing ? "保存条件" : "插入条件箭头"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChemicalPresetFormula({ formula }: { formula: string }) {
  const formulaRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!formulaRef.current) return;
    katex.render(String.raw`\ce{${formula}}`, formulaRef.current, {
      throwOnError: false,
      strict: "warn",
      trust: false,
    });
  }, [formula]);

  return <strong ref={formulaRef} className="chemistry-preset-formula" aria-hidden="true" />;
}

function LoadingStructureEditor() {
  return <p className="ketcher-editor-state">正在加载结构编辑器…</p>;
}

function requestKey(request: ChemistryDialogRequest): string {
  if (request.type === "new") return "new";
  return request.kind === "equation"
    ? `equation:${request.mode}:${request.source}`
    : `structure:${request.targetKey ?? ""}:${request.editorMode ?? "molecule"}:${request.ketSource}`;
}

function loadMathliveModule(): Promise<unknown> {
  return import("mathlive");
}

export function ChemistryDialog({
  open: requestedOpen = true,
  displayMode = "modal",
  positionKey = "chemistry-editor",
  sessionId,
  request,
  drawingsOnly = false,
  onConfirm,
  onCancel,
  onKindChange,
  supportsStructures = true,
  errorMessage = null,
  saveState = "saved",
  onRetrySave,
  onInsertEquationToDrawings,
  onInsertStructureToDrawings,
  onReplaceEquationToDrawings,
  onReplaceStructureToDrawings,
  loadMathlive = loadMathliveModule,
}: ChemistryDialogProps) {
  const titleId = useId();
  const parentClosing = useMotionPresenceClosing();
  const sessionVisible = useEditorSessionVisible();
  const open = requestedOpen && !parentClosing && sessionVisible;
  const paintVisible = useRetainedTransientVisibility(open);
  const drag = useDialogDrag<HTMLElement>({
    positionKey,
    memory: "session",
    movable: displayMode === "modeless",
    stackable: displayMode === "modeless" && open,
  });
  const currentRequestKey = requestKey(request);
  const requestInitial = initialState(request);
  const [activeKind, setActiveKind] = useState(requestInitial.activeKind);
  const [equation, setEquation] = useState(requestInitial.equation);
  const [adapter, setAdapter] = useState<KetcherAdapter | null>(null);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [structureHasContent, setStructureHasContent] = useState(false);
  const [structureDirty, setStructureDirty] = useState(false);
  const [structureReset, setStructureReset] = useState(0);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [mathliveError, setMathliveError] = useState<string | null>(null);
  const [mathliveReady, setMathliveReady] = useState(false);
  const [periodicPanelOpen, setPeriodicPanelOpen] = useState(false);
  const [isReactionConditionEntryOpen, setReactionConditionEntryOpen] = useState(false);
  const [reactionConditionUpper, setReactionConditionUpper] = useState("");
  const [reactionConditionLower, setReactionConditionLower] = useState("");
  const [reactionReversible, setReactionReversible] = useState(false);
  const [reactionConditionError, setReactionConditionError] = useState<string | null>(null);
  const reactionTargetRef = useRef<ReactionConditionTarget | null>(null);
  const [suggestions, setSuggestions] = useState<ChemicalScriptSuggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [dismissedSuggestionSource, setDismissedSuggestionSource] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [scriptMode, setScriptMode] = useState<ChemicalScriptMode | null>(null);
  const [suggestionContextRevision, setSuggestionContextRevision] = useState(0);
  const [hasVisitedStructure, setHasVisitedStructure] = useState(
    requestInitial.activeKind === "structure",
  );
  const isEquation = activeKind === "equation";
  const mathFieldRef = useRef<ChemicalMathField | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const fieldSyncSkipRef = useRef(false);
  const mathliveSyncedRef = useRef(false);
  const userEditedEquationRef = useRef(false);
  const requestStateRef = useRef({ key: currentRequestKey, value: requestInitial });
  const mountedRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const previousRequestKeyRef = useRef(currentRequestKey);
  const previousRequestedKindRef = useRef(requestInitial.activeKind);

  if (previousRequestKeyRef.current !== currentRequestKey) {
    previousRequestKeyRef.current = currentRequestKey;
    requestGenerationRef.current += 1;
    requestStateRef.current = { key: currentRequestKey, value: requestInitial };
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!open) {
      requestGenerationRef.current += 1;
      setIsGenerating(false);
      setReactionConditionEntryOpen(false);
    }
  }, [open]);

  const closeDialog = () => {
    requestGenerationRef.current += 1;
    setIsGenerating(false);
    setReactionConditionEntryOpen(false);
    setDiscardConfirmationOpen(false);
    onCancel();
  };

  // Reset before child readiness effects so a cached editor cannot lose its adapter.
  useLayoutEffect(() => {
    if (requestStateRef.current.key !== currentRequestKey) return;
    const next = requestStateRef.current.value;
    setActiveKind(next.activeKind);
    setEquation(next.equation);
    setAdapter(null);
    setStructureError(null);
    setStructureHasContent(false);
    setStructureDirty(false);
    setStructureReset(0);
    setDiscardConfirmationOpen(false);
    setIsGenerating(false);
    setHasVisitedStructure(next.activeKind === "structure");
    setSuggestions([]);
    setActiveSuggestionIndex(0);
    setDismissedSuggestionSource(null);
    setSuggestionError(null);
    setScriptMode(null);
    setReactionConditionEntryOpen(false);
    reactionTargetRef.current = null;
    userEditedEquationRef.current = false;
    previousRequestedKindRef.current = next.activeKind;
  }, [currentRequestKey]);

  useEffect(() => {
    if (request.type !== "new" || previousRequestedKindRef.current === requestInitial.activeKind) {
      return;
    }
    previousRequestedKindRef.current = requestInitial.activeKind;
    requestGenerationRef.current += 1;
    setIsGenerating(false);
    setSuggestions([]);
    setSuggestionError(null);
    setScriptMode(null);
    onKindChange?.(requestInitial.activeKind);
    if (requestInitial.activeKind === "structure") setHasVisitedStructure(true);
    setActiveKind(requestInitial.activeKind);
  }, [onKindChange, request.type, requestInitial.activeKind]);

  const retryMathlive = useCallback(() => {
    setMathliveError(null);
    void loadMathlive()
      .then(() => {
        if (mountedRef.current) setMathliveReady(true);
      })
      .catch(() => {
        if (mountedRef.current) setMathliveError("公式编辑器加载失败，请重试。");
      });
  }, [loadMathlive]);

  useEffect(() => {
    if (activeKind !== "equation") return;
    retryMathlive();
  }, [activeKind, retryMathlive]);

  const validation = useMemo(() => normalizeChemicalEquation(equation.source), [equation.source]);
  const equationError = validation.ok ? null : equationErrorMessage(validation.error.code);

  useEffect(() => {
    if (periodicPanelOpen || !previewRef.current || !validation.ok) return;
    previewRef.current.replaceChildren();
    katex.render(validation.value, previewRef.current, {
      displayMode: true,
      throwOnError: false,
      strict: "warn",
      trust: false,
    });
  }, [validation, periodicPanelOpen]);

  useEffect(() => {
    const field = mathFieldRef.current;
    if (!field || !mathliveReady) return;
    // MathLive 首次就绪：强制把当前 source 同步到输入框。若不强制，
    // 就绪前点击快捷按钮会因 fieldSyncSkipRef 被置位而跳过同步，
    // 导致输入区不显示（仅预览区更新）。同时清除升级前 ref 回调或
    // insertEquationToken 在未升级元素上写入的遮蔽 own data property，
    // 否则 MathLive 的 value 访问器会被遮蔽而无法生效。
    if (!mathliveSyncedRef.current) {
      mathliveSyncedRef.current = true;
      if (Object.hasOwn(field, "value")) {
        Reflect.deleteProperty(field, "value");
      }
      field.value = equation.source;
      fieldSyncSkipRef.current = false;
      // 首次就绪时主动聚焦，确保后续按钮点击的 executeCommand 可用。
      field.focus();
      return;
    }
    if (fieldSyncSkipRef.current) {
      fieldSyncSkipRef.current = false;
      return;
    }
    if (field.value !== equation.source) field.value = equation.source;
  }, [mathliveReady, equation.source]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: source changes and caret revisions intentionally retrigger MathLive context reads.
  useEffect(() => {
    if (!isEquation || !mathliveReady || !userEditedEquationRef.current || scriptMode) {
      setSuggestions((current) => (current.length > 0 ? [] : current));
      return;
    }

    const timer = window.setTimeout(() => {
      const field = mathFieldRef.current;
      const context = field ? readChemicalSuggestionContext(field) : null;
      if (!context || context.sourceVersion === dismissedSuggestionSource) {
        setSuggestions([]);
        return;
      }
      const nextSuggestions = suggestChemicalScripts(context);
      setSuggestions(nextSuggestions);
      setActiveSuggestionIndex(0);
      if (nextSuggestions.length > 0) setSuggestionError(null);
    }, 80);

    return () => window.clearTimeout(timer);
  }, [
    dismissedSuggestionSource,
    equation.source,
    isEquation,
    mathliveReady,
    scriptMode,
    suggestionContextRevision,
  ]);

  const acceptSuggestion = (index: number) => {
    const field = mathFieldRef.current;
    const suggestion = suggestions[index];
    if (!field || !suggestion) return;

    const result = applyChemicalSuggestion(field, suggestion);
    if (!result.ok) {
      setSuggestions([]);
      if (result.reason === "command-failed") {
        setSuggestionError("无法应用格式，原内容未改变");
      } else {
        setSuggestionContextRevision((revision) => revision + 1);
      }
      return;
    }

    fieldSyncSkipRef.current = true;
    setEquation((current) => ({ ...current, source: result.source }));
    setSuggestions([]);
    setSuggestionError(null);
  };

  const handleChemicalPhysicalKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const letter = getChemicalPhysicalLetter(event);
    const field = mathFieldRef.current;
    if (!letter || !field || !mathliveReady) return;

    const result = insertChemicalPhysicalLetter(field, letter);
    if (!result.ok) return;

    event.preventDefault();
    userEditedEquationRef.current = true;
    fieldSyncSkipRef.current = true;
    setEquation((current) => ({ ...current, source: result.source }));
    setSuggestions([]);
    setActiveSuggestionIndex(0);
    setDismissedSuggestionSource(null);
    setSuggestionError(null);
    setSuggestionContextRevision((revision) => revision + 1);
  };

  const handleEquationKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (suggestions.length > 0) {
      if (event.key === "Tab") {
        event.preventDefault();
        acceptSuggestion(activeSuggestionIndex);
        return;
      }
      if (suggestions.length > 1 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        setActiveSuggestionIndex((current) =>
          event.key === "ArrowDown"
            ? (current + 1) % suggestions.length
            : (current - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSuggestionSource(mathFieldRef.current?.value ?? equation.source);
        setSuggestions([]);
        return;
      }
    }

    if (scriptMode && (event.key === "ArrowRight" || event.key === " ")) {
      event.preventDefault();
      if (mathFieldRef.current && exitChemicalScript(mathFieldRef.current)) {
        setScriptMode(null);
      }
      return;
    }
    if (event.key === "^") setScriptMode("superscript");
    if (event.key === "_") setScriptMode("subscript");
    if (["ArrowLeft", "ArrowUp", "ArrowDown"].includes(event.key)) setScriptMode(null);
  };

  const handleEquationKeyUp = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (suggestions.length > 1 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      setSuggestionContextRevision((revision) => revision + 1);
    }
  };

  const handleKetcherReady = useCallback((value: KetcherAdapter) => {
    setAdapter(value);
    setStructureError(null);
  }, []);

  const handleKetcherError = useCallback(() => {
    setAdapter(null);
    setStructureHasContent(false);
    setStructureError("结构编辑器加载失败，请重试。");
  }, []);

  const handleStructureContentChange = useCallback(
    (state: { hasContent: boolean; dirty: boolean }) => {
      setStructureHasContent(state.hasContent);
      setStructureDirty(state.dirty);
      setStructureError(null);
    },
    [],
  );

  const discardStructureDraft = () => {
    requestGenerationRef.current += 1;
    setAdapter(null);
    setStructureHasContent(false);
    setStructureDirty(false);
    setStructureError(null);
    setStructureReset((value) => value + 1);
    closeDialog();
  };

  const insertEquationToken = (source: string) => {
    const field = mathFieldRef.current;
    setSuggestions([]);
    setSuggestionError(null);

    if (field?.executeCommand && mathliveReady) {
      // MathLive 的 executeCommand 在元素未完全初始化或未聚焦时可能静默
      // 返回 false 且不抛异常；先 focus 再执行。
      field.focus();
      // Replacing a selection with the same token is already successful. Do not
      // mistake unchanged content for a failed command and append a duplicate.
      if (
        field.selectionIsCollapsed === false &&
        field.selection &&
        typeof field.getValue === "function" &&
        field.getValue(field.selection, "latex").trim() === source.trim()
      )
        return;
      const valueBefore = field.value;
      const ok = field.executeCommand(["insert", source, { selectionMode: "after" }]);
      // 同步检查 field.value 是否真的变化了——executeCommand 可能在焦点切换
      // 中间态返回 true 但实际未生效（假阳性）。依赖异步 queueMicrotask 读值
      // 会导致假阳性时静默丢失首次交互。
      if (ok && field.value !== valueBefore) {
        fieldSyncSkipRef.current = true;
        setEquation((current) => ({ ...current, source: field.value }));
        return;
      }
      // executeCommand 失败或假阳性：回退到直接赋值路径，确保首次交互不被吞掉。
    }

    // 普通符号在 MathLive 未就绪或命令失败时，保留现有加载前输入方式。
    // 直接拼接 LaTeX 源码并设 field.value，绕过 executeCommand。
    const nextSource = appendChemicalToken(equation.source, source);
    if (field) {
      field.value = nextSource;
      if (typeof field.lastOffset === "number") field.position = field.lastOffset;
      field.focus();
    }
    fieldSyncSkipRef.current = true;
    setEquation((current) => ({ ...current, source: nextSource }));
  };

  const handleScriptButton = (mode: ChemicalScriptMode) => {
    const field = mathFieldRef.current;
    if (!field) return;
    setSuggestions([]);
    setSuggestionError(null);

    if (field.selectionIsCollapsed === false) {
      const result = toggleSelectedChemicalScript(field, mode);
      setScriptMode(null);
      if (!result.ok) {
        setSuggestionError(
          result.reason === "complex-selection"
            ? "当前选区包含复杂公式，请缩小选区后再试"
            : "未能读取选区，原内容未改变",
        );
        return;
      }
      fieldSyncSkipRef.current = true;
      setEquation((current) => ({ ...current, source: result.source }));
      return;
    }

    if (scriptMode === mode) {
      if (exitChemicalScript(field)) setScriptMode(null);
      return;
    }
    if (mathliveReady && enterChemicalScript(field, mode)) {
      setScriptMode(mode);
      return;
    }

    insertEquationToken(mode === "superscript" ? "^{}" : "_{}");
  };

  const openReactionCondition = () => {
    const field = mathFieldRef.current;
    if (!field || !mathliveReady) {
      setSuggestionError("公式编辑器尚未就绪，请稍后重试。");
      return;
    }
    const target = captureReactionCondition(field);
    if (!target) {
      setSuggestionError("请只选中一个完整的条件箭头，或取消选择后在光标处插入。");
      return;
    }
    reactionTargetRef.current = target;
    setReactionConditionUpper(target.condition?.upper ?? "");
    setReactionConditionLower(target.condition?.lower ?? "");
    setReactionReversible(target.condition?.reversible ?? false);
    setReactionConditionError(null);
    setSuggestionError(null);
    setSuggestions([]);
    setReactionConditionEntryOpen(true);
  };

  const cancelReactionCondition = () => {
    setReactionConditionEntryOpen(false);
    const field = mathFieldRef.current;
    const target = reactionTargetRef.current;
    if (field && target && field.value === target.sourceVersion) {
      field.focus();
      field.selection = target.selection;
    }
  };

  const insertReactionCondition = () => {
    if (!reactionConditionUpper.trim() && !reactionConditionLower.trim()) return;
    const field = mathFieldRef.current;
    const target = reactionTargetRef.current;
    if (!field || !target) return;
    const token = reactionConditionToken(
      reactionConditionUpper,
      reactionConditionLower,
      reactionReversible,
    );
    if (!normalizeChemicalEquation(token).ok) {
      setReactionConditionError("条件格式不正确，请检查括号和公式内容。");
      return;
    }
    const result = applyReactionCondition(field, target, token);
    if (!result.ok) {
      setReactionConditionError(
        result.reason === "stale"
          ? "原公式已变化，请取消后重新选择条件箭头。"
          : "未能更新条件，请重试；输入内容已保留。",
      );
      return;
    }
    fieldSyncSkipRef.current = true;
    setEquation((current) => ({ ...current, source: result.source }));
    setScriptMode(null);
    setReactionConditionEntryOpen(false);
  };

  const confirmEquation = () => {
    if (!validation.ok || isGenerating) return;
    onConfirm({ kind: "equation", mode: equation.mode, source: validation.value });
  };

  const confirmStructure = async () => {
    if (!supportsStructures || !adapter || isGenerating) return;
    const generation = requestGenerationRef.current;
    const isCurrentGeneration = () =>
      mountedRef.current && generation === requestGenerationRef.current;
    setStructureError(null);
    setIsGenerating(true);
    try {
      const result = await adapter.readDraft();
      if (!isCurrentGeneration()) return;
      if (!result.ok) {
        setStructureError(ketcherDraftErrorMessage(result.error.code));
        return;
      }
      const preview = await withStructureTimeout(
        window.patentApi.chemistry.rasterizePreview({
          sessionId,
          svg: result.value.svg,
          source: { ketSource: result.value.ket, editorMode: result.value.editorMode },
        }),
      );
      if (!isCurrentGeneration()) return;
      if (!preview.ok) {
        setStructureError(previewErrorMessage(preview.error.code));
        return;
      }
      await onConfirm({
        kind: "structure",
        ketSource: result.value.ket,
        editorMode: result.value.editorMode,
        previewAssetId: preview.value.descriptor.assetId,
        previewDescriptor: preview.value.descriptor,
      });
    } catch (error) {
      if (isCurrentGeneration())
        setStructureError(
          error instanceof StructureTimeoutError ? error.message : "保存结构式失败，请重试。",
        );
    } finally {
      if (isCurrentGeneration()) setIsGenerating(false);
    }
  };

  const insertStructureToDrawings = async (replace = false) => {
    const submit = replace ? onReplaceStructureToDrawings : onInsertStructureToDrawings;
    if (!submit || !supportsStructures || !adapter || isGenerating) return;
    const generation = requestGenerationRef.current;
    const isCurrentGeneration = () =>
      mountedRef.current && generation === requestGenerationRef.current;
    setStructureError(null);
    setIsGenerating(true);
    try {
      const result = await adapter.readDraft();
      if (!isCurrentGeneration()) return;
      if (!result.ok) {
        setStructureError(ketcherDraftErrorMessage(result.error.code));
        return;
      }
      const preview = await withStructureTimeout(
        window.patentApi.chemistry.rasterizePreview({
          sessionId,
          svg: result.value.svg,
          source: { ketSource: result.value.ket, editorMode: result.value.editorMode },
        }),
      );
      if (!isCurrentGeneration()) return;
      if (!preview.ok) {
        setStructureError(previewErrorMessage(preview.error.code));
        return;
      }
      await submit({
        descriptor: preview.value.descriptor,
        png: preview.value.preview,
        svg: result.value.svg,
        source: { ketSource: result.value.ket, editorMode: result.value.editorMode },
      });
    } catch (error) {
      if (isCurrentGeneration())
        setStructureError(
          error instanceof StructureTimeoutError ? error.message : "生成结构式附图失败，请重试。",
        );
    } finally {
      if (isCurrentGeneration()) setIsGenerating(false);
    }
  };

  const canConfirm = isEquation
    ? validation.ok
    : supportsStructures && adapter !== null && structureHasContent;
  const submitLabel = request.type === "edit" ? "保存" : "插入";
  const structureErrorMessage = !supportsStructures ? STRUCTURES_UNAVAILABLE_MESSAGE : errorMessage;

  return createPortal(
    <div
      className={`dialog-backdrop${displayMode === "modeless" ? " dialog-backdrop--modeless dialog-layer--modeless" : " dialog-layer--modal"}`}
      role="presentation"
      hidden={!paintVisible || !sessionVisible}
      inert={open ? undefined : true}
      aria-hidden={open ? undefined : true}
      data-motion={open ? "enter" : "exit"}
      style={{
        ...(displayMode === "modeless" ? drag.layerStyle : {}),
        display: paintVisible ? undefined : "none",
      }}
      onPointerDownCapture={displayMode === "modeless" ? drag.bringToFront : undefined}
    >
      <section
        ref={drag.surfaceRef}
        className={`formula-dialog chemistry-dialog${!isEquation ? " chemistry-dialog--structure" : ""}${periodicPanelOpen && isEquation ? " is-periodic-panel-open" : ""}${displayMode === "modeless" ? " dialog-surface--floating" : ""}`}
        role="dialog"
        {...(displayMode === "modal" ? { "aria-modal": "true" } : {})}
        aria-labelledby={titleId}
        style={displayMode === "modeless" ? drag.style : undefined}
      >
        <div className="chemistry-dialog-fixed-top">
          <header
            className={displayMode === "modeless" ? "dialog-titlebar--draggable" : undefined}
            ref={displayMode === "modeless" ? drag.titleBarRef : undefined}
          >
            <h2 id={titleId}>
              {request.type === "edit"
                ? activeKind === "equation"
                  ? "编辑化学方程式"
                  : "编辑化学结构式"
                : activeKind === "equation"
                  ? "插入化学方程式"
                  : "插入化学结构式"}
            </h2>
            {!isEquation && structureDirty ? (
              <span className="chemistry-draft-status">未保存</span>
            ) : null}
            {isEquation ? (
              <FormulaPositionSwitch
                kind="方程式"
                mode={equation.mode}
                onChange={(mode) => setEquation((current) => ({ ...current, mode }))}
              />
            ) : null}
            <button
              type="button"
              className="dialog-close-button dialog-close-control"
              aria-label="关闭弹窗"
              onClick={closeDialog}
            >
              <DialogCloseIcon />
            </button>
          </header>
        </div>
        <div className="chemistry-dialog-scroll-body">
          {
            <SpatialPresence>
              {structureErrorMessage ? <p role="alert">{structureErrorMessage}</p> : null}
            </SpatialPresence>
          }
          {isEquation ? (
            <section role="tabpanel" aria-label="化学方程式">
              <div className="chemistry-equation-wrapper">
                {createElement("math-field", {
                  ref: (element: ChemicalMathField | null) => {
                    mathFieldRef.current = element;
                    if (!element) return;
                    element.value = equation.source;
                    for (const eventType of [
                      "compositionstart",
                      "compositionupdate",
                      "compositionend",
                    ]) {
                      element.addEventListener(eventType, blockChemicalImeComposition, {
                        capture: true,
                      });
                    }
                    element.addEventListener(
                      "mount",
                      () => {
                        // 移除 MathLive 自带的虚拟键盘和菜单按钮。
                        // 属性方式（virtual-keyboard-mode/menuItems）在部分 MathLive
                        // 版本中不可靠，改为直接操作 shadow DOM 暴力隐藏。
                        const root = (element as { shadowRoot?: ShadowRoot }).shadowRoot;
                        if (root) {
                          for (const part of ["virtual-keyboard-toggle", "menu-toggle"]) {
                            const btn = root.querySelector(
                              `[part="${part}"]`,
                            ) as HTMLElement | null;
                            if (btn) btn.style.display = "none";
                          }
                        }
                      },
                      { once: true },
                    );
                  },
                  class: "chemistry-equation-field",
                  role: "textbox",
                  "aria-label": "化学方程式编辑器",
                  placeholder: String.raw`2H_{2} + O_{2} \xrightarrow{\mathrm{点燃}} 2H_{2}O`,
                  "smart-mode": "true",
                  "letter-shape-style": "upright",
                  "virtual-keyboard-mode": "off",
                  // MathLive 异步加载期间 math-field 尚未升级（custom element 未定义），
                  // 此时用户输入会因未升级元素不处理键盘事件而丢失。在就绪前禁用交互。
                  style: !mathliveReady
                    ? ({ pointerEvents: "none", opacity: 0.55 } as React.CSSProperties)
                    : undefined,
                  onKeyDownCapture: handleChemicalPhysicalKeyDown,
                  onKeyDown: handleEquationKeyDown,
                  onKeyUp: handleEquationKeyUp,
                  onPointerDown: () => setScriptMode(null),
                  onPointerUp: () => setSuggestionContextRevision((revision) => revision + 1),
                  onInput: (event: Event) => {
                    const source = (event.currentTarget as ChemicalMathField).value;
                    userEditedEquationRef.current = true;
                    fieldSyncSkipRef.current = true;
                    setSuggestionError(null);
                    setEquation((current) => ({ ...current, source }));
                  },
                })}
                {equation.source ? (
                  <button
                    type="button"
                    className="chemistry-clear-button"
                    onClick={() => {
                      fieldSyncSkipRef.current = true;
                      setSuggestions([]);
                      setSuggestionError(null);
                      setScriptMode(null);
                      setEquation((current) => ({ ...current, source: "" }));
                      if (mathFieldRef.current) mathFieldRef.current.value = "";
                    }}
                  >
                    清空
                  </button>
                ) : null}
              </div>
              <ChemicalSuggestionBar
                candidates={suggestions}
                activeIndex={activeSuggestionIndex}
                onActivate={setActiveSuggestionIndex}
                onAccept={acceptSuggestion}
              />
              {
                <SpatialPresence>
                  {scriptMode ? (
                    <p className="chemistry-script-hint" role="status">
                      正在输入{scriptMode === "superscript" ? "上标" : "下标"}，按
                      →、空格或再次点击按钮退出
                    </p>
                  ) : null}
                </SpatialPresence>
              }
              <SpatialPresence>
                {suggestionError ? (
                  <p className="chemistry-suggestion-error" role="alert">
                    {suggestionError}
                  </p>
                ) : null}
              </SpatialPresence>
              <fieldset className="formula-symbols chemistry-symbols">
                <legend>反应与格式符号</legend>
                {EQUATION_SYMBOLS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    aria-label={item.label}
                    aria-pressed={
                      item.label === "上标"
                        ? scriptMode === "superscript"
                        : item.label === "下标"
                          ? scriptMode === "subscript"
                          : undefined
                    }
                    title={
                      item.label === "上标"
                        ? "用于电荷、价态、同位素"
                        : item.label === "下标"
                          ? "用于原子数和基团数量"
                          : undefined
                    }
                    onClick={() => {
                      if ("previewFormula" in item) {
                        openReactionCondition();
                        return;
                      }
                      if (item.label === "上标") {
                        handleScriptButton("superscript");
                        return;
                      }
                      if (item.label === "下标") {
                        handleScriptButton("subscript");
                        return;
                      }
                      insertEquationToken(item.source);
                    }}
                  >
                    {"previewFormula" in item ? (
                      <ChemicalPresetFormula formula={item.previewFormula} />
                    ) : (
                      <strong className="chemistry-symbol-preview">{item.symbol}</strong>
                    )}
                    <span>{item.label}</span>
                  </button>
                ))}
              </fieldset>
              <MotionPresence>
                {isReactionConditionEntryOpen ? (
                  <ReactionConditionModal
                    editing={Boolean(reactionTargetRef.current?.condition)}
                    errorMessage={reactionConditionError}
                    upper={reactionConditionUpper}
                    lower={reactionConditionLower}
                    reversible={reactionReversible}
                    setUpper={setReactionConditionUpper}
                    setLower={setReactionConditionLower}
                    setReversible={setReactionReversible}
                    onInsert={insertReactionCondition}
                    onCancel={cancelReactionCondition}
                  />
                ) : null}
              </MotionPresence>
              <SpatialCollapse open={!periodicPanelOpen} className="chemistry-preview-collapse">
                <section className="formula-preview chemistry-preview" aria-label="化学方程式预览">
                  <h3>预览</h3>
                  {
                    <SpatialPresence>
                      {mathliveError ? (
                        <p role="alert">
                          {mathliveError}
                          <button type="button" onClick={retryMathlive}>
                            重试加载公式编辑器
                          </button>
                        </p>
                      ) : equationError ? (
                        <p role="alert">{equationError}</p>
                      ) : (
                        <div ref={previewRef}>
                          {!equation.source && (
                            <p className="chemistry-preview-placeholder">请输入化学方程式。</p>
                          )}
                        </div>
                      )}
                    </SpatialPresence>
                  }
                </section>
              </SpatialCollapse>
              <SpatialPresence>
                {periodicPanelOpen && (mathliveError || (equation.source && equationError)) ? (
                  <p role="alert" className="chemistry-suggestion-error">
                    {mathliveError ?? equationError}
                    {mathliveError ? (
                      <button type="button" onClick={retryMathlive}>
                        重试加载公式编辑器
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </SpatialPresence>
            </section>
          ) : null}
          <SpatialPresence>
            {supportsStructures && hasVisitedStructure ? (
              <section
                className="chemistry-structure-panel"
                role="tabpanel"
                aria-label="化学结构式"
                hidden={isEquation}
              >
                {saveState === "failed" ? (
                  <section className="chemistry-save-warning" role="alert">
                    <p>当前专利保存失败，结构式插入后尚未安全写入专利文件。</p>
                    {onRetrySave ? (
                      <button type="button" onClick={() => void onRetrySave()}>
                        重试保存
                      </button>
                    ) : null}
                  </section>
                ) : null}
                <Suspense fallback={<LoadingStructureEditor />}>
                  <KetcherEditor
                    key={`${currentRequestKey}:${structureReset}`}
                    {...(requestInitial.structureKet
                      ? { initialKet: requestInitial.structureKet }
                      : {})}
                    initialMode={requestInitial.structureMode}
                    onReady={handleKetcherReady}
                    onError={handleKetcherError}
                    onContentChange={handleStructureContentChange}
                  />
                </Suspense>
                {structureError ? <p role="alert">{structureError}</p> : null}
              </section>
            ) : null}
          </SpatialPresence>
        </div>
        <SpatialCollapse
          className="chemistry-periodic-collapse"
          open={Boolean(isEquation && periodicPanelOpen)}
        >
          {
            <div className="chemistry-periodic-tray is-open">
              <ChemicalPeriodicPanel
                onInsertElement={(token) => {
                  insertEquationToken(token);
                }}
                onClose={() => setPeriodicPanelOpen(false)}
              />
            </div>
          }
        </SpatialCollapse>
        {discardConfirmationOpen ? (
          <div
            className="chemistry-discard-confirmation"
            role="alertdialog"
            aria-label="放弃结构式修改"
          >
            <span>
              {request.type === "edit"
                ? "放弃本次修改，保留文档中的原结构式？"
                : "清空本次绘制的草稿？"}
            </span>
            <button type="button" onClick={() => setDiscardConfirmationOpen(false)}>
              继续编辑
            </button>
            <button type="button" onClick={discardStructureDraft}>
              放弃并关闭
            </button>
          </div>
        ) : null}
        <footer>
          <div className="formula-dialog-footer-tools">
            {isEquation ? (
              <button
                type="button"
                className="chemistry-toggle-panel"
                aria-expanded={periodicPanelOpen}
                onClick={() => setPeriodicPanelOpen((open) => !open)}
              >
                {periodicPanelOpen ? "收起元素面板" : "展开元素面板"}
              </button>
            ) : null}
            {!isEquation && structureDirty ? (
              <button
                type="button"
                disabled={isGenerating}
                onClick={() => setDiscardConfirmationOpen(true)}
              >
                放弃修改
              </button>
            ) : null}
          </div>
          <div className="formula-dialog-footer-actions">
            {isEquation && onInsertEquationToDrawings ? (
              <FigureDrawingActions
                disabled={!validation.ok || isGenerating}
                onInsert={() =>
                  void onInsertEquationToDrawings(validation.ok ? validation.value : "")
                }
                onReplace={
                  onReplaceEquationToDrawings
                    ? () => void onReplaceEquationToDrawings(validation.ok ? validation.value : "")
                    : undefined
                }
              />
            ) : null}
            <button
              type="button"
              onClick={closeDialog}
              title={isEquation ? undefined : "关闭并保留草稿"}
            >
              {isEquation ? "取消" : "关闭"}
            </button>
            {!isEquation &&
            onInsertStructureToDrawings &&
            !(drawingsOnly && request.type === "edit") ? (
              <FigureDrawingActions
                disabled={!canConfirm || isGenerating}
                onInsert={() => void insertStructureToDrawings()}
                onReplace={
                  onReplaceStructureToDrawings
                    ? () => void insertStructureToDrawings(true)
                    : undefined
                }
              />
            ) : null}
            {!drawingsOnly || request.type === "edit" ? (
              <button
                type="button"
                className="primary-button"
                disabled={!canConfirm || isGenerating}
                onClick={() => {
                  if (isEquation) confirmEquation();
                  else void confirmStructure();
                }}
              >
                {isGenerating ? "正在生成…" : submitLabel}
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
