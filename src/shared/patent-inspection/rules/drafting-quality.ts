import "katex/contrib/mhchem";
import katex from "katex";
import type { BlockNode, HeadingNode, ParagraphNode } from "../../document/model.js";
import { tableNameNumbers } from "../../document/table-annotations.js";
import type { CanonicalPatent, PatentBookKind } from "../../patent/model.js";
import { descriptionReferenceNumberSuffix } from "../../patent/reference-mark-description-number.js";
import { visibleBlockText } from "../../patent/text.js";
import { literalText, nestedBlocks } from "../blocks.js";
import { HEURISTIC_RULE, PRODUCT_POLICY } from "../rule-provenance.js";
import type {
  InspectionIssueDraft,
  PatentInspectionRule,
  PatentIssueCode,
  PatentLocation,
} from "../types.js";

const textBooks = ["claims", "description", "abstract"] as const;
type TextBlock = {
  node: ParagraphNode | HeadingNode;
  text: string;
  bookKind: PatentBookKind;
  flow: string;
  background: boolean;
};
function prose(patent: CanonicalPatent): TextBlock[] {
  const result: TextBlock[] = [];
  for (const book of patent.books) {
    if (!textBooks.some((k) => k === book.kind)) continue;
    let background = false;
    let section = 0;
    for (const top of book.document.content) {
      const heading =
        top.type === "paragraph" || top.type === "heading" ? literalText(top).trim() : "";
      if (/^(?:技术领域|背景技术|发明内容|实用新型内容|附图说明|具体实施方式)$/u.test(heading)) {
        background = heading === "背景技术";
        section++;
      }
      const visit = (blocks: readonly BlockNode[], flow: string) => {
        for (const node of blocks) {
          if (node.type === "paragraph" || node.type === "heading")
            result.push({ node, text: literalText(node), bookKind: book.kind, flow, background });
          else if (node.type === "table")
            for (const row of node.rows) for (const cell of row.cells) visit(cell.content, cell.id);
          else if (node.type === "bullet-list" || node.type === "ordered-list")
            for (const item of node.items) visit(item.content, item.id);
        }
      };
      visit([top], `${book.kind}:${section}`);
    }
  }
  return result;
}
function location(block: TextBlock, start?: number, length?: number): PatentLocation {
  return {
    bookKind: block.bookKind,
    targetId: block.node.id,
    ...(start === undefined ? {} : { startOffset: start, endOffset: start + (length ?? 1) }),
  };
}
function finding(
  code: PatentIssueCode,
  summary: string,
  locations: PatentLocation[],
  excerpt: string | null,
  recommendation: string,
  confidence: InspectionIssueDraft["confidence"] = "likely",
  severity: InspectionIssueDraft["severity"] = "warning",
  identityKey?: string,
): InspectionIssueDraft {
  return {
    legacyCode: code,
    summary,
    locations,
    evidence: locations.map((location) => ({ location, excerpt })),
    recommendation,
    confidence,
    severity,
    ...(identityKey ? { identityKey } : {}),
  };
}
function rule(
  id: string,
  category: PatentInspectionRule["category"],
  inspect: (patent: CanonicalPatent) => InspectionIssueDraft[],
  certain = false,
): PatentInspectionRule {
  return {
    id: `core.${id}`,
    version: 1,
    category,
    defaultSeverity: "warning",
    cost: "full",
    dependencies: [...textBooks, "reference-marks", "assets"],
    provenance: certain ? PRODUCT_POLICY.exportSafety : HEURISTIC_RULE,
    appliesTo: () => true,
    inspect: ({ patent }) => inspect(patent),
  };
}
function unquoted(text: string): string {
  return text.replace(/“[^”]*”|‘[^’]*’|"[^"\n]*"/gu, (match) => " ".repeat(match.length));
}
const claimsImages = rule(
  "claims.ordinary-image",
  "claims",
  (patent) => {
    const claims = patent.books.find((b) => b.kind === "claims");
    if (!claims) return [];
    return nestedBlocks(claims.document.content).flatMap((node) => {
      const images =
        node.type === "figure"
          ? [node]
          : node.type === "paragraph" || node.type === "heading"
            ? node.content.filter((n) => n.type === "inline-figure")
            : [];
      return images.map((image) =>
        finding(
          "claim-ordinary-image",
          "权利要求书中包含图片。",
          [{ bookKind: "claims", targetId: image.id }],
          null,
          "移出普通图片；公式或化学结构请使用对应插入工具。",
          "certain",
          "warning",
          image.id,
        ),
      );
    });
  },
  true,
);
const referenceNumbers = rule("reference-marks.number-mismatch", "reference-marks", (patent) => {
  const keywords = new Map(patent.referenceMarks.map((m) => [m.keyword, m.number]));
  if (!keywords.size) return [];
  const escaped = [...keywords.keys()]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const pattern = new RegExp(`(${escaped})`, "gu");
  return prose(patent)
    .filter((b) => !b.background)
    .flatMap((block) =>
      [...unquoted(block.text).matchAll(pattern)].flatMap((m) => {
        const suffix = descriptionReferenceNumberSuffix(block.text.slice(m.index + m[0].length));
        if (!suffix) return [];
        const expected = keywords.get(m[1] ?? "");
        const actual = suffix.number;
        if (expected === actual) return [];
        const excerpt = m[0] + suffix.text;
        return [
          finding(
            "reference-mark-number-mismatch",
            `“${m[1]}”标为${actual}，标记列表为${expected}。`,
            [location(block, m.index, excerpt.length)],
            excerpt,
            "核对名称与编号；引用其他文献的内容可忽略。",
          ),
        ];
      }),
    );
});
const textPairs = rule("content.text-pairs", "punctuation", (patent) => {
  const result: InspectionIssueDraft[] = [];
  const open = new Map<string, Array<{ char: string; block: TextBlock; index: number }>>();
  const pairs: Record<string, string> = { "（": "）", "(": ")", "“": "”", "‘": "’" };
  for (const block of prose(patent)) {
    const stack = open.get(block.flow) ?? [];
    open.set(block.flow, stack);
    const text = block.text
      .replace(
        /[（([]\s*[+-]?(?:\d+(?:\.\d+)?|∞)\s*[,，]\s*[+-]?(?:\d+(?:\.\d+)?|∞)\s*[）)\]]|（\s*\d+\s*）/gu,
        (m) => " ".repeat(m.length),
      )
      .replace(/(?:^|\n|[；;])[\t \u3000]*\d+\)[\t \u3000]*/gu, (m) => " ".repeat(m.length));
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (pairs[char]) stack.push({ char, block, index: i });
      else if (Object.values(pairs).includes(char)) {
        if (stack.length && pairs[stack[stack.length - 1]!.char] === char) stack.pop();
        else
          result.push(
            finding(
              "unbalanced-text-pair",
              `“${char}”缺少对应的前半符号。`,
              [location(block, i)],
              char,
              "核对括号或引号是否成对。",
            ),
          );
      }
    }
  }
  for (const stack of open.values())
    for (const item of stack)
      result.push(
        finding(
          "unbalanced-text-pair",
          `“${item.char}”缺少对应的后半符号。`,
          [location(item.block, item.index)],
          item.char,
          "核对括号或引号是否成对。",
        ),
      );
  return result;
});
const duplicateContent = rule("content.duplicate-drafting", "content", (patent) => {
  const result: InspectionIssueDraft[] = [];
  const eligible = (node: BlockNode) =>
    node.type === "paragraph" &&
    node.semanticRole !== "invention-title" &&
    !node.content.some((n) => n.type === "inline-formula" || n.type === "inline-figure");
  for (const book of patent.books) {
    if (!textBooks.some((k) => k === book.kind)) continue;
    let previous: BlockNode | null = null;
    let previousText = "";
    for (const node of book.document.content) {
      const text = eligible(node) ? visibleBlockText(node).replace(/\s+/gu, "") : "";
      if (text.length >= 40 && previous && text === previousText && !/^(?:图|表)\d+/u.test(text))
        result.push(
          finding(
            "duplicate-drafting-content",
            "相邻两段内容完全相同。",
            [
              { bookKind: book.kind, targetId: previous.id },
              { bookKind: book.kind, targetId: node.id },
            ],
            text,
            "核对是否重复粘贴；有意重复时可忽略。",
            "certain",
            "suggestion",
          ),
        );
      previous = node;
      previousText = text;
    }
    if (book.kind !== "claims") continue;
    const claims: Array<{ number: number; node: BlockNode; text: string; structured: boolean }> =
      [];
    for (const node of book.document.content) {
      const text = node.type === "paragraph" ? visibleBlockText(node).trim() : "";
      const m = text.match(/^(\d+)[.．、]\s*(.*)$/u);
      if (m)
        claims.push({ number: Number(m[1]), node, text: m[2] ?? "", structured: !eligible(node) });
      else if (claims.length) {
        claims[claims.length - 1]!.text += text;
        if (!eligible(node) && node.type !== "page-break")
          claims[claims.length - 1]!.structured = true;
      }
    }
    const seen = new Map<string, (typeof claims)[number]>();
    for (const claim of claims) {
      const normalized = claim.text.replace(/\s+/gu, "");
      if (claim.structured || normalized.length < 15) continue;
      const first = seen.get(normalized);
      if (first && first.number !== claim.number)
        result.push(
          finding(
            "duplicate-drafting-content",
            `权利要求${first.number}与${claim.number}正文完全相同。`,
            [
              { bookKind: "claims", targetId: first.node.id },
              { bookKind: "claims", targetId: claim.node.id },
            ],
            claim.text,
            "核对是否重复粘贴或遗漏限定内容。",
            "certain",
            "suggestion",
          ),
        );
      else seen.set(normalized, claim);
    }
  }
  return result;
});
const tableNumbers = rule("content.table-numbers", "reference", (patent) => {
  const result: InspectionIssueDraft[] = [];
  for (const kind of textBooks) {
    const book = patent.books.find((b) => b.kind === kind);
    if (!book) continue;
    const captions = new Map<number, BlockNode[]>();
    const blocks = book.document.content;
    const autoNumbers = tableNameNumbers(blocks);
    const captionParagraphs = new Set<string>();
    for (let i = 0; i < blocks.length; i++) {
      const node = blocks[i]!;
      const title =
        (node.type === "paragraph" || node.type === "heading") &&
        (blocks[i - 1]?.type === "table" || blocks[i + 1]?.type === "table")
          ? visibleBlockText(node).trim()
          : "";
      const match = title.match(/^表\s*(\d+)(?!\d)/u);
      const m =
        match &&
        !/^(?:所示|可见|中|的|给出|显示|列出|为|表明|反映|说明)/u.test(
          title.slice(match[0].length).trimStart(),
        )
          ? match
          : null;
      const automaticNumber = autoNumbers.get(node.id);
      if (automaticNumber === undefined && !m) continue;
      if (m) captionParagraphs.add(node.id);
      if (/续表|表\s*\d+\s*[（(]?续/u.test(title)) continue;
      const n = automaticNumber ?? Number(m?.[1]);
      const target =
        node.type === "table"
          ? node
          : blocks[i + 1]?.type === "table"
            ? blocks[i + 1]!
            : blocks[i - 1]!;
      const items = captions.get(n) ?? [];
      if (!items.some((b) => b.id === target.id)) items.push(target);
      captions.set(n, items);
    }
    for (const [number, nodes] of captions)
      if (nodes.length > 1)
        result.push(
          finding(
            "table-number-duplicate",
            `“表${number}”用于多个表格。`,
            nodes.map((n) => ({ bookKind: kind, targetId: n.id })),
            null,
            "修正表名编号；同一表的续表可忽略。",
          ),
        );
    for (const block of prose(patent).filter((b) => b.bookKind === kind && !b.background)) {
      if (captionParagraphs.has(block.node.id)) continue;
      for (const m of unquoted(block.text).matchAll(/表\s*(\d+)(?!\d)/gu)) {
        const before = block.text.slice(0, m.index).trimEnd();
        // Require a citation boundary/cue, not a suffix of a component such as 压力表1.
        if (
          /[\p{L}\p{N}]$/u.test(before) &&
          !/(?:见|如|参照|对照|根据|于|在|和|及|与|上述|下述|从|该|查)$/u.test(before)
        )
          continue;
        const after = block.text.slice((m.index ?? 0) + m[0].length);
        if (/^(?:\s*[）)]?\s*(?:个|项|行|列|mm|cm)|\s*[.．]\d)/u.test(after)) continue;
        if (!captions.has(Number(m[1])))
          result.push(
            finding(
              "table-reference-missing",
              `引用“表${m[1]}”，未找到对应编号的表格。`,
              [location(block, m.index, m[0].length)],
              m[0],
              "补充对应表名，或修正引用编号。",
            ),
          );
      }
    }
  }
  return result;
});
const mathSyntax = rule(
  "formula.syntax",
  "content",
  (patent) => {
    const result: InspectionIssueDraft[] = [];
    for (const book of patent.books)
      for (const node of nestedBlocks(book.document.content)) {
        const formulas =
          node.type === "block-formula"
            ? [node]
            : node.type === "paragraph" || node.type === "heading"
              ? node.content.filter((n) => n.type === "inline-formula")
              : [];
        for (const [index, formula] of formulas.entries()) {
          if (formula.formulaKind !== "math") continue;
          try {
            katex.renderToString(formula.source, {
              displayMode: node.type === "block-formula",
              throwOnError: true,
              strict: "warn",
              trust: false,
            });
          } catch {
            result.push(
              finding(
                "formula-invalid-syntax",
                "数学公式格式有误，无法正常显示。",
                [{ bookKind: book.kind, targetId: node.id }],
                formula.source,
                "重新编辑公式，补全括号并检查命令。",
                "certain",
                "warning",
                `${node.id}:${index}`,
              ),
            );
          }
        }
      }
    return result;
  },
  true,
);
const crossReferences = rule("content.cross-book-reference", "reference", (patent) =>
  prose(patent)
    .filter((b) => !b.background)
    .flatMap((block) => {
      const pattern =
        block.bookKind === "description"
          ? /如权利要求\s*\d+[^。；\n]{0,25}所述/gu
          : block.bookKind === "claims"
            ? /(?:如图\s*\d+[^。；\n]{0,15}所示|如说明书[^。；\n]{0,25}所述)/gu
            : null;
      if (!pattern) return [];
      return [...unquoted(block.text).matchAll(pattern)].map((m) =>
        finding(
          "cross-book-reference",
          "核对跨文档引用的表述。",
          [location(block, m.index, m[0].length)],
          m[0],
          "尽量直接写明技术内容；确有必要的引用可忽略。",
        ),
      );
    }),
);
const editingMarkers = rule("templates.editing-markers", "completeness", (patent) =>
  prose(patent).flatMap((block) => {
    const tokens = block.text.match(
      /\{\{(?:patentName|typeSelfReference|typeName|figureNumber)\}\}|【(?:待补充|待确认|待填写|待完善|待修改)】/gu,
    );
    return tokens
      ? [
          finding(
            "unfinished-editing-marker",
            `还有未处理的标记：${[...new Set(tokens)].join("、")}。`,
            [location(block)],
            block.text,
            "填写实际内容，或删除不用的标记。",
          ),
        ]
      : [];
  }),
);
export const draftingQualityRules = [
  claimsImages,
  referenceNumbers,
  textPairs,
  duplicateContent,
  tableNumbers,
  mathSyntax,
  crossReferences,
  editingMarkers,
] as const;
