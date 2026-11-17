import { type JSONContent, Node } from "@tiptap/core";
import { PATENT_TEMPLATE_TOKENS } from "../../../shared/patent/templates";

const TOKEN_LABELS = new Map<string, string>([
  [PATENT_TEMPLATE_TOKENS.patentName, "专利题目"],
  [PATENT_TEMPLATE_TOKENS.typeSelfReference, "本发明/本实用新型"],
  [PATENT_TEMPLATE_TOKENS.typeName, "发明/实用新型"],
  [PATENT_TEMPLATE_TOKENS.figureNumber, "图号"],
]);
const TOKEN_PATTERN = /\{\{[A-Za-z][A-Za-z0-9]*\}\}/gu;

export const TemplateTokenChips = Node.create({
  name: "templateToken",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  marks: "_",

  addAttributes() {
    return {
      token: {
        default: PATENT_TEMPLATE_TOKENS.patentName,
        parseHTML: (element) => element.getAttribute("data-template-token"),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-template-token]" }];
  },

  renderHTML({ node }) {
    const token = String(node.attrs.token);
    return [
      "span",
      {
        class: "template-catalog__token-chip",
        "data-template-token": token,
        "aria-label": `${TOKEN_LABELS.get(token) ?? "动态字段"}动态字段`,
        contenteditable: "false",
      },
    ];
  },

  renderText({ node }) {
    return String(node.attrs.token);
  },
});

export function templateTokensToNodes(content: JSONContent): JSONContent {
  if (
    (content.type === "heading" || content.type === "paragraph") &&
    content.content?.every((node) => node.type === "text")
  ) {
    const title = content.content.map((node) => node.text ?? "").join("");
    if (title === "发明内容" || title === "实用新型内容") {
      const prefixLength = title.length - "内容".length;
      const first = content.content[0];
      const marks = first?.marks ?? [];
      const boldMarks = marks.some((mark) => mark.type === "bold")
        ? marks
        : [...marks, { type: "bold" }];
      let offset = 0;
      const suffix = content.content.flatMap((node) => {
        const text = node.text ?? "";
        const start = Math.max(0, prefixLength - offset);
        offset += text.length;
        if (start >= text.length) return [];
        const nodeMarks = node.marks ?? [];
        return [
          {
            ...node,
            text: text.slice(start),
            marks: nodeMarks.some((mark) => mark.type === "bold")
              ? nodeMarks
              : [...nodeMarks, { type: "bold" }],
          },
        ];
      });
      return {
        ...content,
        content: [
          {
            type: "templateToken",
            attrs: { token: PATENT_TEMPLATE_TOKENS.typeName },
            marks: boldMarks,
          },
          ...suffix,
        ],
      };
    }
  }
  if (content.type === "text" && content.text) {
    const children: JSONContent[] = [];
    let offset = 0;
    for (const match of content.text.matchAll(TOKEN_PATTERN)) {
      const token = match[0];
      const index = match.index ?? 0;
      if (!TOKEN_LABELS.has(token)) continue;
      if (index > offset) children.push({ ...content, text: content.text.slice(offset, index) });
      if (token === PATENT_TEMPLATE_TOKENS.typeSelfReference) {
        children.push({ ...content, text: "本" });
      }
      children.push({
        type: "templateToken",
        attrs: {
          token:
            token === PATENT_TEMPLATE_TOKENS.typeSelfReference
              ? PATENT_TEMPLATE_TOKENS.typeName
              : token,
        },
        ...(content.marks ? { marks: content.marks } : {}),
      });
      offset = index + token.length;
    }
    if (children.length === 0) return structuredClone(content);
    if (offset < content.text.length) {
      children.push({ ...content, text: content.text.slice(offset) });
    }
    return { type: "template-token-fragment", content: children };
  }
  const transformedChildren = (content.content ?? []).flatMap((child) => {
    const transformed = templateTokensToNodes(child);
    return transformed.type === "template-token-fragment"
      ? (transformed.content ?? [])
      : [transformed];
  });
  return {
    ...content,
    ...(content.content ? { content: transformedChildren } : {}),
  };
}

export function templateTokenNodesToText(content: JSONContent): JSONContent {
  if (content.type === "templateToken") {
    return {
      type: "text",
      text: String(content.attrs?.token ?? ""),
      ...(content.marks ? { marks: content.marks } : {}),
    };
  }
  const transformedChildren = content.content?.map((child) => templateTokenNodesToText(child));
  const mergedChildren = transformedChildren?.reduce<JSONContent[]>((result, child) => {
    const previous = result.at(-1);
    const haveMatchingMarks =
      JSON.stringify(previous?.marks ?? []) === JSON.stringify(child.marks ?? []);
    if (previous?.type === "text" && child.type === "text" && haveMatchingMarks) {
      previous.text = `${previous.text ?? ""}${child.text ?? ""}`;
      return result;
    }
    result.push(child);
    return result;
  }, []);
  return {
    ...content,
    ...(mergedChildren ? { content: mergedChildren } : {}),
  };
}
