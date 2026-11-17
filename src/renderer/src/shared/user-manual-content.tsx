import { Fragment, type ReactNode } from "react";
import guide from "../../../../docs/user-guide.md?raw";
import { isAgentCliAvailable, isNetworkAiAvailable } from "../../../shared/platform";

// Only our bundled Markdown subset is supported. Never interpret manual text as HTML.
export const manualChapters = guide
  .split(/^## /m)
  .slice(1)
  .filter((text) => /^\d+\. /.test(text))
  .map((text) => {
    const [heading = "", ...body] = text.trim().split("\n");
    const [intro = "", ...sections] = body.join("\n").split(/^### /m);
    return {
      title: heading.replace(/^\d+\. /, "").trim(),
      intro: intro.trim(),
      sections: sections.map((section) => {
        const [title = "", ...content] = section.trim().split("\n");
        return { title: title.trim(), content: content.join("\n").trim() };
      }),
    };
  });

// Book pages are addressed by feature, not by a long chapter of unrelated tools.
export const manualPages = manualChapters.flatMap((chapter, chapterIndex) => {
  const sections = chapter.sections.filter((section) => section.title !== "连续对话");
  const pages = sections.map((section) => ({
    chapterIndex,
    title: section.title === "小栈AI助手：开始对话" ? "小栈AI助手" : section.title,
    sections:
      section.title === "小栈AI助手：开始对话"
        ? [section, ...chapter.sections.filter((item) => item.title === "连续对话")]
        : [section],
    intro: "",
  }));
  if (chapter.intro)
    pages.unshift({ chapterIndex, title: chapter.title, sections: [], intro: chapter.intro });
  return pages;
});

export function manualEntry<T>(entries: readonly T[], index: number): T {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`使用手册内容索引无效：${index}`);
  return entry;
}

function Inline({ text }: { text: string }) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: immutable bundled text fragments.
    <Fragment key={index}>
      {part.startsWith("`") ? (
        <code>{part.slice(1, -1)}</code>
      ) : part.startsWith("**") ? (
        <strong>{part.slice(2, -2)}</strong>
      ) : (
        part
      )}
    </Fragment>
  ));
}

export function ManualText({ text }: { text: string }) {
  const content = isNetworkAiAvailable()
    ? text
    : text
        .replaceAll(
          "AI 功能需要单独配置；不配置 AI 不影响常规写作。",
          "鸿蒙首发暂未开放联网 AI，常规编辑、保存和本地检查可正常使用。",
        )
        .replaceAll("本地检查、AI纠错、小栈AI助手等", "本地检查")
        .replaceAll("模板、显示、快捷键、AI、数据保护和迁移", "模板、显示、快捷键、数据保护和迁移")
        .replaceAll("附图排序及智能辅助", "附图排序及本地检查")
        .replaceAll(
          "AI密钥、外部备份目录、打印机等与当前电脑有关的设置不迁移。",
          "外部备份目录、打印机等与当前电脑有关的设置不迁移。",
        )
        .replaceAll(
          "重新配置 AI密钥、备份目录、打印机等本机选项。",
          "重新配置备份目录、打印机等本机选项。",
        )
        .replaceAll("；AI功能还需要有效配置和连接许可", "");
  return content
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block, index) => {
      const lines = block
        .trim()
        .split("\n")
        .map((line) => line.trim());
      let content: ReactNode;
      if (lines.every((line) => /^\|.*\|$/.test(line))) {
        const rows = lines
          .filter((line) => !/^\|[\s:|-]+\|$/.test(line))
          .map((line) =>
            line
              .slice(1, -1)
              .split("|")
              .map((cell) => cell.trim()),
          )
          .filter(
            (row) =>
              (row[0] !== "Agent CLI" || isAgentCliAvailable()) &&
              (row[0] !== "AI 设置" || isNetworkAiAvailable()),
          );
        content = (
          <div className="manual-table">
            <table>
              <thead>
                <tr>
                  {manualEntry(rows, 0).map((cell) => (
                    <th key={cell} scope="col">
                      <Inline text={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(1).map((row) => (
                  <tr key={row.join("|")}>
                    {row.map((cell, cellIndex) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: immutable table cells may share text.
                      <td key={cellIndex}>
                        <Inline text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      } else if (lines.every((line) => /^\d+\. /.test(line))) {
        content = (
          <ol>
            {lines.map((line) => (
              <li key={line}>
                <Inline text={line.replace(/^\d+\. /, "")} />
              </li>
            ))}
          </ol>
        );
      } else if (lines.every((line) => line.startsWith("- "))) {
        content = (
          <ul>
            {lines.map((line) => (
              <li key={line}>
                <Inline text={line.slice(2)} />
              </li>
            ))}
          </ul>
        );
      } else if (lines.every((line) => line.startsWith(">"))) {
        content = (
          <blockquote>
            {lines
              .filter((line) => line !== ">")
              .map((line) => (
                <p key={line}>
                  <Inline text={line.replace(/^>\s?/, "")} />
                </p>
              ))}
          </blockquote>
        );
      } else {
        content = (
          <p>
            <Inline text={lines.join("\n")} />
          </p>
        );
      }
      // biome-ignore lint/suspicious/noArrayIndexKey: immutable blocks have no local state.
      return <Fragment key={index}>{content}</Fragment>;
    });
}
