import katex from "katex";
import type {
  VirtualKeyboardInterface,
  VirtualKeyboardLayout,
  VirtualKeyboardName,
} from "mathlive";
import {
  type CSSProperties,
  createElement,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { InlineFormulaNodeSchema } from "../../../../shared/document/model";
import { MotionPresence, useMotionPresenceClosing } from "../../app/motion-presence";
import { DialogCloseIcon } from "../../shared/dialog-close-icon";
import { showApplicationError } from "../../shared/error-dialog";
import { FigureDrawingActions } from "../../shared/figure-drawing-actions";
import { OperationFeedbackOverlay } from "../../shared/operation-feedback";
import { SpatialPresence } from "../../shared/spatial-presence";
import { useRetainedTransientVisibility } from "../../shared/transient-function-rail-slot";
import { useDialogDrag } from "../../shared/use-dialog-drag";
import { useModalDialog } from "../../shared/use-modal-dialog";
import { useEditorSessionVisible } from "../../shared/editor-session-scope";
import type { FormulaMode } from "../nodes/formula-node";
import { FormulaPositionSwitch } from "./formula-position-switch";

type MathFieldElement = HTMLElement & {
  value: string;
  executeCommand?(command: unknown): void;
  menuItems: readonly { id?: string; type?: string }[];
};

type FormulaDialogProps = {
  open?: boolean;
  displayMode?: "modal" | "modeless";
  positionKey?: string;
  initialLatex: string;
  initialMode: FormulaMode;
  allowModeChange: boolean;
  drawingsOnly?: boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: retain existing void callbacks; strings report recoverable save errors.
  onConfirm(value: { latex: string; mode: FormulaMode }): void | string;
  onCancel(): void;
  onInsertToDrawings?(latex: string): void | Promise<void>;
  onReplaceToDrawings?(latex: string): void | Promise<void>;
};

const SYMBOLS = [
  ["分数", String.raw`\frac{#0}{#?}`, String.raw`\frac{\square}{\square}`],
  ["平方根", String.raw`\sqrt{#0}`, String.raw`\sqrt{\square}`],
  ["上下标", "#0_{#?}^{#?}", String.raw`\square_{\square}^{\square}`],
  ["求和", String.raw`\sum_{#0}^{#?}`, String.raw`\displaystyle\sum_{\square}^{\square}`],
  ["函数", "", "f(x)"],
  ["三角函数", "", String.raw`\sin(\square)`],
  ["积分", String.raw`\int_{#0}^{#?}`, String.raw`\displaystyle\int_{\square}^{\square}`],
  ["括号", String.raw`\left(#0\right)`, String.raw`\left(\square\right)`],
  [
    "矩阵",
    String.raw`\begin{bmatrix}#0&#?\\#?&#?\end{bmatrix}`,
    String.raw`\begin{bmatrix}\square&\square\\\square&\square\end{bmatrix}`,
  ],
] as const;

const FRACTION_VARIANTS = [
  {
    heading: null,
    items: [
      ["标准分数", String.raw`\frac{#0}{#?}`, String.raw`\frac{\square}{\square}`],
      ["显示分数", String.raw`\dfrac{#0}{#?}`, String.raw`\dfrac{\square}{\square}`],
      ["文本分数", String.raw`\tfrac{#0}{#?}`, String.raw`\tfrac{\square}{\square}`],
      ["含系数", String.raw`#0\frac{#0}{#?}`, String.raw`a\,\frac{\square}{\square}`],
      ["斜线分数", "#0\\mathbin{/}#?", "a\\mathbin{/}b"],
      ["二项式系数", String.raw`\binom{#0}{#?}`, String.raw`\binom{n}{k}`],
    ],
  },
] as const;

const ROOT_VARIANTS = [
  {
    heading: null,
    items: [
      ["平方根", String.raw`\sqrt{#0}`, String.raw`\sqrt{\square}`],
      ["n 次方根", String.raw`\sqrt[#0]{#?}`, String.raw`\sqrt[n]{\square}`],
      ["立方根", String.raw`\sqrt[3]{#?}`, String.raw`\sqrt[3]{\square}`],
      ["四次方根", String.raw`\sqrt[4]{#?}`, String.raw`\sqrt[4]{\square}`],
    ],
  },
] as const;

const INTEGRAL_VARIANTS = [
  {
    heading: null,
    items: [
      [
        "定积分",
        String.raw`\int_{#0}^{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\int_{a}^{b} f(x)\,\mathrm{d}x`,
      ],
      [
        "不定积分",
        String.raw`\int #?\,\mathrm{d}#?`,
        String.raw`\displaystyle\int f(x)\,\mathrm{d}x`,
      ],
      [
        "二重积分",
        String.raw`\iint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\iint_D f\,\mathrm{d}A`,
      ],
      [
        "三重积分",
        String.raw`\iiint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\iiint_V f\,\mathrm{d}V`,
      ],
      [
        "曲线积分",
        String.raw`\oint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\oint_C f\,\mathrm{d}s`,
      ],
      [
        "面积分",
        String.raw`\oiint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\oiint_S \mathbf{F}\cdot\mathrm{d}\mathbf{S}`,
      ],
    ],
  },
] as const;

const BRACKET_VARIANTS = [
  {
    heading: null,
    items: [
      ["圆括号", String.raw`\left(#0\right)`, String.raw`\left(\square\right)`],
      ["方括号", String.raw`\left[#0\right]`, String.raw`\left[\square\right]`],
      ["大括号", String.raw`\left\{#0\right\}`, String.raw`\left\{\square\right\}`],
      ["绝对值", String.raw`\left|#0\right|`, String.raw`\left|x\right|`],
      ["范数", String.raw`\lVert#0\rVert`, String.raw`\lVert x\rVert`],
      [
        "向下取整",
        String.raw`\left\lfloor#0\right\rfloor`,
        String.raw`\left\lfloor x\right\rfloor`,
      ],
      ["向上取整", String.raw`\left\lceil#0\right\rceil`, String.raw`\left\lceil x\right\rceil`],
      ["角括号", String.raw`\langle#0\rangle`, String.raw`\langle x\rangle`],
      ["左大括号", String.raw`\left\{#0\right.`, String.raw`\left\{x\right.`],
      [
        "分段函数",
        String.raw`\begin{cases}#0 &\text{if }#?\\#? &\text{otherwise}\end{cases}`,
        String.raw`f(x)=\begin{cases}x&\text{if }x\ge 0\\0&\text{otherwise}\end{cases}`,
      ],
    ],
  },
] as const;

const SCRIPT_VARIANTS = [
  {
    heading: null,
    items: [
      ["上标", "#0^{#?}", String.raw`x^{\square}`],
      ["下标", "#0_{#?}", String.raw`x_{\square}`],
      ["上下标", "#0_{#?}^{#?}", String.raw`x_{\square}^{\square}`],
      ["左下标", "_{#?}#0", String.raw`_{\square}x`],
      ["左上标", "^{#?}#0", String.raw`^{\square}x`],
      ["一阶导数", String.raw`#0^{\prime}`, String.raw`f^{\prime}`],
      ["二阶导数", String.raw`#0^{\prime\prime}`, String.raw`f^{\prime\prime}`],
    ],
  },
] as const;

const FUNCTION_VARIANTS = [
  {
    heading: null,
    items: [
      ["函数 f(x)", "f(#?)", "f(x)"],
      ["函数 g(x)", "g(#?)", "g(x)"],
      ["通用函数", "#0(#?)", String.raw`F(\square)`],
      ["反函数", "#0^{-1}(#?)", "f^{-1}(x)"],
      ["复合函数", "#0\\circ#1(#?)", String.raw`f\circ g(x)`],
      ["命名函数", String.raw`\operatorname{#0}(#?)`, String.raw`\operatorname{Res}(x)`],
    ],
  },
] as const;

const FORMULA_CONTEXT_MENU_HIDDEN_IDS = new Set([
  "variant",
  "color",
  "background-color",
  "cut",
  "copy",
  "paste",
  "select-all",
]);

const COMMON_SYMBOLS_KEYBOARD_LAYOUT: VirtualKeyboardLayout = {
  id: "patent-common-symbols",
  label: "≠∈→",
  tooltip: "常用数学符号",
  layers: [
    {
      id: "patent-common-symbols-layer",
      rows: [
        [
          "<",
          ">",
          String.raw`\le`,
          String.raw`\ge`,
          String.raw`\ne`,
          String.raw`\approx`,
          String.raw`\equiv`,
          String.raw`\propto`,
          String.raw`\sim`,
          "[backspace]",
        ],
        [
          String.raw`\in`,
          String.raw`\notin`,
          String.raw`\subset`,
          String.raw`\subseteq`,
          String.raw`\cup`,
          String.raw`\cap`,
          String.raw`\varnothing`,
          String.raw`\forall`,
          String.raw`\exists`,
          String.raw`\neg`,
        ],
        [
          String.raw`\leftarrow`,
          String.raw`\to`,
          String.raw`\leftrightarrow`,
          String.raw`\Leftarrow`,
          String.raw`\Rightarrow`,
          String.raw`\Leftrightarrow`,
          String.raw`\mapsto`,
          String.raw`\uparrow`,
          String.raw`\downarrow`,
          "[return]",
        ],
        [
          String.raw`\partial`,
          String.raw`\nabla`,
          String.raw`\infty`,
          String.raw`\int`,
          String.raw`\iint`,
          String.raw`\oint`,
          String.raw`\sum`,
          String.raw`\prod`,
          "[left]",
          "[right]",
          "[action]",
        ],
      ],
    },
  ],
};

const FORMULA_KEYBOARD_LAYOUTS: readonly (VirtualKeyboardName | VirtualKeyboardLayout)[] = [
  "numeric",
  COMMON_SYMBOLS_KEYBOARD_LAYOUT,
  "symbols",
  "alphabetic",
  "greek",
];

const FORMULA_KEYBOARD_GAP = 12;

function filterFormulaContextMenu(menuItems: readonly { id?: string; type?: string }[]) {
  return menuItems.filter((item) => !item.id || !FORMULA_CONTEXT_MENU_HIDDEN_IDS.has(item.id));
}

export function configureFormulaVirtualKeyboard(keyboard: VirtualKeyboardInterface): void {
  keyboard.layouts = FORMULA_KEYBOARD_LAYOUTS;
}

export function getFormulaKeyboardLayerId(
  keyboard: VirtualKeyboardInterface,
  layoutName: VirtualKeyboardName,
): string | null {
  const layoutIndex = keyboard.layouts.indexOf(layoutName);
  if (layoutIndex < 0) return null;
  return keyboard.normalizedLayouts[layoutIndex]?.layers[0]?.id ?? null;
}

const FORMULA_LIBRARY_GROUPS = [
  {
    heading: null,
    items: [
      ["绝对值", String.raw`\left|#?\right|`, String.raw`\left|x\right|`],
      ["n 次根", String.raw`\sqrt[#?]{#?}`, String.raw`\sqrt[n]{x}`],
      ["以 a 为底的对数", String.raw`\log_{#?}{#?}`, String.raw`\log_a(x)`],
    ],
  },
  {
    heading: "微积分",
    items: [
      ["极限", String.raw`\lim_{#0\to#?}`, String.raw`\displaystyle\lim_{\square\to\square}`],
      [
        "导数",
        String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}#?\bigm|_{x=#?}`,
        String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}f(x)\bigm|_{x=a}`,
      ],
      [
        "n 阶导数",
        String.raw`\dfrac{\mathrm{d}^#?}{\mathrm{d}x^#?}#?\bigm|_{x=#?}`,
        String.raw`\dfrac{\mathrm{d}^n}{\mathrm{d}x^n}f(x)\bigm|_{x=a}`,
      ],
      [
        "积分",
        String.raw`\int_#?^#?#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\int_a^b f(x)\,\mathrm{d}x`,
      ],
      ["求和", String.raw`\sum_#?^#?#?`, String.raw`\displaystyle\sum_{i=1}^n x_i`],
      ["乘积", String.raw`\prod_#?^#?#?`, String.raw`\displaystyle\prod_{i=1}^n x_i`],
    ],
  },
  {
    heading: "复数",
    items: [
      ["模", String.raw`\lvert#?\rvert`, String.raw`\lvert z\rvert`],
      ["辐角", String.raw`\arg(#?)`, String.raw`\arg(z)`],
      ["实部", String.raw`\Re(#?)`, String.raw`\Re(z)`],
      ["虚部", String.raw`\Im(#?)`, String.raw`\Im(z)`],
      ["共轭", String.raw`\overline{#?}`, String.raw`\overline z`],
    ],
  },
  {
    heading: "关系与比较",
    items: [
      ["小于等于", "#?\\le#?", "x\\le y"],
      ["大于等于", "#?\\ge#?", "x\\ge y"],
      ["不等于", "#?\\ne#?", "x\\ne y"],
      ["约等于", "#?\\approx#?", "x\\approx y"],
      ["恒等于", "#?\\equiv#?", "x\\equiv y"],
      ["正比于", "#?\\propto#?", "x\\propto y"],
      ["相似于", "#?\\sim#?", "x\\sim y"],
    ],
  },
  {
    heading: "集合与逻辑",
    items: [
      ["属于", "#?\\in#?", "x\\in A"],
      ["不属于", "#?\\notin#?", "x\\notin A"],
      ["真包含", "#?\\subset#?", "A\\subset B"],
      ["包含或等于", "#?\\subseteq#?", "A\\subseteq B"],
      ["交集", "#?\\cap#?", "A\\cap B"],
      ["并集", "#?\\cup#?", "A\\cup B"],
      ["空集", String.raw`\varnothing`, String.raw`\varnothing`],
      ["任意", String.raw`\forall #?`, String.raw`\forall x`],
      ["存在", String.raw`\exists #?`, String.raw`\exists x`],
      ["逻辑与", "#?\\land#?", "P\\land Q"],
      ["逻辑或", "#?\\lor#?", "P\\lor Q"],
      ["逻辑非", String.raw`\neg #?`, String.raw`\neg P`],
      ["推出", "#?\\Rightarrow#?", "P\\Rightarrow Q"],
      ["逻辑等价", "#?\\Leftrightarrow#?", "P\\Leftrightarrow Q"],
    ],
  },
  {
    heading: "箭头与映射",
    items: [
      ["右箭头", "#?\\to#?", "x\\to y"],
      ["左箭头", "#?\\leftarrow#?", "x\\leftarrow y"],
      ["双向箭头", "#?\\leftrightarrow#?", "x\\leftrightarrow y"],
      ["右双线箭头", "#?\\Rightarrow#?", "x\\Rightarrow y"],
      ["左双线箭头", "#?\\Leftarrow#?", "x\\Leftarrow y"],
      ["双线双向箭头", "#?\\Leftrightarrow#?", "x\\Leftrightarrow y"],
      ["映射箭头", "#?\\mapsto#?", "x\\mapsto y"],
      ["长右箭头", "#?\\longrightarrow#?", "x\\longrightarrow y"],
      ["上箭头", String.raw`\uparrow`, String.raw`\uparrow`],
      ["下箭头", String.raw`\downarrow`, String.raw`\downarrow`],
    ],
  },
  {
    heading: "高级微积分",
    items: [
      [
        "偏导数",
        String.raw`\frac{\partial #?}{\partial #?}`,
        String.raw`\frac{\partial f}{\partial x}`,
      ],
      [
        "二阶偏导数",
        String.raw`\frac{\partial^2 #?}{\partial #?^2}`,
        String.raw`\frac{\partial^2 f}{\partial x^2}`,
      ],
      [
        "二重积分",
        String.raw`\iint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\iint_D f\,\mathrm{d}A`,
      ],
      [
        "三重积分",
        String.raw`\iiint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\iiint_V f\,\mathrm{d}V`,
      ],
      [
        "曲线积分",
        String.raw`\oint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\oint_C f\,\mathrm{d}s`,
      ],
      ["梯度", String.raw`\nabla #?`, String.raw`\nabla f`],
      ["散度", String.raw`\nabla\cdot #?`, String.raw`\nabla\cdot \mathbf{F}`],
      ["旋度", String.raw`\nabla\times #?`, String.raw`\nabla\times \mathbf{F}`],
      ["拉普拉斯算子", String.raw`\nabla^2 #?`, String.raw`\nabla^2 f`],
      [
        "无穷极限",
        String.raw`\lim_{#?\to\infty}#?`,
        String.raw`\displaystyle\lim_{x\to\infty}f(x)`,
      ],
      [
        "面积分",
        String.raw`\oiint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\oiint_S \mathbf{F}\cdot\mathrm{d}\mathbf{S}`,
      ],
      [
        "体积分",
        String.raw`\oiiint_{#?}#?\,\mathrm{d}#?`,
        String.raw`\displaystyle\oiiint_V f\,\mathrm{d}V`,
      ],
      ["大并集", String.raw`\bigcup_{#?}^{#?}#?`, String.raw`\displaystyle\bigcup_{i=1}^{n}A_i`],
      ["大交集", String.raw`\bigcap_{#?}^{#?}#?`, String.raw`\displaystyle\bigcap_{i=1}^{n}A_i`],
      ["余积", String.raw`\coprod_{#?}^{#?}#?`, String.raw`\displaystyle\coprod_{i=1}^{n}x_i`],
    ],
  },
  {
    heading: "常用函数",
    items: [
      ["自然对数 ln", String.raw`\ln(#?)`, String.raw`\ln(x)`],
      ["常用对数 lg", String.raw`\lg(#?)`, String.raw`\lg(x)`],
      ["任意底数对数", String.raw`\log_{#?}(#?)`, String.raw`\log_a(x)`],
      ["指数函数 exp", String.raw`\exp(#?)`, String.raw`\exp(x)`],
      ["最大值 max", String.raw`\max(#?,#?)`, String.raw`\max(x,y)`],
      ["最小值 min", String.raw`\min(#?,#?)`, String.raw`\min(x,y)`],
      ["符号函数 sgn", String.raw`\operatorname{sgn}(#?)`, String.raw`\operatorname{sgn}(x)`],
      [
        "向下取整",
        String.raw`\left\lfloor#?\right\rfloor`,
        String.raw`\left\lfloor x\right\rfloor`,
      ],
      ["向上取整", String.raw`\left\lceil#?\right\rceil`, String.raw`\left\lceil x\right\rceil`],
    ],
  },
  {
    heading: "函数表示法",
    items: [
      ["函数 f(x)", "f(#?)", "f(x)"],
      ["函数 g(x)", "g(#?)", "g(x)"],
      ["通用函数", "#0(#?)", String.raw`F(\square)`],
      ["反函数", "#0^{-1}(#?)", "f^{-1}(x)"],
      ["复合函数", "#0\\circ#1(#?)", String.raw`f\circ g(x)`],
      ["命名函数", String.raw`\operatorname{#0}(#?)`, String.raw`\operatorname{Res}(x)`],
    ],
  },
  {
    heading: "数集记号",
    items: [
      ["实数集 R", String.raw`\mathbb{R}`, String.raw`\mathbb{R}`],
      ["自然数集 N", String.raw`\mathbb{N}`, String.raw`\mathbb{N}`],
      ["整数集 Z", String.raw`\mathbb{Z}`, String.raw`\mathbb{Z}`],
      ["有理数集 Q", String.raw`\mathbb{Q}`, String.raw`\mathbb{Q}`],
      ["复数集 C", String.raw`\mathbb{C}`, String.raw`\mathbb{C}`],
    ],
  },
  {
    heading: "特殊函数",
    items: [
      ["行列式 det", String.raw`\det(#?)`, String.raw`\det(A)`],
      ["最大公约数 gcd", String.raw`\gcd(#?,#?)`, String.raw`\gcd(a,b)`],
      [
        "最小公倍数 lcm",
        String.raw`\operatorname{lcm}(#?,#?)`,
        String.raw`\operatorname{lcm}(a,b)`,
      ],
      ["取模 mod", "#?\\bmod#?", "a\\bmod n"],
      [
        "上极限 limsup",
        String.raw`\limsup_{#?\to#?}`,
        String.raw`\displaystyle\limsup_{n\to\infty}`,
      ],
      [
        "下极限 liminf",
        String.raw`\liminf_{#?\to#?}`,
        String.raw`\displaystyle\liminf_{n\to\infty}`,
      ],
    ],
  },
  {
    heading: "重音与标注",
    items: [
      ["向量", String.raw`\vec{#?}`, String.raw`\vec{x}`],
      ["帽子", String.raw`\hat{#?}`, String.raw`\hat{x}`],
      ["宽帽子", String.raw`\widehat{#?}`, String.raw`\widehat{abc}`],
      ["波浪线", String.raw`\tilde{#?}`, String.raw`\tilde{x}`],
      ["宽波浪线", String.raw`\widetilde{#?}`, String.raw`\widetilde{abc}`],
      ["单点导数", String.raw`\dot{#?}`, String.raw`\dot{x}`],
      ["双点导数", String.raw`\ddot{#?}`, String.raw`\ddot{x}`],
      ["均值线", String.raw`\bar{#?}`, String.raw`\bar{x}`],
      ["上划线", String.raw`\overline{#?}`, String.raw`\overline{abc}`],
      ["下划线", String.raw`\underline{#?}`, String.raw`\underline{abc}`],
    ],
  },
  {
    heading: "常用公式",
    items: [
      [
        "二次公式",
        String.raw`x=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}`,
        String.raw`x=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}`,
      ],
      ["勾股定理", "a^{2}+b^{2}=c^{2}", "a^{2}+b^{2}=c^{2}"],
      [
        "二项式定理",
        String.raw`(x+a)^{n}=\sum_{k=0}^{n}\binom{n}{k}x^{k}a^{n-k}`,
        String.raw`\displaystyle(x+a)^{n}=\sum_{k=0}^{n}\binom{n}{k}x^{k}a^{n-k}`,
      ],
      [
        "泰勒展开",
        String.raw`f(x)=\sum_{n=0}^{\infty}\frac{f^{(n)}(a)}{n!}(x-a)^{n}`,
        String.raw`\displaystyle f(x)=\sum_{n=0}^{\infty}\frac{f^{(n)}(a)}{n!}(x-a)^{n}`,
      ],
      [
        "傅里叶级数",
        String.raw`f(x)=a_{0}+\sum_{n=1}^{\infty}\left(a_{n}\cos\frac{n\pi x}{L}+b_{n}\sin\frac{n\pi x}{L}\right)`,
        String.raw`\displaystyle f(x)=a_{0}+\sum_{n=1}^{\infty}\left(a_{n}\cos\frac{n\pi x}{L}+b_{n}\sin\frac{n\pi x}{L}\right)`,
      ],
      [
        "欧拉公式",
        String.raw`e^{i\theta}=\cos\theta+i\sin\theta`,
        String.raw`e^{i\theta}=\cos\theta+i\sin\theta`,
      ],
      [
        "高斯积分",
        String.raw`\int_{-\infty}^{\infty}e^{-x^{2}}\mathrm{d}x=\sqrt{\pi}`,
        String.raw`\displaystyle\int_{-\infty}^{\infty}e^{-x^{2}}\mathrm{d}x=\sqrt{\pi}`,
      ],
      [
        "三角函数恒等式",
        String.raw`\sin^{2}\theta+\cos^{2}\theta=1`,
        String.raw`\sin^{2}\theta+\cos^{2}\theta=1`,
      ],
      [
        "和差化积",
        String.raw`\sin\alpha+\sin\beta=2\sin\frac{\alpha+\beta}{2}\cos\frac{\alpha-\beta}{2}`,
        String.raw`\sin\alpha+\sin\beta=2\sin\frac{\alpha+\beta}{2}\cos\frac{\alpha-\beta}{2}`,
      ],
      [
        "等比数列求和",
        String.raw`\sum_{k=0}^{n}ar^{k}=a\frac{1-r^{n+1}}{1-r}`,
        String.raw`\displaystyle\sum_{k=0}^{n}ar^{k}=a\frac{1-r^{n+1}}{1-r}`,
      ],
    ],
  },
  {
    heading: "定界符扩展",
    items: [
      [
        "分段函数 cases",
        String.raw`\begin{cases}#?&\text{if }#?\\#?&\text{otherwise}\end{cases}`,
        String.raw`\begin{cases}x&\text{if }x\ge0\\-x&\text{otherwise}\end{cases}`,
      ],
      ["二项式系数", String.raw`\binom{#?}{#?}`, String.raw`\binom{n}{k}`],
      ["左单括号", String.raw`\left\{#?\right.`, String.raw`\left\{x\right.`],
      ["角括号", String.raw`\langle#?\rangle`, String.raw`\langle x\rangle`],
      ["范数", String.raw`\lVert#?\rVert`, String.raw`\lVert x\rVert`],
    ],
  },
] as const;

export const PHYSICS_FORMULA_GROUPS = [
  {
    heading: "经典力学",
    items: [
      ["牛顿第二定律", String.raw`\vec{F}=m\vec{a}`, String.raw`\vec{F}=m\vec{a}`],
      ["万有引力", String.raw`F=G\frac{m_1 m_2}{r^2}`, String.raw`F=G\frac{m_1 m_2}{r^2}`],
      [
        "动能定理",
        String.raw`W=\frac{1}{2}mv^2-\frac{1}{2}mv_0^2`,
        String.raw`W=\frac{1}{2}mv^2-\frac{1}{2}mv_0^2`,
      ],
      [
        "动量定理",
        String.raw`\vec{F}\Delta t=m\vec{v}-m\vec{v}_0`,
        String.raw`\vec{F}\Delta t=m\vec{v}-m\vec{v}_0`,
      ],
      ["胡克定律", "F=-kx", "F=-kx"],
    ],
  },
  {
    heading: "电磁学",
    items: [
      ["库仑定律", String.raw`F=k\frac{q_1 q_2}{r^2}`, String.raw`F=k\frac{q_1 q_2}{r^2}`],
      ["欧姆定律", String.raw`I=\frac{U}{R}`, String.raw`I=\frac{U}{R}`],
      ["电阻定律", String.raw`R=\rho\frac{l}{S}`, String.raw`R=\rho\frac{l}{S}`],
      ["焦耳定律", "Q=I^2 R t", "Q=I^2 R t"],
      [
        "洛伦兹力",
        String.raw`\vec{F}=q\vec{v}\times\vec{B}`,
        String.raw`\vec{F}=q\vec{v}\times\vec{B}`,
      ],
    ],
  },
  {
    heading: "热力学",
    items: [
      ["理想气体状态方程", "PV=nRT", "PV=nRT"],
      ["热力学第一定律", String.raw`\Delta U=Q+W`, String.raw`\Delta U=Q+W`],
      [
        "热机效率",
        String.raw`\eta=\frac{W}{Q_1}=1-\frac{Q_2}{Q_1}`,
        String.raw`\eta=\frac{W}{Q_1}=1-\frac{Q_2}{Q_1}`,
      ],
      ["熵变", String.raw`\Delta S=\frac{Q}{T}`, String.raw`\Delta S=\frac{Q}{T}`],
    ],
  },
  {
    heading: "光学与波动",
    items: [
      [
        "折射定律",
        String.raw`n_1\sin\theta_1=n_2\sin\theta_2`,
        String.raw`n_1\sin\theta_1=n_2\sin\theta_2`,
      ],
      ["波速公式", String.raw`v=\lambda f`, String.raw`v=\lambda f`],
      ["单缝衍射", String.raw`a\sin\theta=k\lambda`, String.raw`a\sin\theta=k\lambda`],
      [
        "多普勒效应",
        String.raw`f'=\frac{v\pm v_o}{v\mp v_s}f`,
        String.raw`f'=\frac{v\pm v_o}{v\mp v_s}f`,
      ],
    ],
  },
  {
    heading: "近代物理",
    items: [
      ["质能方程", "E=mc^2", "E=mc^2"],
      ["光电效应", String.raw`E_k=h\nu-W`, String.raw`E_k=h\nu-W`],
      ["德布罗意波", String.raw`\lambda=\frac{h}{p}`, String.raw`\lambda=\frac{h}{p}`],
      [
        "不确定性原理",
        String.raw`\Delta x\cdot\Delta p\geq\frac{h}{4\pi}`,
        String.raw`\Delta x\cdot\Delta p\geq\frac{h}{4\pi}`,
      ],
    ],
  },
] as const;

const TRIGONOMETRIC_FORMULA_GROUPS = [
  {
    heading: "基本三角函数",
    items: [
      ["正弦 sin", String.raw`\sin(#?)`, String.raw`\sin(x)`],
      ["余弦 cos", String.raw`\cos(#?)`, String.raw`\cos(x)`],
      ["正切 tan", String.raw`\tan(#?)`, String.raw`\tan(x)`],
      ["余切 cot", String.raw`\cot(#?)`, String.raw`\cot(x)`],
      ["正割 sec", String.raw`\sec(#?)`, String.raw`\sec(x)`],
      ["余割 csc", String.raw`\csc(#?)`, String.raw`\csc(x)`],
    ],
  },
  {
    heading: "反三角函数",
    items: [
      ["反正弦 arcsin", String.raw`\arcsin(#?)`, String.raw`\arcsin(x)`],
      ["反余弦 arccos", String.raw`\arccos(#?)`, String.raw`\arccos(x)`],
      ["反正切 arctan", String.raw`\arctan(#?)`, String.raw`\arctan(x)`],
      [
        "反余切 arccot",
        String.raw`\operatorname{arccot}(#?)`,
        String.raw`\operatorname{arccot}(x)`,
      ],
      [
        "反正割 arcsec",
        String.raw`\operatorname{arcsec}(#?)`,
        String.raw`\operatorname{arcsec}(x)`,
      ],
      [
        "反余割 arccsc",
        String.raw`\operatorname{arccsc}(#?)`,
        String.raw`\operatorname{arccsc}(x)`,
      ],
    ],
  },
  {
    heading: "双曲函数",
    items: [
      ["双曲正弦 sinh", String.raw`\sinh(#?)`, String.raw`\sinh(x)`],
      ["双曲余弦 cosh", String.raw`\cosh(#?)`, String.raw`\cosh(x)`],
      ["双曲正切 tanh", String.raw`\tanh(#?)`, String.raw`\tanh(x)`],
      ["双曲余切 coth", String.raw`\coth(#?)`, String.raw`\coth(x)`],
      ["双曲正割 sech", String.raw`\operatorname{sech}(#?)`, String.raw`\operatorname{sech}(x)`],
      ["双曲余割 csch", String.raw`\operatorname{csch}(#?)`, String.raw`\operatorname{csch}(x)`],
      [
        "反双曲正弦 arsinh",
        String.raw`\operatorname{arsinh}(#?)`,
        String.raw`\operatorname{arsinh}(x)`,
      ],
      [
        "反双曲余弦 arcosh",
        String.raw`\operatorname{arcosh}(#?)`,
        String.raw`\operatorname{arcosh}(x)`,
      ],
      [
        "反双曲正切 artanh",
        String.raw`\operatorname{artanh}(#?)`,
        String.raw`\operatorname{artanh}(x)`,
      ],
      [
        "反双曲余切 arcoth",
        String.raw`\operatorname{arcoth}(#?)`,
        String.raw`\operatorname{arcoth}(x)`,
      ],
      [
        "反双曲正割 arsech",
        String.raw`\operatorname{arsech}(#?)`,
        String.raw`\operatorname{arsech}(x)`,
      ],
      [
        "反双曲余割 arcsch",
        String.raw`\operatorname{arcsch}(#?)`,
        String.raw`\operatorname{arcsch}(x)`,
      ],
    ],
  },
] as const;

function createMatrixLatex(rows: number, columns: number): string {
  let placeholderIndex = 0;
  const body = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => (placeholderIndex++ === 0 ? "#0" : "#?")).join("&"),
  ).join(String.raw`\\`);
  return String.raw`\begin{bmatrix}${body}\end{bmatrix}`;
}

function MatrixInsertDialog({
  onInsert,
  onCancel,
}: {
  onInsert(latex: string): void;
  onCancel(): void;
}) {
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(2);
  const updateDimension = (value: string, setValue: (next: number) => void) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    setValue(Math.min(10, Math.max(1, Math.trunc(parsed))));
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close
    <div
      className="matrix-insert-backdrop"
      onClick={onCancel}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <section
        className="matrix-insert-dialog dialog-with-standard-close"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-insert-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <button
          type="button"
          className="dialog-close-button dialog-close-button--corner dialog-close-control"
          aria-label="关闭插入矩阵"
          onClick={onCancel}
        >
          <DialogCloseIcon />
        </button>
        <h3 id="matrix-insert-title">插入矩阵</h3>
        <p>选择矩阵的行数和列数。</p>
        <div className="matrix-insert-fields">
          <label>
            行数
            <input
              type="number"
              min="1"
              max="10"
              value={rows}
              onChange={(event) => updateDimension(event.target.value, setRows)}
            />
          </label>
          <label>
            列数
            <input
              type="number"
              min="1"
              max="10"
              value={columns}
              onChange={(event) => updateDimension(event.target.value, setColumns)}
            />
          </label>
        </div>
        <footer className="dialog-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => onInsert(createMatrixLatex(rows, columns))}
          >
            插入
          </button>
        </footer>
      </section>
    </div>
  );
}

function FormulaSymbolPreview({ latex }: { latex: string }) {
  const previewRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!previewRef.current) return;
    katex.render(latex, previewRef.current, { throwOnError: false, trust: false });
  }, [latex]);

  return <span aria-hidden="true" className="formula-symbol-preview" ref={previewRef} />;
}

export function FormulaCollectionDialog({
  titleId,
  title,
  groups,
  onInsert,
  onCancel,
  onInsertToDrawings,
  onReplaceToDrawings,
  drawingsOnly = false,
  displayMode = "modal",
  positionKey = `formula-collection:${titleId}`,
}: {
  titleId: string;
  title: string;
  groups: readonly {
    heading: string | null;
    items: readonly (readonly [label: string, latex: string, preview: string])[];
  }[];
  onInsert(latex: string): void;
  onCancel(): void;
  onInsertToDrawings?(latex: string): void | Promise<void>;
  onReplaceToDrawings?(latex: string): void | Promise<void>;
  drawingsOnly?: boolean;
  displayMode?: "modal" | "modeless";
  positionKey?: string;
}) {
  const drag = useDialogDrag<HTMLElement>({
    positionKey,
    memory: "session",
    movable: displayMode === "modeless",
    stackable: displayMode === "modeless",
  });
  const closing = useMotionPresenceClosing();
  const sessionVisible = useEditorSessionVisible();
  const [selectedLatex, setSelectedLatex] = useState(
    groups.flatMap((group) => group.items).at(0)?.[1] ?? "",
  );
  useModalDialog({
    open: displayMode === "modal" && !closing && sessionVisible,
    containerRef: drag.surfaceRef,
    onClose: onCancel,
  });
  useEffect(() => {
    if (displayMode !== "modeless" || closing || !sessionVisible) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = drag.surfaceRef.current;
    surface?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      if (
        previous?.isConnected &&
        (surface?.contains(document.activeElement) || document.activeElement === document.body)
      )
        previous.focus({ preventScroll: true });
    };
  }, [displayMode, drag.surfaceRef, closing, sessionVisible]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close
    <div
      hidden={!sessionVisible}
      inert={!sessionVisible}
      className={`matrix-insert-backdrop${displayMode === "modeless" ? " dialog-backdrop--modeless dialog-layer--modeless" : " dialog-layer--modal"}`}
      style={displayMode === "modeless" ? drag.layerStyle : undefined}
      onPointerDownCapture={displayMode === "modeless" ? drag.bringToFront : undefined}
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing) onCancel();
      }}
    >
      <section
        ref={drag.surfaceRef}
        className={`other-formula-dialog${displayMode === "modeless" ? " dialog-surface--floating" : ""}`}
        role="dialog"
        {...(displayMode === "modal" ? { "aria-modal": "true" } : {})}
        aria-labelledby={titleId}
        style={displayMode === "modeless" ? drag.style : undefined}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <header
          className={displayMode === "modeless" ? "dialog-titlebar--draggable" : undefined}
          ref={displayMode === "modeless" ? drag.titleBarRef : undefined}
        >
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="dialog-close-button dialog-close-control"
            aria-label="关闭弹窗"
            title="关闭弹窗（Esc）"
            onClick={onCancel}
          >
            <DialogCloseIcon />
          </button>
        </header>
        <div className="other-formula-dialog-body">
          {groups.map((group) => (
            <section
              className={
                group.heading
                  ? `other-formula-group other-formula-group--${group.heading}`
                  : "other-formula-group"
              }
              key={group.heading ?? "常用"}
            >
              {group.heading ? <h4>{group.heading}</h4> : null}
              {group.items.map(([label, latex, preview]) => (
                <button
                  key={label}
                  type="button"
                  className={
                    onInsertToDrawings && selectedLatex === latex ? "is-selected" : undefined
                  }
                  aria-label={label}
                  aria-pressed={onInsertToDrawings ? selectedLatex === latex : undefined}
                  onClick={() => {
                    if (onInsertToDrawings) {
                      setSelectedLatex(latex);
                      return;
                    }
                    onInsert(latex);
                  }}
                >
                  <FormulaSymbolPreview latex={preview} />
                  <span>{label}</span>
                </button>
              ))}
            </section>
          ))}
        </div>
        {onInsertToDrawings ? (
          <footer className="dialog-actions formula-dialog-footer-actions other-formula-dialog__actions">
            <button type="button" onClick={onCancel}>
              取消
            </button>
            {!drawingsOnly ? (
              <button
                type="button"
                disabled={!selectedLatex}
                onClick={() => onInsert(selectedLatex)}
              >
                插入
              </button>
            ) : null}
            <FigureDrawingActions
              disabled={!selectedLatex}
              onInsert={() => void onInsertToDrawings(selectedLatex)}
              onReplace={
                onReplaceToDrawings ? () => void onReplaceToDrawings(selectedLatex) : undefined
              }
            />
          </footer>
        ) : null}
      </section>
    </div>
  );
}

export function FormulaDialog(props: FormulaDialogProps) {
  // A different request must get its own MathLive value, selection and undo history.
  // Hiding and reopening the same request intentionally preserves its draft.
  return <FormulaDialogContent key={`${props.initialMode}:${props.initialLatex}`} {...props} />;
}

function FormulaDialogContent({
  open: requestedOpen = true,
  displayMode = "modal",
  positionKey = "formula-editor",
  initialLatex,
  initialMode,
  allowModeChange,
  drawingsOnly = false,
  onConfirm,
  onCancel,
  onInsertToDrawings,
  onReplaceToDrawings,
}: FormulaDialogProps) {
  const parentClosing = useMotionPresenceClosing();
  const sessionVisible = useEditorSessionVisible();
  const open = requestedOpen && !parentClosing && sessionVisible;
  const paintVisible = useRetainedTransientVisibility(open);
  const dialogId = useId();
  const drag = useDialogDrag<HTMLElement>({
    positionKey,
    memory: "session",
    movable: displayMode === "modeless",
    stackable: displayMode === "modeless" && open,
  });
  const compositionActive = useRef(false);
  const [latex, setLatex] = useState(initialLatex);
  const [mode, setMode] = useState(initialMode);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [insertingDrawing, setInsertingDrawing] = useState(false);
  const [incompletePromptOpen, setIncompletePromptOpen] = useState(false);
  const [matrixInsertOpen, setMatrixInsertOpen] = useState(false);
  const [formulaLibraryOpen, setFormulaLibraryOpen] = useState(false);
  const [trigonometricFormulaOpen, setTrigonometricFormulaOpen] = useState(false);
  const [fractionOpen, setFractionOpen] = useState(false);
  const [rootOpen, setRootOpen] = useState(false);
  const [integralOpen, setIntegralOpen] = useState(false);
  const [bracketOpen, setBracketOpen] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [functionOpen, setFunctionOpen] = useState(false);
  const [virtualKeyboardInset, setVirtualKeyboardInset] = useState(0);
  const [virtualKeyboardShift, setVirtualKeyboardShift] = useState(0);
  const mathFieldRef = useRef<MathFieldElement | null>(null);
  const [mathFieldReady, setMathFieldReady] = useState(false);
  const latexRef = useRef(latex);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const openingGreekKeyboardRef = useRef(false);
  latexRef.current = latex;

  const attachMathField = useCallback((element: MathFieldElement | null) => {
    mathFieldRef.current = element;
    if (!element) return;
    if (window.customElements.get("math-field")) element.value = latexRef.current;
    element.addEventListener(
      "mount",
      () => {
        element.menuItems = filterFormulaContextMenu(element.menuItems);
        setMathFieldReady(true);
      },
      { once: true },
    );
  }, []);

  const childDialogOpen =
    incompletePromptOpen ||
    matrixInsertOpen ||
    formulaLibraryOpen ||
    trigonometricFormulaOpen ||
    fractionOpen ||
    rootOpen ||
    integralOpen ||
    bracketOpen ||
    scriptOpen ||
    functionOpen;
  useEffect(() => {
    if (open && mathFieldReady && !childDialogOpen) mathFieldRef.current?.focus();
  }, [open, mathFieldReady, childDialogOpen]);

  useEffect(() => {
    let disposed = false;
    let virtualKeyboard: typeof window.mathVirtualKeyboard | undefined;
    let geometryFrame = 0;
    const syncVirtualKeyboardGeometry = () => {
      if (!virtualKeyboard) return;
      const bounds = virtualKeyboard.boundingRect;
      const nextInset =
        virtualKeyboard.visible && bounds.height > 0
          ? Math.min(window.innerHeight, Math.max(0, window.innerHeight - bounds.top))
          : 0;
      setVirtualKeyboardInset(nextInset);
    };
    const syncAfterLayout = () => {
      cancelAnimationFrame(geometryFrame);
      geometryFrame = requestAnimationFrame(syncVirtualKeyboardGeometry);
    };
    const openNumericKeyboard = () => {
      if (!virtualKeyboard?.visible || openingGreekKeyboardRef.current) return;
      const numericLayerId = getFormulaKeyboardLayerId(virtualKeyboard, "numeric");
      if (numericLayerId) virtualKeyboard.executeCommand(["switchKeyboardLayer", numericLayerId]);
      syncAfterLayout();
    };
    void import("mathlive")
      .then(({ MathfieldElement }) => {
        if (disposed) return;
        MathfieldElement.locale = "zh-cn";
        if (mathFieldRef.current) {
          if (mathFieldRef.current.value !== latexRef.current)
            mathFieldRef.current.value = latexRef.current;
          setMathFieldReady(true);
        }
        virtualKeyboard = window.mathVirtualKeyboard;
        configureFormulaVirtualKeyboard(virtualKeyboard);
        virtualKeyboard.addEventListener("virtual-keyboard-toggle", openNumericKeyboard);
        virtualKeyboard.addEventListener("virtual-keyboard-toggle", syncAfterLayout);
        virtualKeyboard.addEventListener("geometrychange", syncVirtualKeyboardGeometry);
        window.addEventListener("resize", syncAfterLayout);
        syncAfterLayout();
      })
      .catch(() => showApplicationError({ code: "INTERNAL", message: "normalized" }));
    return () => {
      disposed = true;
      cancelAnimationFrame(geometryFrame);
      virtualKeyboard?.removeEventListener("virtual-keyboard-toggle", openNumericKeyboard);
      virtualKeyboard?.removeEventListener("virtual-keyboard-toggle", syncAfterLayout);
      virtualKeyboard?.removeEventListener("geometrychange", syncVirtualKeyboardGeometry);
      window.removeEventListener("resize", syncAfterLayout);
    };
  }, []);

  useLayoutEffect(() => {
    if (!paintVisible || virtualKeyboardInset <= 0) {
      setVirtualKeyboardShift(0);
      return;
    }
    const storedTop = drag.style.top;
    if (typeof storedTop !== "number") {
      setVirtualKeyboardShift(0);
      return;
    }
    const dialog = drag.surfaceRef.current;
    if (!dialog) return;
    const keyboardTop = window.innerHeight - virtualKeyboardInset;
    const borderHeight = dialog.offsetHeight - dialog.clientHeight;
    const targetHeight = Math.min(
      dialog.scrollHeight + borderHeight,
      Math.max(0, window.innerHeight - 48 - virtualKeyboardInset),
    );
    const nextShift = Math.min(0, keyboardTop - FORMULA_KEYBOARD_GAP - storedTop - targetHeight);
    setVirtualKeyboardShift((current) =>
      Math.abs(current - nextShift) < 0.5 ? current : nextShift,
    );
  }, [drag.style.top, drag.surfaceRef, paintVisible, virtualKeyboardInset]);

  const previewError = useMemo(() => {
    if (latex.trim() && !InlineFormulaNodeSchema.shape.source.safeParse(latex).success) {
      return "公式源码过长，无法保存，请精简后再插入。";
    }
    try {
      katex.renderToString(latex, {
        displayMode: true,
        throwOnError: true,
        strict: "warn",
        trust: false,
      });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/Undefined control sequence|Undefined environment/i.test(message))
        return "公式包含不支持的命令或环境，请修改后再插入。";
      if (/end of input|EOF|Expected.*[}]/i.test(message))
        return "公式不完整，请继续输入后再确定。";
      return "公式格式有误，请检查括号和输入内容。";
    }
  }, [latex]);

  useEffect(() => {
    if (!previewRef.current || previewError) return;
    previewRef.current.replaceChildren();
    katex.render(latex, previewRef.current, {
      displayMode: true,
      throwOnError: false,
      strict: "warn",
      trust: false,
    });
  }, [latex, previewError]);

  const insertSymbol = (symbol: string) => {
    const field = mathFieldRef.current;
    if (field?.executeCommand) {
      field.executeCommand(["insert", symbol]);
      if (typeof field.value === "string") setLatex(field.value);
      field.focus();
      return;
    }
    setLatex((value) => `${value}${symbol}`);
  };

  const runHistoryCommand = (command: "undo" | "redo") => {
    const field = mathFieldRef.current;
    if (!field?.executeCommand) return;
    field.executeCommand(command);
    setLatex(field.value);
    field.focus();
  };

  const openGreekKeyboard = () => {
    mathFieldRef.current?.focus();
    openingGreekKeyboardRef.current = true;
    try {
      const virtualKeyboard = window.mathVirtualKeyboard;
      configureFormulaVirtualKeyboard(virtualKeyboard);
      virtualKeyboard.show();
      const greekLayerId = getFormulaKeyboardLayerId(virtualKeyboard, "greek");
      if (greekLayerId) {
        virtualKeyboard.executeCommand(["switchKeyboardLayer", greekLayerId]);
      }
    } finally {
      openingGreekKeyboardRef.current = false;
    }
  };

  const confirmFormula = () => {
    setSubmitError(null);
    if (previewError) {
      setIncompletePromptOpen(true);
      return;
    }

    try {
      const error = onConfirm({ latex, mode });
      if (error) setSubmitError(error);
    } catch {
      setSubmitError("公式未能保存，输入内容已保留，请重试。");
    }
  };

  const insertToDrawings = async (replace = false) => {
    const submit = replace ? onReplaceToDrawings : onInsertToDrawings;
    if (!submit || insertingDrawing) return;
    setSubmitError(null);
    if (previewError) {
      setIncompletePromptOpen(true);
      return;
    }
    setInsertingDrawing(true);
    try {
      await submit(latex);
    } catch {
      setSubmitError("公式未能插入附图，输入内容已保留，请重试。");
    } finally {
      setInsertingDrawing(false);
    }
  };

  const handleMathFieldShortcut = (event: KeyboardEvent<HTMLElement>) => {
    // IME may report its first key with keyCode 229 before isComposing becomes true.
    if (
      compositionActive.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      event.key === "Process"
    )
      return;
    if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (incompletePromptOpen) setIncompletePromptOpen(false);
      else if (matrixInsertOpen) setMatrixInsertOpen(false);
      else if (formulaLibraryOpen) setFormulaLibraryOpen(false);
      else if (trigonometricFormulaOpen) setTrigonometricFormulaOpen(false);
      else if (fractionOpen) setFractionOpen(false);
      else if (rootOpen) setRootOpen(false);
      else if (integralOpen) setIntegralOpen(false);
      else if (bracketOpen) setBracketOpen(false);
      else if (scriptOpen) setScriptOpen(false);
      else if (functionOpen) setFunctionOpen(false);
      else onCancel();
      return;
    }
    if (event.target !== mathFieldRef.current) return;
    if (event.ctrlKey || event.metaKey) {
      const command =
        event.key.toLowerCase() === "z"
          ? event.shiftKey
            ? "redo"
            : "undo"
          : event.key.toLowerCase() === "y"
            ? "redo"
            : null;
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      runHistoryCommand(command);
      return;
    }
    if (event.altKey || event.nativeEvent.isComposing || !/^[\x21-\x7E]$/.test(event.key)) return;

    event.preventDefault();
    event.stopPropagation();
    const field = mathFieldRef.current;
    // Physical input needs MathLive's caret/escaping rules, not LaTeX template insertion.
    field?.executeCommand?.([
      "typedText",
      event.key,
      { simulateKeystroke: true, feedback: false, focus: true },
    ]);
    if (typeof field?.value === "string") setLatex(field.value);
  };

  return createPortal(
    <div
      className={`dialog-backdrop dialog-layer--formula${displayMode === "modeless" ? " dialog-backdrop--modeless dialog-layer--modeless" : " dialog-layer--modal"}`}
      hidden={!paintVisible || !sessionVisible}
      inert={open ? undefined : true}
      aria-hidden={open ? undefined : true}
      data-motion={open ? "enter" : "exit"}
      style={
        {
          ...(displayMode === "modeless" ? drag.layerStyle : {}),
          "--formula-virtual-keyboard-height": `${virtualKeyboardInset}px`,
          display: paintVisible ? undefined : "none",
        } as CSSProperties
      }
      onPointerDownCapture={displayMode === "modeless" ? drag.bringToFront : undefined}
    >
      <section
        ref={drag.surfaceRef}
        className={`formula-dialog${displayMode === "modeless" ? " dialog-surface--floating" : ""}`}
        role="dialog"
        {...(displayMode === "modal" ? { "aria-modal": "true" } : {})}
        aria-labelledby={`${dialogId}-title`}
        style={{
          ...(displayMode === "modeless" ? drag.style : {}),
          translate: virtualKeyboardShift === 0 ? undefined : `0 ${virtualKeyboardShift}px`,
        }}
        onCompositionStartCapture={() => {
          compositionActive.current = true;
        }}
        onCompositionEndCapture={() => {
          compositionActive.current = false;
        }}
        onBlurCapture={() => {
          compositionActive.current = false;
        }}
        onKeyDownCapture={handleMathFieldShortcut}
      >
        <header
          className={displayMode === "modeless" ? "dialog-titlebar--draggable" : undefined}
          ref={displayMode === "modeless" ? drag.titleBarRef : undefined}
        >
          <h2 id={`${dialogId}-title`}>{initialLatex ? "编辑数学公式" : "插入数学公式"}</h2>
          {allowModeChange ? (
            <FormulaPositionSwitch kind="公式" mode={mode} onChange={setMode} />
          ) : null}
          <button
            type="button"
            className="dialog-close-button dialog-close-control"
            title="关闭弹窗（Esc）"
            onClick={onCancel}
          >
            <DialogCloseIcon />
          </button>
        </header>
        {createElement("math-field", {
          ref: attachMathField,
          role: "textbox",
          "aria-label": "可视公式编辑器",
          onInput: (event: Event) => setLatex((event.currentTarget as MathFieldElement).value),
        })}
        <fieldset className="formula-symbols">
          <legend className="screen-reader-only">常用公式符号</legend>
          {SYMBOLS.map(([label, symbol, preview]) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              onClick={() => {
                if (label === "矩阵") {
                  setMatrixInsertOpen(true);
                } else if (label === "三角函数") {
                  setTrigonometricFormulaOpen(true);
                } else if (label === "分数") {
                  setFractionOpen(true);
                } else if (label === "平方根") {
                  setRootOpen(true);
                } else if (label === "积分") {
                  setIntegralOpen(true);
                } else if (label === "括号") {
                  setBracketOpen(true);
                } else if (label === "上下标") {
                  setScriptOpen(true);
                } else if (label === "函数") {
                  setFunctionOpen(true);
                } else {
                  insertSymbol(symbol);
                }
              }}
            >
              <span className="formula-symbol-label">{label}</span>
              <FormulaSymbolPreview latex={preview} />
            </button>
          ))}
        </fieldset>
        <section className="formula-preview" aria-labelledby="formula-preview-title">
          <h3 id="formula-preview-title" className="screen-reader-only">
            公式预览
          </h3>
          {
            <SpatialPresence>
              {previewError ? <p role="alert">{previewError}</p> : <div ref={previewRef} />}
            </SpatialPresence>
          }
        </section>
        {
          <SpatialPresence>
            {submitError ? <p role="alert">{submitError}</p> : null}
          </SpatialPresence>
        }
        <footer>
          <div className="formula-dialog-footer-tools">
            <button type="button" onClick={() => setFormulaLibraryOpen(true)}>
              公式库
            </button>
            <button type="button" onClick={openGreekKeyboard}>
              希腊字母
            </button>
          </div>
          <div className="formula-dialog-footer-actions">
            {onInsertToDrawings ? (
              <FigureDrawingActions
                disabled={latex.trim().length === 0 || insertingDrawing}
                onInsert={() => void insertToDrawings()}
                onReplace={onReplaceToDrawings ? () => void insertToDrawings(true) : undefined}
              />
            ) : null}
            <button type="button" onClick={onCancel}>
              取消
            </button>
            {!drawingsOnly ? (
              <button
                type="button"
                className="primary-button"
                disabled={latex.trim().length === 0}
                onClick={confirmFormula}
              >
                确定
              </button>
            ) : null}
          </div>
        </footer>
        <MotionPresence>
          {matrixInsertOpen ? (
            <MatrixInsertDialog
              onCancel={() => setMatrixInsertOpen(false)}
              onInsert={(matrixLatex) => {
                insertSymbol(matrixLatex);
                setMatrixInsertOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {formulaLibraryOpen ? (
            <FormulaCollectionDialog
              titleId="formula-library-title"
              title="公式库"
              groups={FORMULA_LIBRARY_GROUPS}
              onCancel={() => setFormulaLibraryOpen(false)}
              onInsert={(otherLatex) => {
                insertSymbol(otherLatex);
                setFormulaLibraryOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {trigonometricFormulaOpen ? (
            <FormulaCollectionDialog
              titleId="trigonometric-formula-title"
              title="三角函数"
              groups={TRIGONOMETRIC_FORMULA_GROUPS}
              onCancel={() => setTrigonometricFormulaOpen(false)}
              onInsert={(trigonometricLatex) => {
                insertSymbol(trigonometricLatex);
                setTrigonometricFormulaOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {fractionOpen ? (
            <FormulaCollectionDialog
              titleId="fraction-variants-title"
              title="分数"
              groups={FRACTION_VARIANTS}
              onCancel={() => setFractionOpen(false)}
              onInsert={(fractionLatex) => {
                insertSymbol(fractionLatex);
                setFractionOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {rootOpen ? (
            <FormulaCollectionDialog
              titleId="root-variants-title"
              title="根式"
              groups={ROOT_VARIANTS}
              onCancel={() => setRootOpen(false)}
              onInsert={(rootLatex) => {
                insertSymbol(rootLatex);
                setRootOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {integralOpen ? (
            <FormulaCollectionDialog
              titleId="integral-variants-title"
              title="积分"
              groups={INTEGRAL_VARIANTS}
              onCancel={() => setIntegralOpen(false)}
              onInsert={(integralLatex) => {
                insertSymbol(integralLatex);
                setIntegralOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {bracketOpen ? (
            <FormulaCollectionDialog
              titleId="bracket-variants-title"
              title="括号"
              groups={BRACKET_VARIANTS}
              onCancel={() => setBracketOpen(false)}
              onInsert={(bracketLatex) => {
                insertSymbol(bracketLatex);
                setBracketOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {scriptOpen ? (
            <FormulaCollectionDialog
              titleId="script-variants-title"
              title="上下标"
              groups={SCRIPT_VARIANTS}
              onCancel={() => setScriptOpen(false)}
              onInsert={(scriptLatex) => {
                insertSymbol(scriptLatex);
                setScriptOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {functionOpen ? (
            <FormulaCollectionDialog
              titleId="function-variants-title"
              title="函数"
              groups={FUNCTION_VARIANTS}
              onCancel={() => setFunctionOpen(false)}
              onInsert={(functionLatex) => {
                insertSymbol(functionLatex);
                setFunctionOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
      </section>
      <MotionPresence>
        {incompletePromptOpen ? (
          <OperationFeedbackOverlay
            feedback={{
              tone: "error",
              title: previewError?.startsWith("公式不完整") ? "公式不完整" : "无法插入公式",
              message: previewError ?? "请检查公式后重试。",
            }}
            onClose={() => setIncompletePromptOpen(false)}
          />
        ) : null}
      </MotionPresence>
    </div>,
    document.body,
  );
}
