import type { Ketcher } from "ketcher-core";
import type { ButtonsConfig } from "ketcher-react";
import type { ComponentType } from "react";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { platformNativeShortcut, platformShortcut } from "../../../shared/platform";
import { SpatialPresence } from "../shared/spatial-presence";
import {
  createKetcherAdapter,
  type KetcherAdapter,
  type KetcherAdapterErrorCode,
  type KetcherPublicApi,
} from "./ketcher-adapter";
import "./ketcher-editor.css";
import { withStructureTimeout } from "./structure-timeout";

type KetcherBrowserProcess = {
  env?: Record<string, string | undefined>;
  nextTick?: (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => void;
};

type KetcherBrowserGlobalTarget = {
  global?: object;
  process?: KetcherBrowserProcess;
};

type ElectronClipboardApi = {
  readText(): Promise<{ ok: true; value: string } | { ok: false; error: { message: string } }>;
  writeText(
    text: string,
  ): Promise<{ ok: true; value: void } | { ok: false; error: { message: string } }>;
};

type KetcherClipboardItem = {
  types: readonly string[];
  getType(type: string): Promise<Blob>;
};

type KetcherClipboard = {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  read(): Promise<KetcherClipboardItem[]>;
  write(items: readonly KetcherClipboardItem[]): Promise<void>;
};

const KETCHER_SHADOW_ROOTS_KEY = Symbol.for("patent-workbench.ketcher-shadow-roots");

type ShadowRootCaptureTarget = typeof Element.prototype & {
  [KETCHER_SHADOW_ROOTS_KEY]?: WeakMap<Element, ShadowRoot>;
};

function captureKetcherShadowRoots(): WeakMap<Element, ShadowRoot> {
  const target = Element.prototype as ShadowRootCaptureTarget;
  const existing = target[KETCHER_SHADOW_ROOTS_KEY];
  if (existing) return existing;
  const roots = new WeakMap<Element, ShadowRoot>();
  const attachShadow = target.attachShadow;
  target.attachShadow = function (init: ShadowRootInit): ShadowRoot {
    const root = attachShadow.call(this, init);
    roots.set(this, root);
    return root;
  };
  target[KETCHER_SHADOW_ROOTS_KEY] = roots;
  return roots;
}

const ketcherShadowRoots = captureKetcherShadowRoots();

export function installKetcherBrowserGlobals(target: object): void {
  const browserTarget = target as KetcherBrowserGlobalTarget;
  browserTarget.global ??= target;
  browserTarget.process ??= {};
  browserTarget.process.env ??= {};
  browserTarget.process.nextTick ??= (callback, ...args) => {
    queueMicrotask(() => callback(...args));
  };
}

function clipboardValue<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(result.error.message);
}

/**
 * Ketcher relies on Chromium's async Clipboard API, which Electron deliberately
 * denies to file:// renderer pages.  Translate its text-based clipboard contract
 * to the native Electron clipboard while keeping the renderer sandboxed.
 */
export function createKetcherClipboardBridge(api: ElectronClipboardApi): KetcherClipboard {
  const readText = async () => clipboardValue(await api.readText());
  const writeText = async (text: string) => {
    clipboardValue(await api.writeText(text));
  };
  return {
    readText,
    writeText,
    async read() {
      const text = await readText();
      return [
        {
          types: ["text/plain"],
          getType: async (type: string) => {
            if (type !== "text/plain")
              throw new DOMException("不支持的剪贴板格式", "NotFoundError");
            return new Blob([text], { type });
          },
        },
      ];
    },
    async write(items) {
      for (const item of items) {
        if (!item.types.includes("text/plain")) continue;
        await writeText(await (await item.getType("text/plain")).text());
        return;
      }
      throw new DOMException("剪贴板中没有可写入的文本", "NotSupportedError");
    },
  };
}

function installKetcherClipboardBridge(): void {
  const api = window.patentApi?.clipboard as ElectronClipboardApi | undefined;
  if (!api || typeof navigator === "undefined") return;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: createKetcherClipboardBridge(api),
  });
}

// Ketcher 3.17.1 still reads Node's `global` and `process` from its browser bundles.
installKetcherBrowserGlobals(globalThis);
installKetcherClipboardBridge();

type KetcherReactEditorProps = {
  staticResourcesUrl: string;
  structServiceProvider: unknown;
  disableMacromoleculesEditor?: boolean;
  buttons?: ButtonsConfig;
  onInit?(ketcher: Ketcher): void;
  errorHandler(message: string): void;
};

export type KetcherRuntime = {
  Editor: ComponentType<KetcherReactEditorProps>;
  StandaloneStructServiceProvider: new () => unknown;
};

class KetcherRuntimeBoundary extends Component<
  { children: ReactNode; onError(): void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onError();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export type KetcherEditorProps = {
  initialKet?: string;
  initialMode?: import("./ketcher-adapter").ChemicalEditorMode;
  onReady?(adapter: KetcherAdapter): void;
  onContentChange?(state: { hasContent: boolean; dirty: boolean }): void;
  onError?(error: { code: KetcherAdapterErrorCode | "KETCHER_RUNTIME_LOAD_FAILED" }): void;
  loadRuntime?: (attempt: number) => Promise<KetcherRuntime>;
};

const OFFLINE_BUTTONS: ButtonsConfig = {
  about: { hidden: true },
  analyse: { hidden: true },
  check: { hidden: true },
  cip: { hidden: true },
  help: { hidden: true },
  miew: { hidden: true },
  recognize: { hidden: true },
  settings: { hidden: true },
};

const FILE_CONTROL_SELECTOR = [
  '[title^="Open..."]',
  '[aria-label^="Open..."]',
  '[title^="Save as..."]',
  '[aria-label^="Save as..."]',
  '[title^="Open…"]',
  '[aria-label^="Open…"]',
  '[title^="Save as…"]',
  '[aria-label^="Save as…"]',
  '[title^="Save As…"]',
  '[aria-label^="Save As…"]',
].join(",");

/**
 * Ketcher 3.17 左侧工具栏的向上/向下滚动箭头按钮（upDown 布局下 data-testid
 * 固定为 down/left；左右工具栏各渲染一组）。原实现单击只滚动一个按钮组高度
 * （几十像素），且右侧工具栏的滚动容器高度未被约束导致 scrollTop 赋值无效
 * （点击无反应）。这里在捕获阶段接管点击，改为大步长即时滚动。
 */
const TOOLBAR_ARROW_SELECTOR = [
  '[data-testid="arrow-scroll-down-button"]',
  '[data-testid="arrow-scroll-left-button"]',
].join(",");

const ARROW_UP_TESTID = "arrow-scroll-left-button";
const ARROW_DOWN_TESTID = "arrow-scroll-down-button";

/**
 * 左侧工具栏布局定制：从"反应加号"（reaction-plus）开始的按钮整体移到底部
 * 工具栏最左侧横向展开（环模板等自动右移让位），左侧列因此缩短、不再需要
 * ▲▼ 滚动箭头（由 CSS 隐藏）。
 *
 * 按钮的 data-testid 即工具 id；多选工具（arrows/shapes/mapping）外层容器
 * 的 testid 为 `${id}-drop-down-button`。
 */
const TOOLBAR_EXTRA_TESTIDS = new Set([
  "reaction-plus",
  "arrows",
  "reaction-mapping-tools",
  "shapes",
  "text",
  "images",
]);

const EXTRA_TOOLBAR_TESTID_SUFFIX = "-drop-down-button";
const RIGHT_TOOLBAR_EXTRA_TESTIDS = new Set(["any-atom", "extended-table"]);
const RIGHT_TOOLBAR_ARROW_SELECTOR = [
  '[data-testid="arrow-scroll-right-button"]',
  '[data-testid="arrow-scroll-left-button"]',
].join(",");

function isExtraToolTestId(testId: string | null | undefined): boolean {
  if (!testId) return false;
  if (TOOLBAR_EXTRA_TESTIDS.has(testId)) return true;
  return TOOLBAR_EXTRA_TESTIDS.has(
    testId.endsWith(EXTRA_TOOLBAR_TESTID_SUFFIX)
      ? testId.slice(0, -EXTRA_TOOLBAR_TESTID_SUFFIX.length)
      : testId,
  );
}

function findToolbarScrollContainer(shell: ParentNode, button: Element): HTMLElement | null {
  const rightToolbar = button.closest<HTMLElement>('[data-testid="right-toolbar"]');
  if (rightToolbar) {
    return rightToolbar.querySelector<HTMLElement>(":scope > div");
  }
  return shell.querySelector<HTMLElement>('[data-testid="left-toolbar-buttons"]');
}

const KETCHER_TOOL_LABELS: Readonly<Record<string, string>> = {
  "Clear Canvas": "清空画布",
  Copy: "复制",
  Paste: "粘贴",
  Cut: "剪切",
  Undo: "撤销",
  Redo: "重做",
  Aromatize: "芳构化",
  Dearomatize: "去芳构化",
  Layout: "整理布局",
  "Clean Up": "整理结构",
  "Add/Remove explicit hydrogens": "添加或移除显式氢",
  "Fullscreen mode": "全屏编辑",
  "Hand tool": "移动画布",
  "Rectangle Selection": "矩形选择",
  Erase: "擦除",
  "Single Bond": "单键",
  Chain: "链工具",
  Stereochemistry: "立体化学键",
  "Charge Plus": "添加正电荷",
  "Charge Minus": "添加负电荷",
  "S-Group": "S 组",
  "R-Group Label Tool": "R 基标签",
  "Reaction Plus Tool": "反应加号",
  "Arrow Open Angle Tool": "反应箭头",
  "Reaction Mapping Tool": "反应映射",
  "Create a monomer": "创建单体",
  "Shape Ellipse": "椭圆形状",
  "Add text": "添加文字",
  "Add Image": "添加图片",
  Benzene: "苯环",
  Cyclopentadiene: "环戊二烯",
  Cyclohexane: "环己烷",
  Cyclopentane: "环戊烷",
  Cyclopropane: "环丙烷",
  Cyclobutane: "环丁烷",
  Cycloheptane: "环庚烷",
  Cyclooctane: "环辛烷",
  "Structure Library": "结构模板库",
  Hydrogen: "氢",
  Carbon: "碳",
  Nitrogen: "氮",
  Oxygen: "氧",
  Sulfur: "硫",
  Phosphorus: "磷",
  Fluorine: "氟",
  Chlorine: "氯",
  Bromine: "溴",
  Iodine: "碘",
  "Periodic Table": "元素周期表",
  "Periodic table of the chemical elements": "化学元素周期表",
  "Any atom": "任意原子",
  "Extended Table": "扩展元素表",
  Single: "单个",
  List: "列表",
  "Not List": "非列表",
  Cancel: "取消",
  Add: "添加",
  "Save to SDF": "保存为 SDF",
  "Click to add to canvas": "单击添加到画布",
  "Atom Properties": "原子属性",
  "Bond Properties": "键属性",
  Atom: "原子",
  Bond: "化学键",
  "R-group": "R 基",
  "R-Group": "R 基",
  SGroup: "S 组",
  "Enhanced Stereochemistry": "增强立体化学",
  "Enhanced Stereo": "增强立体化学",
  "Text Editor": "文本编辑器",
  "Attachment Point Tool": "连接点工具",
  "R-Group Fragment Tool": "R 基片段工具",
  General: "常规",
  "Atom Type": "原子类型",
  Label: "标签",
  Number: "原子序数",
  Alias: "别名",
  Charge: "电荷",
  "Isotope (atomic mass)": "同位素（原子质量）",
  Valence: "化合价",
  Radical: "自由基",
  Special: "特殊原子",
  "Not list": "非列表",
  Monoradical: "单自由基",
  "Diradical (singlet)": "双自由基（单重态）",
  "Diradical (triplet)": "双自由基（三重态）",
  "Query specific": "查询条件",
  "Reaction flags": "反应标记",
  "H count": "氢原子数",
  "As drawn": "按绘制结构",
  aromatic: "芳香族",
  aliphatic: "脂肪族",
  anticlockwise: "逆时针",
  clockwise: "顺时针",
  "Custom Query": "自定义查询",
  Inversion: "构型变化",
  Inverts: "反转",
  Retains: "保留",
  "Exact change": "精确变化",
  Type: "类型",
  Topology: "拓扑类型",
  "Single Up": "单键（实楔形）",
  "Single Down": "单键（虚楔形）",
  "Single Up/Down": "单键（方向未定）",
  Double: "双键",
  "Double Cis/Trans": "双键（顺反未定）",
  Triple: "三键",
  Aromatic: "芳香键",
  Any: "任意",
  "Single/Double": "单键或双键",
  "Single/Aromatic": "单键或芳香键",
  "Double/Aromatic": "双键或芳香键",
  Dative: "配位键",
  Either: "任意",
  Ring: "环",
  "Reacting Center": "反应中心",
  Unmarked: "未标记",
  "Not center": "非反应中心",
  Center: "反应中心",
  "No change": "不变",
  "Made/broken": "形成或断裂",
  "Order changes": "键级变化",
  "Made/broken and changes": "形成或断裂并改变键级",
  OK: "确定",
  "Attachment Points": "连接点",
  "Primary attachment point": "主连接点",
  "Secondary attachment point": "次连接点",
  "S-Group Properties": "S 组属性",
  "S-Group properties": "S 组属性",
  "S-Group Type": "S 组类型",
  "Multiple group": "重复组",
  "Repeat count": "重复次数",
  "SRU polymer": "结构重复单元聚合物",
  "Polymer label": "聚合物标签",
  "Repeat Pattern": "重复连接方式",
  "Head-to-tail": "首尾相连",
  "Head-to-head": "首首相连",
  "Either unknown": "连接方式未知",
  Copolymer: "共聚物",
  Subtype: "子类型",
  Random: "无规",
  Block: "嵌段",
  Alternating: "交替",
  Superatom: "超原子",
  "Query component": "查询组分",
  "Nucleotide Component": "核苷酸组分",
  Component: "组分",
  Name: "名称",
  Data: "数据",
  Context: "上下文",
  "Field name": "字段名称",
  "Field value": "字段值",
  "R-Group Logic Condition": "R 基逻辑条件",
  Occurrence: "出现次数",
  RestH: "其余位置为氢",
  Condition: "条件",
  "Label Edit": "编辑标签",
  "Template edit": "编辑模板",
  "Molecule name": "分子名称",
  "Wrong label": "原子标签无效",
  "Wrong atom symbol": "原子符号无效",
  "Invalid atom list": "原子列表无效",
  "Invalid special atom": "特殊原子无效",
  "Leading and trailing spaces are not allowed": "首尾不能包含空格",
  "Invalid charge value": "电荷值无效",
  "Invalid isotope value": "同位素值无效",
  "Invalid custom query": "自定义查询无效",
  "Wrong value": "数值无效",
  "Please, specify field name": "请填写字段名称",
  "Please, specify field value": "请填写字段值",
  "Please, provide a name for the superatom": "请填写超原子名称",
  "SRU subscript should not be empty and contain double quotes": "重复单元下标不能为空或包含双引号",
  "Template must have a unique name and no more than 128 symbols in length":
    "模板名称必须唯一，且不超过 128 个字符",
  "Select All": "全选",
  "Deselect All": "取消全选",
  "Select descriptors": "选择描述符",
  "Edit...": "编辑…",
  "Edit selected atoms...": "编辑所选原子…",
  "Edit selected bonds...": "编辑所选键…",
  "Enhanced stereochemistry...": "增强立体化学…",
  "Query properties": "查询属性",
  "Query bonds": "查询键",
  "Ring bond count": "环键数",
  "Hydrogen count": "氢原子数",
  "Substitution count": "取代数",
  Unsaturated: "不饱和",
  Saturated: "饱和",
  Aromaticity: "芳香性",
  "Implicit H count": "隐式氢原子数",
  "Ring membership": "环成员数",
  "Ring size": "环大小",
  Connectivity: "连接度",
  Chirality: "手性",
  Highlight: "高亮显示",
  "No highlight": "清除高亮",
  Black: "黑色",
  White: "白色",
  Grey: "灰色",
  Red: "红色",
  Green: "绿色",
  Blue: "蓝色",
  Yellow: "黄色",
  Orange: "橙色",
  Violet: "紫罗兰色",
  Pink: "粉色",
  Magenta: "洋红色",
  Delete: "删除",
  Remove: "移除",
  "Change direction": "更改方向",
  "Attach S-Group...": "附加 S 组…",
  "Edit S-Group...": "编辑 S 组…",
  "Expand Abbreviation": "展开缩写",
  "Contract Abbreviation": "收起缩写",
  "Remove Abbreviation": "移除缩写",
  "Mark as leaving group": "标记为离去基团",
  "Mark as connection point": "标记为连接点",
  "Mark as a...": "标记为…",
  Base: "碱基",
  Sugar: "糖",
  Phosphate: "磷酸基",
  "Bond type": "键类型",
  "Edit connection point": "编辑连接点",
  "Remove assignment": "移除分配",
  "Add new tail": "添加新尾线",
  "Remove tail": "移除尾线",
  "Edit Instance": "编辑实例",
  "Expand monomer": "展开单体",
  "Expand monomers": "展开单体",
  "Collapse monomer": "收起单体",
  "Collapse monomers": "收起单体",
  "Confirm type change": "确认类型更改",
  "Changing the type will result in a loss of inputted data. Do you wish to proceed?":
    "更改类型将导致已输入数据丢失，是否继续？",
  "Unsupported S-group type found. Would you like to import structure without it?":
    "检测到不支持的 S 组类型。是否在不包含该类型的情况下导入结构？",
  "A change was detected for the abbreviation. Do you want to remove the abbreviation information from the structure and continue work with separate atoms and bond":
    "检测到缩写发生变化。是否移除结构中的缩写信息，并以独立原子和键继续编辑？",
  "No embedded structures found in the file": "文件中未找到可嵌入的结构。",
  "Please choose image": "请选择图片。",
  "Structure will be loaded as fragment and added to Clipboard":
    "结构将作为片段载入并添加到剪贴板。",
  "Open as new Project": "作为新项目打开",
  "Open from File": "从文件打开",
  "Open structure": "打开结构",
  "Save Structure": "保存结构",
  "Save to File": "保存到文件",
  "Save to Templates": "保存到模板库",
  "Add to Canvas": "添加到画布",
  "File name:": "文件名：",
  "File format:": "文件格式：",
  "Template Library": "模板库",
  "Functional Groups": "官能团",
  "Salts and Solvents": "盐类与溶剂",
  "Search by elements…": "按元素搜索…",
  "Search by elements...": "按元素搜索…",
  Macromolecules: "高分子",
  Molecules: "小分子",
  "Create Antisense Strand": "生成反义链",
  "Calculate properties": "计算结构属性",
  "Switch to sequence layout mode": "切换为序列布局",
  "Number of monomers in a line": "每行单体数",
  "Search by name...": "按名称搜索…",
  "Search by name…": "按名称搜索…",
  "Hide library": "收起单体库",
  "Show library": "展开单体库",
  Peptides: "肽类",
  "RNA Builder": "RNA 构建器",
  Presets: "预设",
  Bases: "碱基",
  Phosphates: "磷酸基团",
  Nucleotides: "核苷酸",
  "Add new": "新建",
  "Add sequence here": "在此输入序列",
  "Filter presets by phosphate position": "按磷酸基团位置筛选预设",
  Help: "帮助",
  About: "关于",
  "Error Message": "错误信息",
  "Your browser doesn't allow pasting clipboard content via button. Please use shortcut instead.":
    "浏览器不允许通过按钮粘贴剪贴板内容，请使用快捷键。",
  "CTRL/Cmd + V": platformShortcut("Ctrl+V"),
  "for paste": "进行粘贴",
  Confirm: "确认",
  Close: "关闭",
  Apply: "应用",
  Yes: "是",
  No: "否",
  Error: "错误",
  Warning: "警告",
  "α-D-Sugars": "α-D-糖类",
  Aromatics: "芳香族化合物",
  "β-D-Sugars": "β-D-糖类",
  Bicycles: "双环化合物",
  "Bridged Polycyclics": "桥环多环化合物",
  "Crown Ethers": "冠醚",
  "D-Amino Acids": "D-氨基酸",
  "D-Sugars": "D-糖类",
  "Heterocyclic Rings": "杂环",
  "L-Amino Acids": "L-氨基酸",
  Nucleobases: "核碱基",
  Rings: "环系",
  Sugars: "糖类",
  "3D Templates": "三维模板",
  Helium: "氦",
  Gold: "金",
};

function localizeKetcherToolLabel(value: string, bondContext = false): string | null {
  if (bondContext) {
    const bondLabels: Record<string, string> = {
      Single: "单键",
      Hydrogen: "氢键",
      Chain: "链",
      Any: "任意键",
    };
    if (bondLabels[value]) return bondLabels[value];
  }
  // Parenthesized chemistry terms are complete labels, not shortcut suffixes.
  if (KETCHER_TOOL_LABELS[value]) return KETCHER_TOOL_LABELS[value];
  if (
    /^(?:(?:Ctrl|Control|Shift|Alt|Option|Cmd|Command|Mod|Meta|⌘|⌃|⌥|⇧)\s*\+\s*)+[^+()\s]+$/iu.test(
      value,
    )
  )
    return platformNativeShortcut(value);
  const matched = /^(.*?)(?:\s*[(（]([^()（）]+)[)）])?$/u.exec(value);
  if (!matched) return null;
  const label = matched[1] ?? "";
  const translated =
    KETCHER_TOOL_LABELS[label] ??
    (Object.values(KETCHER_TOOL_LABELS).includes(label) ? label : null);
  if (!translated) return null;
  return matched[2] ? `${translated}（${platformNativeShortcut(matched[2])}）` : translated;
}

function isKetcherUserContent(element: Element | null): boolean {
  if (!element) return false;
  if (
    element.closest(
      'svg, canvas, input:not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, [contenteditable]:not([contenteditable="false"]), .ProseMirror, script, style',
    )
  )
    return true;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && isKetcherUserContent(root.host);
}

function isKetcherElementSymbol(element: Element | null): boolean {
  // Chemical symbols are not UI words (notably Nobelium "No" is not "否").
  return Boolean(
    element?.closest('[class*="ElementsTable-module_button"], [class*="Atom-module_atom__"]'),
  );
}

function localizeKetcherControls(
  root: ParentNode,
  visited = new Set<ParentNode>(),
  bondContext = false,
): void {
  if (visited.has(root)) return;
  visited.add(root);
  const translate = (value: string, element?: Element | null) =>
    localizeKetcherToolLabel(
      value,
      bondContext || Boolean(element?.closest('[class*="Bond-module_bond__"]')),
    );
  for (const [testId, label] of [
    ["copy-button-dropdown-triangle", "选择复制格式"],
    ["close-window-button", "关闭面板"],
  ] as const) {
    root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`).forEach((control) => {
      control.setAttribute("aria-label", label);
      control.setAttribute("title", label);
    });
  }
  root.querySelectorAll<HTMLElement>("[title], [aria-label]").forEach((control) => {
    if (isKetcherUserContent(control) || isKetcherElementSymbol(control)) return;
    const title = control.getAttribute("title");
    const ariaLabel = control.getAttribute("aria-label");
    const localizedTitle = title ? translate(title, control) : null;
    const localizedAriaLabel = ariaLabel ? translate(ariaLabel, control) : null;
    if (localizedTitle) control.setAttribute("title", localizedTitle);
    if (localizedAriaLabel) control.setAttribute("aria-label", localizedAriaLabel);
    if (localizedTitle && !ariaLabel) control.setAttribute("aria-label", localizedTitle);
  });

  root.querySelectorAll<HTMLInputElement>("input[placeholder]").forEach((input) => {
    const localized = translate(input.placeholder, input);
    if (localized) input.placeholder = localized;
  });

  root
    .querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="radio"], [role="tab"], [role="menuitem"]',
    )
    .forEach((control) => {
      if (isKetcherUserContent(control) || isKetcherElementSymbol(control)) return;
      const text = control.textContent?.trim();
      if (!text) return;
      if (text === "▼" || text === "▲") {
        control.setAttribute("aria-label", text === "▼" ? "展开更多工具" : "收起更多工具");
        return;
      }
      const localized = translate(text, control);
      if (localized && !control.hasAttribute("aria-label"))
        control.setAttribute("aria-label", localized);
    });

  root
    .querySelectorAll<HTMLInputElement>(
      'input[type="button"], input[type="submit"], input[type="reset"]',
    )
    .forEach((control) => {
      if (isKetcherUserContent(control)) return;
      const localized = translate(control.value, control);
      if (!localized) return;
      if (control.value !== localized) control.value = localized;
      if (control.getAttribute("value") !== localized) control.setAttribute("value", localized);
      control.setAttribute("aria-label", localized);
    });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  while (textNode) {
    const original = textNode.textContent;
    const text = original?.trim();
    const localized = text ? translate(text, textNode.parentElement) : null;
    if (
      original &&
      text &&
      localized &&
      localized !== text &&
      !isKetcherUserContent(textNode.parentElement) &&
      !isKetcherElementSymbol(textNode.parentElement)
    ) {
      textNode.textContent = original.replace(text, localized);
    }
    textNode = walker.nextNode();
  }

  root.querySelectorAll<HTMLElement>("*").forEach((element) => {
    if (isKetcherUserContent(element)) return;
    const shadowRoot = element.shadowRoot ?? ketcherShadowRoots.get(element);
    if (shadowRoot) localizeKetcherControls(shadowRoot, visited);
  });
  // MUI menus may portal into body. Follow only ownership links from this editor,
  // never translate the application body or unrelated editors.
  root
    .querySelectorAll<HTMLElement>("[aria-controls], [aria-owns], [aria-describedby]")
    .forEach((control) => {
      if (isKetcherUserContent(control)) return;
      const ids = `${control.getAttribute("aria-controls") ?? ""} ${control.getAttribute("aria-owns") ?? ""} ${control.getAttribute("aria-describedby") ?? ""}`;
      for (const id of ids.split(/\s+/u).filter(Boolean)) {
        const portal = control.ownerDocument.getElementById(id);
        if (
          portal &&
          portal !== document.body &&
          !portal.contains(control) &&
          !isKetcherUserContent(portal)
        ) {
          localizeKetcherControls(
            portal,
            visited,
            bondContext || Boolean(control.closest('[class*="Bond-module_bond__"]')),
          );
        }
      }
    });
  root.querySelectorAll<HTMLIFrameElement>("iframe").forEach((frame) => {
    try {
      if (frame.contentDocument) localizeKetcherControls(frame.contentDocument, visited);
    } catch {
      // Ketcher 内部跨源帧无法读取时，保留其原有安全边界。
    }
  });
}

/** 嵌入式容器会触发 Ketcher 的最小工具栏档位；恢复常用图标尺寸与元素文字对齐。 */
function normalizeKetcherToolbarSizing(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-testid="top-toolbar"] button').forEach((button) => {
    const dropdown = button.dataset.testid?.endsWith("-dropdown-triangle") ?? false;
    button.style.width = dropdown ? "18px" : "32px";
    button.style.height = "32px";
    button.style.padding = dropdown ? "0" : "6px";
    const icon = button.querySelector<HTMLElement>(":scope > svg");
    if (!icon) return;
    icon.style.top = dropdown ? "10px" : "6px";
    icon.style.left = dropdown ? "3px" : "6px";
    icon.style.width = dropdown ? "12px" : "20px";
    icon.style.height = dropdown ? "12px" : "20px";
  });
  root
    .querySelectorAll<HTMLElement>('[data-testid="right-toolbar"] [class*="Atom-module_atom"]')
    .forEach((atom) => {
      atom.style.display = "flex";
      atom.style.alignItems = "center";
      atom.style.justifyContent = "center";
      atom.style.padding = "0";
      atom.style.lineHeight = "1";
      const label = atom.querySelector<HTMLElement>(":scope > span");
      if (!label) return;
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.justifyContent = "center";
      label.style.width = "100%";
      label.style.height = "100%";
    });
}

const KETCHER_ADD_IMAGE_ICON_PATH =
  "M12.19 14.476H1.524V3.81H8.38V2.286H1.524C.686 2.286 0 2.97 0 3.81v10.666C0 15.314.686 16 1.524 16H12.19c.839 0 1.524-.686 1.524-1.524V7.62H12.19v6.857zm-5.935-2.415l-1.493-1.798-2.095 2.69h8.38L8.35 9.362l-2.095 2.698zm7.46-9.775V0H12.19v2.286H9.905c.007.007 0 1.524 0 1.524h2.286v2.278c.007.007 1.523 0 1.523 0V3.81H16V2.286h-2.286z";

const KETCHER_ADD_IMAGE_ICON_WITHOUT_LANDSCAPE_PATH =
  "M12.19 14.476H1.524V3.81H8.38V2.286H1.524C.686 2.286 0 2.97 0 3.81v10.666C0 15.314.686 16 1.524 16H12.19c.839 0 1.524-.686 1.524-1.524V7.62H12.19v6.857zm1.524-12.19V0H12.19v2.286H9.905V3.81h2.286v2.278h1.523V3.81H16V2.286h-2.286z";

/** “添加图片”没有下拉菜单；移除图标内易被误认为下拉箭头的山形装饰。 */
function simplifyImageToolIcon(root: ParentNode): void {
  root.querySelectorAll<SVGPathElement>('[data-testid="images"] > svg > path').forEach((path) => {
    if (path.getAttribute("d") === KETCHER_ADD_IMAGE_ICON_PATH) {
      path.setAttribute("d", KETCHER_ADD_IMAGE_ICON_WITHOUT_LANDSCAPE_PATH);
    }
  });
  root
    .querySelectorAll<HTMLElement>(
      '[data-testid="images-drop-down-button"] [data-testid="dropdown-expand"], [data-testid="images"] + [data-testid="dropdown-expand"]',
    )
    .forEach((indicator) => {
      indicator.hidden = true;
      indicator.setAttribute("aria-hidden", "true");
    });
}

/** Ketcher 将周期表网格设为 fixed，导致镧系、锕系两行不计入弹窗高度而溢出。 */
function normalizeKetcherPeriodicTableLayout(root: ParentNode): void {
  root
    .querySelectorAll<HTMLElement>('[class*="PeriodTable-module_elementsTable"]')
    .forEach((dialog) => {
      dialog.style.height = "auto";
    });
  root
    .querySelectorAll<HTMLElement>('[class*="PeriodTable-module_periodTable"]')
    .forEach((table) => {
      table.style.position = "relative";
    });
  root.querySelectorAll<HTMLElement>('[class*="ElementsTable-module_button"]').forEach((button) => {
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.padding = "0";
    button.style.lineHeight = "1";
  });
}

// Ketcher asynchronously creates and destroys its own React roots. Strict Mode's
// effect replay can publish an editor that its deferred cleanup already removed.
// Keep the third-party lifecycle in a dedicated root; the surrounding application
// retains Strict Mode, error handling and normal session disposal.
function KetcherRuntimeHost({
  Editor,
  onRuntimeError,
  staticResourcesUrl,
  structServiceProvider,
  disableMacromoleculesEditor,
  buttons,
  onInit,
  errorHandler,
}: KetcherReactEditorProps & {
  Editor: KetcherRuntime["Editor"];
  onRuntimeError(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let root: ReturnType<typeof createRoot> | undefined;
    queueMicrotask(() => {
      if (cancelled || !hostRef.current) return;
      root = createRoot(hostRef.current);
      root.render(
        <KetcherRuntimeBoundary onError={onRuntimeError}>
          <Editor
            staticResourcesUrl={staticResourcesUrl}
            structServiceProvider={structServiceProvider}
            {...(disableMacromoleculesEditor === undefined ? {} : { disableMacromoleculesEditor })}
            {...(buttons === undefined ? {} : { buttons })}
            {...(onInit === undefined ? {} : { onInit })}
            errorHandler={errorHandler}
          />
        </KetcherRuntimeBoundary>,
      );
    });
    return () => {
      cancelled = true;
      // Avoid unmounting another root during the parent's React commit.
      queueMicrotask(() => root?.unmount());
    };
  }, [
    Editor,
    staticResourcesUrl,
    structServiceProvider,
    disableMacromoleculesEditor,
    buttons,
    onInit,
    errorHandler,
    onRuntimeError,
  ]);
  return <div ref={hostRef} className="ketcher-runtime-host" />;
}

function localResourcesUrl(): string {
  return new URL(".", window.location.href).href;
}

function clipboardCommand(target: EventTarget | null): "paste" | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest<HTMLElement>("button, [role='button']");
  const label = control?.getAttribute("title") ?? control?.getAttribute("aria-label") ?? "";
  if (/^(?:Paste|粘贴)(?:\s|（|\(|$)/u.test(label)) return "paste";
  return null;
}

export async function loadKetcherRuntime(_attempt = 0): Promise<KetcherRuntime> {
  const [reactRuntime, standaloneRuntime] = await Promise.all([
    import("ketcher-react"),
    import("ketcher-standalone"),
    import("ketcher-react/dist/index.css"),
  ]);
  return {
    Editor: reactRuntime.Editor as unknown as ComponentType<KetcherReactEditorProps>,
    StandaloneStructServiceProvider: standaloneRuntime.StandaloneStructServiceProvider,
  };
}

export function KetcherEditor({
  initialKet,
  initialMode = "molecule",
  onReady,
  onContentChange,
  onError,
  loadRuntime = loadKetcherRuntime,
}: KetcherEditorProps) {
  const adapterRef = useRef<KetcherAdapter | null>(null);
  const activeKetcherRef = useRef<Ketcher | null>(null);
  const pendingKetcherRef = useRef<Ketcher | null>(null);
  const initializationScheduledRef = useRef(false);
  const initializationGenerationRef = useRef(0);
  const callbacksRef = useRef({ onReady, onError, onContentChange });
  callbacksRef.current = { onReady, onError, onContentChange };
  const contentCleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const readyRef = useRef(false);
  const shellRef = useRef<HTMLElement | null>(null);
  const [runtime, setRuntime] = useState<KetcherRuntime | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [operationError, setOperationError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [hasInitialised, setHasInitialised] = useState(false);
  const [showDrawingGuide, setShowDrawingGuide] = useState(true);
  const [activeToolHint, setActiveToolHint] = useState<string | null>(null);
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false);

  useEffect(() => {
    const shell = shellRef.current;
    if (!runtime || !shell) return;
    const syncTrayAccess = () => {
      shell
        .querySelectorAll<HTMLElement>(".ketcher-toolbar-extras, .ketcher-right-toolbar-extras")
        .forEach((tray) => {
          tray.inert = !advancedToolsOpen;
          tray.setAttribute("aria-hidden", String(!advancedToolsOpen));
        });
    };
    syncTrayAccess();
    const observer = new MutationObserver(syncTrayAccess);
    observer.observe(shell, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [runtime, advancedToolsOpen]);

  const releaseAdapter = useCallback(() => {
    contentCleanupRef.current?.();
    contentCleanupRef.current = null;
    readyRef.current = false;
    initializationGenerationRef.current += 1;
    initializationScheduledRef.current = false;
    pendingKetcherRef.current = null;
    try {
      // ketcher-standalone 的 Indigo Worker 是模块级单例。销毁后，同一页面内
      // 后续重新打开结构编辑器只会复用已终止的 Worker，所有请求都会永久挂起。
      adapterRef.current?.dispose({ destroyService: false });
    } catch {
      // 静默 swallow —— 二次 dispose 时 structService 可能已经无效
    }
    adapterRef.current = null;
    activeKetcherRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRuntime(null);
    setLoadError(false);
    setOperationError(false);
    setHasInitialised(false);
    void withStructureTimeout(loadRuntime(retryKey))
      .then((value) => {
        if (!cancelled && mountedRef.current) setRuntime(value);
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        releaseAdapter();
        setLoadError(true);
        callbacksRef.current.onError?.({ code: "KETCHER_RUNTIME_LOAD_FAILED" });
      });
    return () => {
      cancelled = true;
    };
  }, [loadRuntime, releaseAdapter, retryKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseAdapter();
    };
  }, [releaseAdapter]);

  useEffect(() => {
    if (!runtime) return;
    const shell = shellRef.current;
    if (!shell) return;
    const hideFileControls = () => {
      shell.querySelectorAll<HTMLElement>(FILE_CONTROL_SELECTOR).forEach((control) => {
        control.hidden = true;
      });
      const visited = new Set<ParentNode>();
      localizeKetcherControls(shell, visited);
      for (const root of visited) {
        if (root instanceof ShadowRoot)
          observer.observe(root, { childList: true, subtree: true, characterData: true });
      }
      normalizeKetcherToolbarSizing(shell);
      simplifyImageToolIcon(shell);
      normalizeKetcherPeriodicTableLayout(shell);
    };
    const observer = new MutationObserver(hideFileControls);
    hideFileControls();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-controls", "aria-owns", "aria-describedby", "value"],
    });
    return () => observer.disconnect();
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return;
    const shell = shellRef.current;
    if (!shell) return;

    /** 让目标容器真正可滚（右侧工具栏容器高度未约束时 scrollTop 赋值无效）。 */
    const ensureScrollable = (container: HTMLElement) => {
      if (container.scrollHeight <= container.clientHeight) {
        container.style.maxHeight = "100%";
      }
    };

    /** 单击步长：一次滚动约 80% 可视高度，远超原按钮组高度。 */
    const scrollStep = (container: HTMLElement) =>
      Math.max(Math.round(container.clientHeight * 0.8), 80);

    /**
     * 单击滚动动画：duration 毫秒内从当前 scrollTop 平滑过渡到目标位置，
     * easeOutCubic 缓动（先快后慢）。CSS 中已用 scroll-behavior:auto 关闭
     * 浏览器原生平滑，避免两套滚动动画互相干扰。
     */
    let animationFrame = 0;
    const animateScrollStep = (container: HTMLElement, direction: number, duration = 1000) => {
      cancelAnimationFrame(animationFrame);
      const from = container.scrollTop;
      const to = from + direction * scrollStep(container);
      let startedAt: number | null = null;
      const tick = (now: number) => {
        startedAt ??= now;
        const progress = Math.min((now - startedAt) / duration, 1);
        const eased = 1 - (1 - progress) ** 3;
        container.scrollTop = from + (to - from) * eased;
        if (progress < 1) animationFrame = requestAnimationFrame(tick);
      };
      animationFrame = requestAnimationFrame(tick);
    };

    const resolveArrowTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const button = target.closest<HTMLElement>(TOOLBAR_ARROW_SELECTOR);
      if (!button) return null;
      const container = findToolbarScrollContainer(shell, button);
      if (!container) return null;
      ensureScrollable(container);
      return { container, direction: button.dataset.testid === ARROW_UP_TESTID ? -1 : 1 };
    };

    const handleArrowMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = resolveArrowTarget(event.target);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const { container, direction } = target;

      // 单击（快速松开）：1 秒平滑动画滚一步；
      // 按住超过 300ms：切换为快速连续滚动，直到松开或失焦。
      let holding = false;
      let released = false;
      const holdTimer = window.setTimeout(() => {
        holding = true;
        window.removeEventListener("mouseup", releaseAsClick);
        window.removeEventListener("blur", releaseAsClick);
        container.scrollTop += direction * scrollStep(container);
        const interval = window.setInterval(() => {
          container.scrollTop += direction * scrollStep(container);
        }, 80);
        const stopHolding = () => {
          window.clearInterval(interval);
          window.removeEventListener("mouseup", stopHolding);
          window.removeEventListener("blur", stopHolding);
        };
        window.addEventListener("mouseup", stopHolding);
        window.addEventListener("blur", stopHolding);
      }, 300);

      const releaseAsClick = () => {
        if (released || holding) return;
        released = true;
        window.clearTimeout(holdTimer);
        animateScrollStep(container, direction, 1000);
      };
      window.addEventListener("mouseup", releaseAsClick);
      window.addEventListener("blur", releaseAsClick);
    };

    // Ketcher 自己的 onClick 也会滚动（点击一次 += 一个按钮组高度），
    // 捕获阶段拦截避免与上面的滚动动画叠加。
    const handleArrowClick = (event: Event) => {
      if (!resolveArrowTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    shell.addEventListener("mousedown", handleArrowMouseDown, true);
    shell.addEventListener("click", handleArrowClick, true);
    return () => {
      cancelAnimationFrame(animationFrame);
      shell.removeEventListener("mousedown", handleArrowMouseDown, true);
      shell.removeEventListener("click", handleArrowClick, true);
    };
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return;
    const shell = shellRef.current;
    if (!shell) return;

    /** 底部横向托盘：装下从左侧列移过来的按钮（"反应加号"及以下）。 */
    const ensureToolbarExtrasTray = (bottom: Element): HTMLElement => {
      const existing = bottom.querySelector<HTMLElement>(".ketcher-toolbar-extras");
      if (existing) return existing;
      const tray = document.createElement("div");
      tray.className = "ketcher-toolbar-extras";
      return tray;
    };

    /** 右侧列底部会被 ▲▼ 翻页隐藏的两个原子工具，改为底部横向显示。 */
    const ensureRightToolbarExtrasTray = (bottom: Element): HTMLElement => {
      const existing = bottom.querySelector<HTMLElement>(".ketcher-right-toolbar-extras");
      if (existing) return existing;
      const tray = document.createElement("div");
      tray.className = "ketcher-right-toolbar-extras";
      return tray;
    };

    /**
     * 把左侧工具栏中"反应加号"及以下的按钮移入底部托盘，并保持托盘位于
     * 底部工具栏 Group 的最前面（环模板右移让位）。幂等：按钮移走后原位
     * 不再匹配；若 Ketcher 重渲染重建了按钮（原位出现新的），替换托盘里
     * 同 testid 的旧节点，避免重复。
     */
    const settleToolbarLayout = () => {
      if (!shell.isConnected) return;
      const buttons = shell.querySelector<HTMLElement>('[data-testid="left-toolbar-buttons"]');
      const bottom = shell.querySelector<HTMLElement>('[data-testid="bottom-toolbar"]');
      if (!bottom) return;
      const group = bottom.firstElementChild;
      let tray: HTMLElement | null = null;
      if (buttons) {
        tray = ensureToolbarExtrasTray(bottom);
        const matched = Array.from(buttons.querySelectorAll<HTMLElement>("[data-testid]")).filter(
          (element) => isExtraToolTestId(element.dataset.testid),
        );
        const topLevel = matched.filter(
          (element) => !matched.some((other) => other !== element && other.contains(element)),
        );
        for (const element of topLevel) {
          const testId = element.dataset.testid ?? "";
          const stale = Array.from(tray.children).find(
            (child) => (child as HTMLElement).dataset.testid === testId,
          );
          if (stale) stale.remove();
          tray.appendChild(element);
        }
        if (group && tray.parentElement !== group) {
          group.insertBefore(tray, group.firstChild);
        }
      }

      let templateSection = Array.from(group?.children ?? []).find((child) =>
        child.classList.contains("ketcher-template-toolbar"),
      );
      const templateItems = Array.from(group?.children ?? []).filter(
        (child) =>
          child !== templateSection &&
          (child.matches('[data-testid^="template-"]') ||
            child.querySelector('[data-testid^="template-"]')),
      );
      const firstTemplateItem = templateItems[0];
      if (!templateSection && group && firstTemplateItem) {
        templateSection = document.createElement("div");
        templateSection.className = "ketcher-template-toolbar";
        group.insertBefore(templateSection, firstTemplateItem);
      }
      if (templateSection) {
        for (const templateItem of templateItems) {
          templateSection.appendChild(templateItem);
        }
      }

      const rightToolbar = shell.querySelector<HTMLElement>('[data-testid="right-toolbar"]');
      if (!rightToolbar) return;
      const rightTray = ensureRightToolbarExtrasTray(bottom);
      const rightTools = Array.from(
        rightToolbar.querySelectorAll<HTMLElement>("[data-testid]"),
      ).filter((element) => RIGHT_TOOLBAR_EXTRA_TESTIDS.has(element.dataset.testid ?? ""));
      const topLevelRightTools = rightTools.filter(
        (element) => !rightTools.some((other) => other !== element && other.contains(element)),
      );
      for (const element of topLevelRightTools) {
        const testId = element.dataset.testid ?? "";
        const stale = Array.from(rightTray.children).find(
          (child) => (child as HTMLElement).dataset.testid === testId,
        );
        if (stale) stale.remove();
        rightTray.appendChild(element);
      }
      if (group && rightTray.parentElement !== group) {
        group.insertBefore(rightTray, tray?.nextSibling ?? group.firstChild);
      }
      rightToolbar.querySelectorAll<HTMLElement>(RIGHT_TOOLBAR_ARROW_SELECTOR).forEach((arrow) => {
        arrow.hidden = true;
      });
    };

    // 工具栏在 Ketcher 异步初始化后才渲染，先用 observer 捕捉首次出现，
    // 之后 Ketcher 任何重渲染导致的按钮复位都会被重新搬回托盘。
    settleToolbarLayout();
    const observer = new MutationObserver(settleToolbarLayout);
    observer.observe(shell, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [runtime]);

  const handleInit = useCallback(
    (ketcher: Ketcher) => {
      if (adapterRef.current && activeKetcherRef.current === ketcher) return;
      if (adapterRef.current) releaseAdapter();
      pendingKetcherRef.current = ketcher;
      if (initializationScheduledRef.current) return;
      initializationScheduledRef.current = true;
      const generation = initializationGenerationRef.current;
      queueMicrotask(() => {
        if (generation !== initializationGenerationRef.current) return;
        initializationScheduledRef.current = false;
        const latestKetcher = pendingKetcherRef.current;
        pendingKetcherRef.current = null;
        if (!mountedRef.current || adapterRef.current || !latestKetcher) return;
        const adapter = createKetcherAdapter(latestKetcher as KetcherPublicApi);
        adapterRef.current = adapter;
        activeKetcherRef.current = latestKetcher;
        void (async () => {
          if (initialKet) {
            const restored = await adapter.loadKet(initialKet, initialMode);
            if (!mountedRef.current || adapterRef.current !== adapter) return;
            if (!restored.ok) {
              releaseAdapter();
              setLoadError(true);
              callbacksRef.current.onError?.(restored.error);
              return;
            }
          }
          if (!mountedRef.current || adapterRef.current !== adapter) return;
          if (callbacksRef.current.onContentChange) {
            const initial = await adapter.readContent();
            if (!mountedRef.current || adapterRef.current !== adapter) return;
            if (!initial.ok) {
              releaseAdapter();
              setLoadError(true);
              callbacksRef.current.onError?.(initial.error);
              return;
            }
            const baseline = initial.value.ket;
            callbacksRef.current.onContentChange({
              hasContent: initial.value.hasContent,
              dirty: false,
            });
            let revision = 0;
            let reading = false;
            let cancelled = false;
            let timer = 0;
            const refresh = async () => {
              if (reading || cancelled) return;
              reading = true;
              let observed: number;
              do {
                observed = revision;
                const content = await adapter.readContent();
                if (cancelled || adapterRef.current !== adapter) break;
                if (observed !== revision) continue;
                if (content.ok)
                  callbacksRef.current.onContentChange?.({
                    hasContent: content.value.hasContent,
                    dirty: content.value.ket !== baseline,
                  });
                else setOperationError(true);
              } while (!cancelled && observed !== revision);
              reading = false;
            };
            const editor = latestKetcher.editor;
            const subscription = editor?.subscribe?.("change", () => {
              revision += 1;
              window.clearTimeout(timer);
              timer = window.setTimeout(() => void refresh(), 120);
            });
            contentCleanupRef.current = () => {
              cancelled = true;
              window.clearTimeout(timer);
              if (subscription) editor.unsubscribe("change", subscription);
            };
          }
          readyRef.current = true;
          setHasInitialised(true);
          callbacksRef.current.onReady?.(adapter);
        })();
      });
    },
    [initialKet, initialMode, releaseAdapter],
  );

  const provider = useMemo(
    () => (runtime ? new runtime.StandaloneStructServiceProvider() : null),
    [runtime],
  );

  const handleRuntimeError = useCallback(() => {
    releaseAdapter();
    setLoadError(true);
    callbacksRef.current.onError?.({ code: "KETCHER_RUNTIME_LOAD_FAILED" });
  }, [releaseAdapter]);

  const handleOperationError = useCallback(() => {
    if (readyRef.current && adapterRef.current) {
      setOperationError(true);
      return;
    }
    handleRuntimeError();
  }, [handleRuntimeError]);

  useEffect(() => {
    if (!runtime || hasInitialised || loadError) return;
    const timeout = window.setTimeout(() => handleRuntimeError(), 30_000);
    return () => window.clearTimeout(timeout);
  }, [handleRuntimeError, hasInitialised, loadError, runtime]);

  if (loadError) {
    return (
      <section className="ketcher-editor-state" role="alert">
        <p>结构编辑器未能加载。请重试。</p>
        <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
          重试
        </button>
      </section>
    );
  }

  if (!runtime || !provider) {
    return <p className="ketcher-editor-state">正在加载结构编辑器…</p>;
  }

  const Editor = runtime.Editor;
  return (
    <section
      ref={shellRef}
      className={`ketcher-editor-shell${advancedToolsOpen ? " is-advanced-tools-open" : ""}`}
      aria-label="化学结构编辑器"
      onPointerDownCapture={(event) => {
        setShowDrawingGuide(false);
        if (
          event.target instanceof Element &&
          !event.target.closest(
            ".ketcher-toolbar-extras, .ketcher-right-toolbar-extras, .ketcher-more-tools-button",
          )
        )
          setAdvancedToolsOpen(false);
        const target =
          event.target instanceof Element ? event.target.closest<HTMLElement>("[title]") : null;
        const label =
          target?.getAttribute("title") ??
          (event.target instanceof Element
            ? event.target.closest("button")?.getAttribute("aria-label")
            : null);
        if (label) setActiveToolHint(`当前工具：${label}。按 Esc 可结束当前绘制。`);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setAdvancedToolsOpen(false);
      }}
      onClickCapture={(event) => {
        const command = clipboardCommand(event.target);
        if (!command) return;
        // Ketcher calls document.execCommand('paste') for its toolbar action.
        // Chromium blocks that API in Electron even after a user click, so send
        // the same clipboard event its keyboard path consumes instead.  Copy
        // deliberately remains native: Ketcher needs its original user gesture.
        event.preventDefault();
        event.stopPropagation();
        (event.target as Element).dispatchEvent(
          new Event(command, { bubbles: true, cancelable: true }),
        );
      }}
      onKeyDownCapture={() => setShowDrawingGuide(false)}
    >
      <SpatialPresence>
        {operationError ? (
          <p className="ketcher-editor-tool-hint ketcher-editor-operation-error" role="alert">
            此操作未完成，画布已保留。请尝试其他操作。
            <button type="button" onClick={() => setOperationError(false)}>
              关闭提示
            </button>
          </p>
        ) : null}
      </SpatialPresence>
      <SpatialPresence>
        {showDrawingGuide ? (
          <p className="ketcher-editor-guide" role="status">
            选择工具或模板，在画布中编辑结构。
          </p>
        ) : null}
      </SpatialPresence>
      <SpatialPresence>
        {activeToolHint && !operationError ? (
          <p className="ketcher-editor-tool-hint" role="status">
            {activeToolHint}
          </p>
        ) : null}
      </SpatialPresence>
      <button
        type="button"
        className="ketcher-more-tools-button"
        aria-expanded={advancedToolsOpen}
        onClick={() => setAdvancedToolsOpen((value) => !value)}
      >
        更多工具
      </button>
      <KetcherRuntimeHost
        Editor={Editor}
        onRuntimeError={handleRuntimeError}
        staticResourcesUrl={localResourcesUrl()}
        structServiceProvider={provider}
        buttons={OFFLINE_BUTTONS}
        // 普通结构式不应等待高分子编辑器完成初始化。Ketcher 的外层
        // onInit 默认要求两个编辑器均就绪；高分子会话才保留该路径。
        disableMacromoleculesEditor={initialMode === "molecule"}
        onInit={handleInit}
        errorHandler={handleOperationError}
      />
    </section>
  );
}
