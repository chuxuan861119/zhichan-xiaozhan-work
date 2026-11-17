import katex from "katex";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../shared/motion-preference";
import { spatialMotionTiming } from "../../shared/spatial-motion";

type ElementCategory =
  | "alkali-metal"
  | "alkaline-earth"
  | "transition-metal"
  | "post-transition"
  | "metalloid"
  | "nonmetal"
  | "halogen"
  | "noble-gas"
  | "lanthanide"
  | "actinide";

type ElementEntry = {
  symbol: string;
  name: string;
  number: number;
  category: ElementCategory;
  group: number;
  period: number;
  common?: boolean;
};

type PanelTab = "elements" | "ions" | "formulas" | "isotopes";

export type ChemicalPeriodicPanelProps = {
  onInsertElement(symbol: string): void;
  /** 点击右上角关闭按钮时回调，用于收起整个元素面板。 */
  onClose?(): void;
};

const ELEMENTS: ElementEntry[] = [
  { symbol: "H", name: "氢", number: 1, category: "nonmetal", group: 1, period: 1 },
  { symbol: "He", name: "氦", number: 2, category: "noble-gas", group: 18, period: 1 },
  { symbol: "Li", name: "锂", number: 3, category: "alkali-metal", group: 1, period: 2 },
  { symbol: "Be", name: "铍", number: 4, category: "alkaline-earth", group: 2, period: 2 },
  { symbol: "B", name: "硼", number: 5, category: "metalloid", group: 13, period: 2 },
  { symbol: "C", name: "碳", number: 6, category: "nonmetal", group: 14, period: 2 },
  { symbol: "N", name: "氮", number: 7, category: "nonmetal", group: 15, period: 2 },
  { symbol: "O", name: "氧", number: 8, category: "nonmetal", group: 16, period: 2 },
  { symbol: "F", name: "氟", number: 9, category: "halogen", group: 17, period: 2 },
  { symbol: "Ne", name: "氖", number: 10, category: "noble-gas", group: 18, period: 2 },
  { symbol: "Na", name: "钠", number: 11, category: "alkali-metal", group: 1, period: 3 },
  { symbol: "Mg", name: "镁", number: 12, category: "alkaline-earth", group: 2, period: 3 },
  { symbol: "Al", name: "铝", number: 13, category: "post-transition", group: 13, period: 3 },
  { symbol: "Si", name: "硅", number: 14, category: "metalloid", group: 14, period: 3 },
  { symbol: "P", name: "磷", number: 15, category: "nonmetal", group: 15, period: 3 },
  { symbol: "S", name: "硫", number: 16, category: "nonmetal", group: 16, period: 3 },
  { symbol: "Cl", name: "氯", number: 17, category: "halogen", group: 17, period: 3 },
  { symbol: "Ar", name: "氩", number: 18, category: "noble-gas", group: 18, period: 3 },
  { symbol: "K", name: "钾", number: 19, category: "alkali-metal", group: 1, period: 4 },
  { symbol: "Ca", name: "钙", number: 20, category: "alkaline-earth", group: 2, period: 4 },
  { symbol: "Sc", name: "钪", number: 21, category: "transition-metal", group: 3, period: 4 },
  { symbol: "Ti", name: "钛", number: 22, category: "transition-metal", group: 4, period: 4 },
  { symbol: "V", name: "钒", number: 23, category: "transition-metal", group: 5, period: 4 },
  { symbol: "Cr", name: "铬", number: 24, category: "transition-metal", group: 6, period: 4 },
  { symbol: "Mn", name: "锰", number: 25, category: "transition-metal", group: 7, period: 4 },
  { symbol: "Fe", name: "铁", number: 26, category: "transition-metal", group: 8, period: 4 },
  { symbol: "Co", name: "钴", number: 27, category: "transition-metal", group: 9, period: 4 },
  { symbol: "Ni", name: "镍", number: 28, category: "transition-metal", group: 10, period: 4 },
  { symbol: "Cu", name: "铜", number: 29, category: "transition-metal", group: 11, period: 4 },
  { symbol: "Zn", name: "锌", number: 30, category: "transition-metal", group: 12, period: 4 },
  { symbol: "Ga", name: "镓", number: 31, category: "post-transition", group: 13, period: 4 },
  { symbol: "Ge", name: "锗", number: 32, category: "metalloid", group: 14, period: 4 },
  { symbol: "As", name: "砷", number: 33, category: "metalloid", group: 15, period: 4 },
  { symbol: "Se", name: "硒", number: 34, category: "nonmetal", group: 16, period: 4 },
  { symbol: "Br", name: "溴", number: 35, category: "halogen", group: 17, period: 4 },
  { symbol: "Kr", name: "氪", number: 36, category: "noble-gas", group: 18, period: 4 },
  { symbol: "Rb", name: "铷", number: 37, category: "alkali-metal", group: 1, period: 5 },
  { symbol: "Sr", name: "锶", number: 38, category: "alkaline-earth", group: 2, period: 5 },
  { symbol: "Y", name: "钇", number: 39, category: "transition-metal", group: 3, period: 5 },
  { symbol: "Zr", name: "锆", number: 40, category: "transition-metal", group: 4, period: 5 },
  { symbol: "Nb", name: "铌", number: 41, category: "transition-metal", group: 5, period: 5 },
  { symbol: "Mo", name: "钼", number: 42, category: "transition-metal", group: 6, period: 5 },
  { symbol: "Tc", name: "锝", number: 43, category: "transition-metal", group: 7, period: 5 },
  { symbol: "Ru", name: "钌", number: 44, category: "transition-metal", group: 8, period: 5 },
  { symbol: "Rh", name: "铑", number: 45, category: "transition-metal", group: 9, period: 5 },
  { symbol: "Pd", name: "钯", number: 46, category: "transition-metal", group: 10, period: 5 },
  { symbol: "Ag", name: "银", number: 47, category: "transition-metal", group: 11, period: 5 },
  { symbol: "Cd", name: "镉", number: 48, category: "transition-metal", group: 12, period: 5 },
  { symbol: "In", name: "铟", number: 49, category: "post-transition", group: 13, period: 5 },
  { symbol: "Sn", name: "锡", number: 50, category: "post-transition", group: 14, period: 5 },
  { symbol: "Sb", name: "锑", number: 51, category: "metalloid", group: 15, period: 5 },
  { symbol: "Te", name: "碲", number: 52, category: "metalloid", group: 16, period: 5 },
  { symbol: "I", name: "碘", number: 53, category: "halogen", group: 17, period: 5 },
  { symbol: "Xe", name: "氙", number: 54, category: "noble-gas", group: 18, period: 5 },
  { symbol: "Cs", name: "铯", number: 55, category: "alkali-metal", group: 1, period: 6 },
  { symbol: "Ba", name: "钡", number: 56, category: "alkaline-earth", group: 2, period: 6 },
  { symbol: "La", name: "镧", number: 57, category: "lanthanide", group: 3, period: 6 },
  { symbol: "Hf", name: "铪", number: 72, category: "transition-metal", group: 4, period: 6 },
  { symbol: "Ta", name: "钽", number: 73, category: "transition-metal", group: 5, period: 6 },
  { symbol: "W", name: "钨", number: 74, category: "transition-metal", group: 6, period: 6 },
  { symbol: "Re", name: "铼", number: 75, category: "transition-metal", group: 7, period: 6 },
  { symbol: "Os", name: "锇", number: 76, category: "transition-metal", group: 8, period: 6 },
  { symbol: "Ir", name: "铱", number: 77, category: "transition-metal", group: 9, period: 6 },
  { symbol: "Pt", name: "铂", number: 78, category: "transition-metal", group: 10, period: 6 },
  { symbol: "Au", name: "金", number: 79, category: "transition-metal", group: 11, period: 6 },
  { symbol: "Hg", name: "汞", number: 80, category: "transition-metal", group: 12, period: 6 },
  { symbol: "Tl", name: "铊", number: 81, category: "post-transition", group: 13, period: 6 },
  { symbol: "Pb", name: "铅", number: 82, category: "post-transition", group: 14, period: 6 },
  { symbol: "Bi", name: "铋", number: 83, category: "post-transition", group: 15, period: 6 },
  { symbol: "Po", name: "钋", number: 84, category: "post-transition", group: 16, period: 6 },
  { symbol: "At", name: "砹", number: 85, category: "halogen", group: 17, period: 6 },
  { symbol: "Rn", name: "氡", number: 86, category: "noble-gas", group: 18, period: 6 },
  { symbol: "Fr", name: "钫", number: 87, category: "alkali-metal", group: 1, period: 7 },
  { symbol: "Ra", name: "镭", number: 88, category: "alkaline-earth", group: 2, period: 7 },
  { symbol: "Ac", name: "锕", number: 89, category: "actinide", group: 3, period: 7 },
  { symbol: "Rf", name: "𬬻", number: 104, category: "transition-metal", group: 4, period: 7 },
  { symbol: "Db", name: "𬭊", number: 105, category: "transition-metal", group: 5, period: 7 },
  { symbol: "Sg", name: "𬭳", number: 106, category: "transition-metal", group: 6, period: 7 },
  { symbol: "Bh", name: "𬭛", number: 107, category: "transition-metal", group: 7, period: 7 },
  { symbol: "Hs", name: "𬭶", number: 108, category: "transition-metal", group: 8, period: 7 },
  { symbol: "Mt", name: "鿏", number: 109, category: "transition-metal", group: 9, period: 7 },
  { symbol: "Ds", name: "𫟼", number: 110, category: "transition-metal", group: 10, period: 7 },
  { symbol: "Rg", name: "𬬭", number: 111, category: "transition-metal", group: 11, period: 7 },
  { symbol: "Cn", name: "鿔", number: 112, category: "transition-metal", group: 12, period: 7 },
  { symbol: "Nh", name: "鿭", number: 113, category: "post-transition", group: 13, period: 7 },
  { symbol: "Fl", name: "𫓧", number: 114, category: "post-transition", group: 14, period: 7 },
  { symbol: "Mc", name: "镆", number: 115, category: "post-transition", group: 15, period: 7 },
  { symbol: "Lv", name: "𫟷", number: 116, category: "post-transition", group: 16, period: 7 },
  { symbol: "Ts", name: "鿬", number: 117, category: "halogen", group: 17, period: 7 },
  { symbol: "Og", name: "鿫", number: 118, category: "noble-gas", group: 18, period: 7 },
];

const COMMON_ELEMENT_SYMBOLS = new Set([
  "H",
  "C",
  "N",
  "O",
  "F",
  "Na",
  "Mg",
  "Al",
  "Si",
  "P",
  "S",
  "Cl",
  "K",
  "Ca",
  "Mn",
  "Fe",
  "Cu",
  "Zn",
  "Br",
  "I",
]);

const LANTHANIDES: ElementEntry[] = [
  { symbol: "Ce", name: "铈", number: 58, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Pr", name: "镨", number: 59, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Nd", name: "钕", number: 60, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Pm", name: "钷", number: 61, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Sm", name: "钐", number: 62, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Eu", name: "铕", number: 63, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Gd", name: "钆", number: 64, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Tb", name: "铽", number: 65, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Dy", name: "镝", number: 66, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Ho", name: "钬", number: 67, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Er", name: "铒", number: 68, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Tm", name: "铥", number: 69, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Yb", name: "镱", number: 70, category: "lanthanide", group: 3, period: 8 },
  { symbol: "Lu", name: "镥", number: 71, category: "lanthanide", group: 3, period: 8 },
];

const ACTINIDES: ElementEntry[] = [
  { symbol: "Th", name: "钍", number: 90, category: "actinide", group: 3, period: 9 },
  { symbol: "Pa", name: "镤", number: 91, category: "actinide", group: 3, period: 9 },
  { symbol: "U", name: "铀", number: 92, category: "actinide", group: 3, period: 9 },
  { symbol: "Np", name: "镎", number: 93, category: "actinide", group: 3, period: 9 },
  { symbol: "Pu", name: "钚", number: 94, category: "actinide", group: 3, period: 9 },
  { symbol: "Am", name: "镅", number: 95, category: "actinide", group: 3, period: 9 },
  { symbol: "Cm", name: "锔", number: 96, category: "actinide", group: 3, period: 9 },
  { symbol: "Bk", name: "锫", number: 97, category: "actinide", group: 3, period: 9 },
  { symbol: "Cf", name: "锎", number: 98, category: "actinide", group: 3, period: 9 },
  { symbol: "Es", name: "锿", number: 99, category: "actinide", group: 3, period: 9 },
  { symbol: "Fm", name: "镄", number: 100, category: "actinide", group: 3, period: 9 },
  { symbol: "Md", name: "钔", number: 101, category: "actinide", group: 3, period: 9 },
  { symbol: "No", name: "锘", number: 102, category: "actinide", group: 3, period: 9 },
  { symbol: "Lr", name: "铹", number: 103, category: "actinide", group: 3, period: 9 },
];

const ISOTOPES = [
  // 氢同位素（氘代化合物在药物专利中非常常见）
  { label: "氕", formula: "^{1}H", description: "氢-1 / H" },
  { label: "氘", formula: "^{2}H", description: "氢-2 / D" },
  { label: "氚", formula: "^{3}H", description: "氢-3 / T" },
  // 碳同位素
  { label: "碳-11", formula: "^{11}C", description: "PET 显像" },
  { label: "碳-12", formula: "^{12}C", description: "天然丰度 98.9%" },
  { label: "碳-13", formula: "^{13}C", description: "NMR 检测" },
  { label: "碳-14", formula: "^{14}C", description: "放射性标记" },
  // 氮同位素
  { label: "氮-13", formula: "^{13}N", description: "PET 显像" },
  { label: "氮-14", formula: "^{14}N", description: "天然丰度 99.6%" },
  { label: "氮-15", formula: "^{15}N", description: "NMR 检测" },
  // 氧同位素
  { label: "氧-15", formula: "^{15}O", description: "PET 显像" },
  { label: "氧-16", formula: "^{16}O", description: "天然丰度 99.8%" },
  { label: "氧-17", formula: "^{17}O", description: "NMR 检测" },
  { label: "氧-18", formula: "^{18}O", description: "同位素标记" },
  // 氟同位素（PET 药物常用）
  { label: "氟-18", formula: "^{18}F", description: "FDG PET 显像" },
  // 磷同位素
  { label: "磷-31", formula: "^{31}P", description: "天然丰度 100%" },
  { label: "磷-32", formula: "^{32}P", description: "放射性治疗" },
  { label: "磷-33", formula: "^{33}P", description: "放射标记" },
  // 硫同位素
  { label: "硫-32", formula: "^{32}S", description: "天然丰度 95%" },
  { label: "硫-33", formula: "^{33}S", description: "NMR 检测" },
  { label: "硫-34", formula: "^{34}S", description: "同位素标记" },
  { label: "硫-35", formula: "^{35}S", description: "放射标记" },
  { label: "硫-36", formula: "^{36}S", description: "微量" },
  // 氯同位素
  { label: "氯-35", formula: "^{35}Cl", description: "天然丰度 76%" },
  { label: "氯-37", formula: "^{37}Cl", description: "天然丰度 24%" },
  // 溴同位素
  { label: "溴-79", formula: "^{79}Br", description: "天然丰度 51%" },
  { label: "溴-81", formula: "^{81}Br", description: "天然丰度 49%" },
  // 碘同位素
  { label: "碘-123", formula: "^{123}I", description: "SPECT 显像" },
  { label: "碘-125", formula: "^{125}I", description: "放射免疫" },
  { label: "碘-127", formula: "^{127}I", description: "天然丰度 100%" },
  { label: "碘-131", formula: "^{131}I", description: "放射性治疗" },
  // 铀同位素
  { label: "铀-234", formula: "^{234}U", description: "微量" },
  { label: "铀-235", formula: "^{235}U", description: "核燃料" },
  { label: "铀-238", formula: "^{238}U", description: "天然丰度 99.3%" },
] as const;

const COMMON_CATIONS = [
  { label: "氢离子", formula: "H^{+}" },
  { label: "锂离子", formula: "Li^{+}" },
  { label: "钠离子", formula: "Na^{+}" },
  { label: "钾离子", formula: "K^{+}" },
  { label: "银离子", formula: "Ag^{+}" },
  { label: "铵根", formula: "NH_{4}^{+}" },
  { label: "钙离子", formula: "Ca^{2+}" },
  { label: "镁离子", formula: "Mg^{2+}" },
  { label: "钡离子", formula: "Ba^{2+}" },
  { label: "锌离子", formula: "Zn^{2+}" },
  { label: "铜离子", formula: "Cu^{2+}" },
  { label: "亚铁离子", formula: "Fe^{2+}" },
  { label: "铁离子", formula: "Fe^{3+}" },
  { label: "铝离子", formula: "Al^{3+}" },
  { label: "锰离子", formula: "Mn^{2+}" },
  { label: "铬离子", formula: "Cr^{3+}" },
  { label: "铅离子", formula: "Pb^{2+}" },
  { label: "汞离子", formula: "Hg^{2+}" },
] as const;

const COMMON_ANIONS = [
  { label: "氟离子", formula: "F^{-}" },
  { label: "氯离子", formula: "Cl^{-}" },
  { label: "溴离子", formula: "Br^{-}" },
  { label: "碘离子", formula: "I^{-}" },
  { label: "氢氧根", formula: "OH^{-}" },
  { label: "硝酸根", formula: "NO_{3}^{-}" },
  { label: "亚硝酸根", formula: "NO_{2}^{-}" },
  { label: "硫酸根", formula: "SO_{4}^{2-}" },
  { label: "亚硫酸根", formula: "SO_{3}^{2-}" },
  { label: "碳酸根", formula: "CO_{3}^{2-}" },
  { label: "磷酸根", formula: "PO_{4}^{3-}" },
  { label: "高锰酸根", formula: "MnO_{4}^{-}" },
  { label: "重铬酸根", formula: "Cr_{2}O_{7}^{2-}" },
  { label: "碳酸氢根", formula: "HCO_{3}^{-}" },
  { label: "醋酸根", formula: "CH_{3}COO^{-}" },
  { label: "硫离子", formula: "S^{2-}" },
  { label: "氧离子", formula: "O^{2-}" },
] as const;

const INORGANIC_FORMULAS = [
  { label: "水", formula: "H_{2}O" },
  { label: "二氧化碳", formula: "CO_{2}" },
  { label: "一氧化碳", formula: "CO" },
  { label: "氨", formula: "NH_{3}" },
  { label: "盐酸", formula: "HCl" },
  { label: "硫酸", formula: "H_{2}SO_{4}" },
  { label: "硝酸", formula: "HNO_{3}" },
  { label: "磷酸", formula: "H_{3}PO_{4}" },
  { label: "碳酸", formula: "H_{2}CO_{3}" },
  { label: "氢氧化钠", formula: "NaOH" },
  { label: "氢氧化钾", formula: "KOH" },
  { label: "氢氧化钙", formula: "Ca(OH)_{2}" },
  { label: "氢氧化铝", formula: "Al(OH)_{3}" },
  { label: "氯化钠", formula: "NaCl" },
  { label: "氯化钾", formula: "KCl" },
  { label: "氯化铵", formula: "NH_{4}Cl" },
  { label: "氯化铁", formula: "FeCl_{3}" },
  { label: "碳酸钙", formula: "CaCO_{3}" },
  { label: "碳酸钠", formula: "Na_{2}CO_{3}" },
  { label: "碳酸氢钠", formula: "NaHCO_{3}" },
  { label: "硫酸铜", formula: "CuSO_{4}" },
  { label: "硫酸钡", formula: "BaSO_{4}" },
  { label: "硫酸亚铁", formula: "FeSO_{4}" },
  { label: "硫酸锌", formula: "ZnSO_{4}" },
  { label: "硝酸银", formula: "AgNO_{3}" },
  { label: "硝酸钾", formula: "KNO_{3}" },
  { label: "高锰酸钾", formula: "KMnO_{4}" },
  { label: "磷酸钙", formula: "Ca_{3}(PO_{4})_{2}" },
  { label: "过氧化氢", formula: "H_{2}O_{2}" },
  { label: "二氧化硫", formula: "SO_{2}" },
  { label: "二氧化氮", formula: "NO_{2}" },
  { label: "二氧化硅", formula: "SiO_{2}" },
  { label: "氧化钙", formula: "CaO" },
  { label: "氧化铁", formula: "Fe_{2}O_{3}" },
  { label: "氧化铝", formula: "Al_{2}O_{3}" },
  { label: "氧化铜", formula: "CuO" },
  { label: "氧化镁", formula: "MgO" },
  { label: "硅酸钠", formula: "Na_{2}SiO_{3}" },
] as const;

const ORGANIC_FORMULAS = [
  { label: "甲烷", formula: "CH_{4}" },
  { label: "乙烯", formula: "C_{2}H_{4}" },
  { label: "乙炔", formula: "C_{2}H_{2}" },
  { label: "苯", formula: "C_{6}H_{6}" },
  { label: "甲苯", formula: "C_{7}H_{8}" },
  { label: "甲醇", formula: "CH_{3}OH" },
  { label: "乙醇", formula: "C_{2}H_{5}OH" },
  { label: "乙二醇", formula: "C_{2}H_{4}(OH)_{2}" },
  { label: "苯酚", formula: "C_{6}H_{5}OH" },
  { label: "甲醛", formula: "HCHO" },
  { label: "乙醛", formula: "CH_{3}CHO" },
  { label: "丙酮", formula: "CH_{3}COCH_{3}" },
  { label: "乙酸", formula: "CH_{3}COOH" },
  { label: "乙酸乙酯", formula: "CH_{3}COOC_{2}H_{5}" },
  { label: "乙醚", formula: "C_{2}H_{5}OC_{2}H_{5}" },
] as const;

function categoryColor(category: ElementCategory): string {
  switch (category) {
    case "alkali-metal":
      return "#ef4444";
    case "alkaline-earth":
      return "#f97316";
    case "transition-metal":
      return "#eab308";
    case "post-transition":
      return "#22c55e";
    case "metalloid":
      return "#06b6d4";
    case "nonmetal":
      return "#3b82f6";
    case "halogen":
      return "#8b5cf6";
    case "noble-gas":
      return "#ec4899";
    case "lanthanide":
      return "#14b8a6";
    case "actinide":
      return "#f43f5e";
  }
}

function categoryLabel(category: ElementCategory): string {
  switch (category) {
    case "alkali-metal":
      return "碱金属";
    case "alkaline-earth":
      return "碱土金属";
    case "transition-metal":
      return "过渡金属";
    case "post-transition":
      return "后过渡金属";
    case "metalloid":
      return "类金属";
    case "nonmetal":
      return "非金属";
    case "halogen":
      return "卤素";
    case "noble-gas":
      return "稀有气体";
    case "lanthanide":
      return "镧系";
    case "actinide":
      return "锕系";
  }
}

function ElementCell({
  element,
  onInsert,
  highlighted = false,
}: {
  element: ElementEntry;
  onInsert(symbol: string): void;
  highlighted?: boolean;
}) {
  const isCommon = COMMON_ELEMENT_SYMBOLS.has(element.symbol);
  return (
    <button
      type="button"
      className={`periodic-cell${isCommon ? " periodic-cell-common" : ""}${highlighted ? " search-match" : ""}`}
      style={{ "--cell-color": categoryColor(element.category) } as React.CSSProperties}
      title={`${element.name} (${element.symbol}) — ${element.number}号 ${categoryLabel(element.category)}${isCommon ? " · 常用" : ""}`}
      onClick={() => onInsert(element.symbol)}
    >
      <span className="periodic-cell-number">{element.number}</span>
      <span className="periodic-cell-symbol">{element.symbol}</span>
      <span className="periodic-cell-name">{element.name}</span>
    </button>
  );
}

function EmptyCell() {
  return <span className="periodic-cell periodic-cell-empty" aria-hidden="true" />;
}

function FormulaPreview({ formula }: { formula: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    katex.render(String.raw`\ce{${formula}}`, ref.current, {
      throwOnError: false,
      strict: "warn",
      trust: false,
    });
  }, [formula]);

  return <strong ref={ref} className="periodic-formula-preview" aria-hidden="true" />;
}

function FormulaButton({
  label,
  formula,
  onInsert,
  highlighted = false,
}: {
  label: string;
  formula: string;
  onInsert(symbol: string): void;
  highlighted?: boolean;
}) {
  return (
    <button
      type="button"
      className={`periodic-formula-btn${highlighted ? " search-match" : ""}`}
      title={`${label}: ${formula}`}
      onClick={() => onInsert(formula)}
    >
      <FormulaPreview formula={formula} />
      <span>{label}</span>
    </button>
  );
}

export function ChemicalPeriodicPanel({ onInsertElement, onClose }: ChemicalPeriodicPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("elements");
  const viewRef = useRef<HTMLDivElement>(null);
  const outgoingView = useRef<{ key: PanelTab; node: HTMLElement; height: number } | null>(null);
  const selectTab = (tab: PanelTab) => {
    if (tab === activeTab) return;
    const content = viewRef.current;
    const panel = content?.querySelector<HTMLElement>('[role="tabpanel"]');
    outgoingView.current =
      content && panel && !prefersReducedMotion()
        ? {
            key: activeTab,
            node: panel.cloneNode(true) as HTMLElement,
            height: content.getBoundingClientRect().height,
          }
        : null;
    setActiveTab(tab);
  };
  useLayoutEffect(() => {
    const outgoing = outgoingView.current;
    outgoingView.current = null;
    const content = viewRef.current;
    if (
      !outgoing ||
      outgoing.key === activeTab ||
      !content ||
      prefersReducedMotion() ||
      typeof content.animate !== "function"
    )
      return;
    const nextHeight = content.getBoundingClientRect().height;
    const incoming = content.querySelector<HTMLElement>('[role="tabpanel"]');
    const timing = spatialMotionTiming(Math.max(6, Math.abs(nextHeight - outgoing.height)));
    const enter = incoming?.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      timing,
    );
    const ghost = outgoing.node;
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.classList.add("periodic-tab-outgoing");
    content.append(ghost);
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], timing);
    const height = content.animate(
      [{ height: outgoing.height + "px" }, { height: nextHeight + "px" }],
      timing,
    );
    const finish = () => ghost.remove();
    void fade.finished.then(finish, finish);
    return () => {
      fade.cancel();
      height.cancel();
      enter?.cancel();
      ghost.remove();
    };
  }, [activeTab]);
  const [searchQuery, setSearchQuery] = useState("");
  const tabsRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const update = () => {
      const selected = tabs.querySelector<HTMLElement>(`[data-tab="${activeTab}"]`);
      if (!selected) return;
      setIndicator({ left: selected.offsetLeft, width: selected.offsetWidth });
    };
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(tabs);
    for (const button of tabs.querySelectorAll("button")) observer?.observe(button);
    return () => observer?.disconnect();
  }, [activeTab]);

  const tabs: { key: PanelTab; label: string }[] = [
    { key: "elements", label: "元素周期表" },
    { key: "ions", label: "离子" },
    { key: "formulas", label: "化学式" },
    { key: "isotopes", label: "同位素" },
  ];

  const q = searchQuery.trim().toLowerCase();

  /** 剥离 LaTeX 标记 `_` `{` `}` `^` 后的纯文本，用于搜索匹配。 */
  const stripLatex = (s: string) => s.replace(/[_^{}]/g, "").toLowerCase();

  const matchElement = (el: ElementEntry) => {
    if (!q) return false;
    return el.symbol.toLowerCase().includes(q) || el.name.includes(q) || String(el.number) === q;
  };

  const matchFormula = (item: { label: string; formula: string }) => {
    if (!q) return false;
    return item.label.toLowerCase().includes(q) || stripLatex(item.formula).includes(q);
  };

  const matchIsotope = (iso: { label: string; formula: string; description: string }) => {
    if (!q) return false;
    return (
      iso.label.toLowerCase().includes(q) ||
      stripLatex(iso.formula).includes(q) ||
      iso.description.includes(q)
    );
  };

  const elementMap = new Map<string, ElementEntry>();
  for (const el of ELEMENTS) {
    elementMap.set(`${el.group}-${el.period}`, el);
  }
  for (const el of LANTHANIDES) {
    elementMap.set(`${el.group}-${el.period}`, el);
  }
  for (const el of ACTINIDES) {
    elementMap.set(`${el.group}-${el.period}`, el);
  }

  const getCell = useCallback(
    (group: number, period: number) => elementMap.get(`${group}-${period}`),
    [elementMap],
  );

  const cellKey = (group: number, period: number) => `pt-${group}-${period}`;

  return (
    <section className="chemical-periodic-panel">
      <div className="periodic-panel-header">
        <div ref={tabsRef} className="periodic-tabs" role="tablist" aria-label="化学输入面板">
          {indicator ? (
            <span
              className="periodic-tab-indicator"
              aria-hidden="true"
              style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }}
            />
          ) : null}
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              data-tab={tab.key}
              aria-selected={activeTab === tab.key}
              className={`periodic-tab${activeTab === tab.key ? " is-active" : ""}`}
              onClick={() => selectTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="periodic-panel-search-wrapper">
          <input
            type="text"
            className="periodic-panel-search"
            placeholder="搜索元素或化学式…"
            aria-label="搜索化学面板"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery ? (
            <button
              type="button"
              className="periodic-panel-search-clear"
              aria-label="清空搜索"
              onClick={() => setSearchQuery("")}
            >
              ✕
            </button>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            className="periodic-panel-close dialog-close-button"
            aria-label="收起元素面板"
            title="收起元素面板"
            onClick={onClose}
          >
            ✕
          </button>
        ) : null}
      </div>

      <div ref={viewRef} className="periodic-tab-content">
        {activeTab === "elements" ? (
          <div className="periodic-grid" role="tabpanel" aria-label="元素周期表">
            <div className="periodic-row periodic-row-header">
              {Array.from({ length: 18 }, (_, i) => {
                const col = i + 1;
                return (
                  <span key={`col-${col}`} className="periodic-col-header">
                    {col}
                  </span>
                );
              })}
            </div>

            {[1, 2, 3, 4, 5].map((period) => (
              <div key={`period-${period}`} className="periodic-row">
                {Array.from({ length: 18 }, (_, i) => {
                  const g = i + 1;
                  const el = getCell(g, period);
                  return el ? (
                    <ElementCell
                      key={cellKey(g, period)}
                      element={el}
                      onInsert={onInsertElement}
                      highlighted={matchElement(el)}
                    />
                  ) : (
                    <EmptyCell key={`empty-${g}-${period}`} />
                  );
                })}
              </div>
            ))}

            {/* Period 6: includes La at group 3 */}
            <div className="periodic-row">
              {Array.from({ length: 18 }, (_, i) => {
                const g = i + 1;
                const el = getCell(g, 6);
                if (el)
                  return (
                    <ElementCell
                      key={cellKey(g, 6)}
                      element={el}
                      onInsert={onInsertElement}
                      highlighted={matchElement(el)}
                    />
                  );
                return <EmptyCell key={`empty-${g}-6`} />;
              })}
            </div>

            {/* Period 7: includes Ac at group 3 */}
            <div className="periodic-row">
              {Array.from({ length: 18 }, (_, i) => {
                const g = i + 1;
                const el = getCell(g, 7);
                if (el)
                  return (
                    <ElementCell
                      key={cellKey(g, 7)}
                      element={el}
                      onInsert={onInsertElement}
                      highlighted={matchElement(el)}
                    />
                  );
                return <EmptyCell key={`empty-${g}-7`} />;
              })}
            </div>

            {/* Lanthanides */}
            <div className="periodic-row periodic-row-series">
              {Array.from({ length: 18 }, (_, i) => {
                const g = i + 1;
                if (g >= 3 && g <= 16) {
                  const el = LANTHANIDES[g - 3];
                  return el ? (
                    <ElementCell
                      key={cellKey(g, 8)}
                      element={el}
                      onInsert={onInsertElement}
                      highlighted={matchElement(el)}
                    />
                  ) : (
                    <EmptyCell key={`empty-${g}-8`} />
                  );
                }
                return <EmptyCell key={`empty-${g}-8a`} />;
              })}
            </div>

            {/* Actinides */}
            <div className="periodic-row periodic-row-series">
              {Array.from({ length: 18 }, (_, i) => {
                const g = i + 1;
                if (g >= 3 && g <= 16) {
                  const el = ACTINIDES[g - 3];
                  return el ? (
                    <ElementCell
                      key={cellKey(g, 9)}
                      element={el}
                      onInsert={onInsertElement}
                      highlighted={matchElement(el)}
                    />
                  ) : (
                    <EmptyCell key={`empty-${g}-9`} />
                  );
                }
                return <EmptyCell key={`empty-${g}-9a`} />;
              })}
            </div>

            {/* Legend */}
            <div className="periodic-legend">
              {(
                [
                  "alkali-metal",
                  "alkaline-earth",
                  "transition-metal",
                  "post-transition",
                  "metalloid",
                  "nonmetal",
                  "halogen",
                  "noble-gas",
                  "lanthanide",
                  "actinide",
                ] as ElementCategory[]
              ).map((cat) => (
                <span key={cat} className="periodic-legend-item">
                  <span
                    className="periodic-legend-swatch"
                    style={{ background: categoryColor(cat) }}
                  />
                  {categoryLabel(cat)}
                </span>
              ))}
            </div>
          </div>
        ) : activeTab === "ions" ? (
          <div role="tabpanel" aria-label="常用离子">
            <div className="periodic-section-label">阳离子</div>
            <div className="periodic-formula-grid">
              {COMMON_CATIONS.map((ion) => (
                <FormulaButton
                  key={ion.formula}
                  label={ion.label}
                  formula={ion.formula}
                  onInsert={onInsertElement}
                  highlighted={matchFormula(ion)}
                />
              ))}
            </div>
            <div className="periodic-section-label">阴离子</div>
            <div className="periodic-formula-grid">
              {COMMON_ANIONS.map((ion) => (
                <FormulaButton
                  key={ion.formula}
                  label={ion.label}
                  formula={ion.formula}
                  onInsert={onInsertElement}
                  highlighted={matchFormula(ion)}
                />
              ))}
            </div>
          </div>
        ) : activeTab === "formulas" ? (
          <div role="tabpanel" aria-label="常用化学式">
            <div className="periodic-section-label">无机物</div>
            <div className="periodic-formula-grid">
              {INORGANIC_FORMULAS.map((f) => (
                <FormulaButton
                  key={f.formula}
                  label={f.label}
                  formula={f.formula}
                  onInsert={onInsertElement}
                  highlighted={matchFormula(f)}
                />
              ))}
            </div>
            <div className="periodic-section-label">有机物</div>
            <div className="periodic-formula-grid">
              {ORGANIC_FORMULAS.map((f) => (
                <FormulaButton
                  key={f.formula}
                  label={f.label}
                  formula={f.formula}
                  onInsert={onInsertElement}
                  highlighted={matchFormula(f)}
                />
              ))}
            </div>
          </div>
        ) : activeTab === "isotopes" ? (
          <div className="periodic-formula-grid" role="tabpanel" aria-label="常用同位素">
            {ISOTOPES.map((iso) => (
              <FormulaButton
                key={iso.label}
                label={iso.label}
                formula={iso.formula}
                onInsert={onInsertElement}
                highlighted={matchIsotope(iso)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
