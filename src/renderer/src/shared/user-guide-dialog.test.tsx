import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { UserGuideDialog } from "./user-guide-dialog";
import { manualPages } from "./user-manual-content";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each(["openharmony", "ohos"])(
  "%s manual omits CLI navigation and sequential pages",
  (platform) => {
    vi.stubGlobal("documentFontPlatform", platform);
    render(<UserGuideDialog onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Agent CLI" })).toBeNull();
    const next = screen.getByRole("button", { name: "下一页" });
    let visited = 1;
    while (!next.hasAttribute("disabled") && visited <= manualPages.length) {
      fireEvent.click(next);
      expect(screen.getByRole("article").textContent).not.toContain("zxw agent");
      expect(screen.getByRole("article").textContent).not.toContain("Agent CLI");
      expect(screen.getByRole("article").textContent).not.toContain("AI 设置");
      expect(screen.getByRole("article").textContent).not.toContain("重新配置 AI");
      expect(screen.getByRole("article").textContent).not.toContain("AI纠错");
      expect(screen.getByRole("article").textContent).not.toContain("小栈AI助手");
      visited++;
    }
    expect(visited).toBeLessThan(manualPages.length);
    expect(screen.getByRole("article").textContent).toContain(manualPages.at(-1)!.title);
  },
);

test.each(["Win32", "MacIntel"])("%s retains the CLI manual", (platform) => {
  vi.stubGlobal("documentFontPlatform", platform);
  render(<UserGuideDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Agent CLI" }));
  fireEvent.click(screen.getByRole("button", { name: "选择授权范围" }));
  expect(screen.getByRole("article").textContent).toContain("无需逐步批准");
  fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
  fireEvent.click(screen.getByRole("button", { name: "软件设置概览" }));
  expect(screen.getByRole("article").textContent).toContain("本机 Agent 接入、授权范围和任务");
});
test("directory uses concise labels while feature pages retain their full titles", () => {
  render(<UserGuideDialog onClose={() => {}} />);
  const chapter = screen.getByRole("button", { name: "权利要求与说明书辅助写作" });
  expect(chapter.textContent).toBe("权利要求与说明书");
  const editing = screen.getByRole("button", { name: "文字编辑与格式整理" });
  expect(editing.textContent).toBe("文字与格式");
  fireEvent.click(editing);
  fireEvent.click(screen.getByRole("button", { name: "结构标尺、字数与缩放" }));
  expect(screen.getByRole("heading", { name: "结构标尺、字数与缩放", level: 3 })).toBeDefined();
});
test("guide reuses modeless drag and all corner resize handles without locking the editor", () => {
  const close = vi.fn();
  render(
    <>
      <input aria-label="正文" />
      <UserGuideDialog onClose={close} />
    </>,
  );
  const dialog = screen.getByRole("dialog", { name: "使用手册" });
  expect(dialog.getAttribute("aria-modal")).toBe("false");
  expect(dialog.querySelector(".dialog-titlebar--draggable")).not.toBeNull();
  for (const corner of ["n", "e", "s", "w", "se", "sw", "ne", "nw"])
    expect(dialog.querySelector(`.dialog-resize--${corner}`)).not.toBeNull();
  const editor = screen.getByRole("textbox", { name: "正文" });
  editor.focus();
  fireEvent.change(editor, { target: { value: "继续编辑" } });
  expect(document.activeElement).toBe(editor);
  expect(editor.closest("[inert]")).toBeNull();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭使用手册" }));
  expect(close).toHaveBeenCalledOnce();
});

test("manual uses a full logo viewport rather than the cropped corner image", () => {
  render(<UserGuideDialog onClose={() => {}} />);
  const brand = screen.getByRole("article").querySelector("svg.manual-brand");
  expect(brand).not.toBeNull();
  expect(brand?.getAttribute("preserveAspectRatio")).toBe("xMaxYMid meet");
  expect(brand?.querySelector("image")).not.toBeNull();
});

test("book directory opens one feature page, with real comparison images and tables", () => {
  render(<UserGuideDialog onClose={() => {}} />);
  const navigation = screen.getByRole("navigation", { name: "手册目录" });
  expect(screen.getByRole("heading", { name: "快速上手", level: 3 })).toBeDefined();
  fireEvent.click(within(navigation).getByRole("button", { name: "第一次使用" }));
  expect(screen.getByRole("article").querySelector("ol")).not.toBeNull();
  fireEvent.click(within(navigation).getByRole("button", { name: "文字编辑与格式整理" }));
  fireEvent.click(within(navigation).getByRole("button", { name: "清除多余格式" }));
  expect(screen.getByRole("heading", { name: "清除多余格式", level: 3 })).toBeDefined();
  expect(within(screen.getByRole("article")).queryByText("选区工具栏")).toBeNull();
  expect(screen.getByRole("img", { name: /清理前：/ })).toBeDefined();
  expect(screen.getByRole("img", { name: /清理后：/ })).toBeDefined();
  expect(screen.getByRole("table")).toBeDefined();
  const article = screen.getByRole("article");
  article.scrollTop = 300;
  fireEvent.click(within(navigation).getByRole("button", { name: "默认模板" }));
  fireEvent.click(within(navigation).getByRole("button", { name: "模板来源" }));
  expect(article.scrollTop).toBe(0);
  expect(screen.getByText(/最多五个/)).toBeDefined();
  expect(
    within(navigation).getByRole("button", { name: "模板来源" }).getAttribute("aria-current"),
  ).toBe("page");
});

test("manual shows AI privacy and preserves text selection without exposing old guide content", () => {
  render(<UserGuideDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "AI纠错与小栈AI助手" }));
  fireEvent.click(screen.getByRole("button", { name: "AI纠错" }));
  fireEvent.click(screen.getByRole("button", { name: "AI纠错实验功能说明" }));
  expect(screen.getByRole("dialog", { name: "AI纠错实验功能说明" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "关闭实验功能说明" }));
  expect(screen.getByRole("figure", { name: "AI综合检查示例" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "小栈AI助手" }));
  expect(screen.getByRole("button", { name: "小栈AI助手实验功能说明" }).textContent).toBe(
    "实验功能",
  );
  expect(screen.getByRole("note", { name: "AI使用提醒" }).textContent).toContain(
    "文档或选中的文字",
  );
  expect(screen.getByText("连续对话")).toBeDefined();
  expect(screen.queryByRole("switch", { name: "详细介绍" })).toBeNull();
  expect(screen.queryByText("使用概览")).toBeNull();
});

test("updated manual exposes Agent permissions, CAD and content search in the software reader", () => {
  render(<UserGuideDialog onClose={() => {}} />);
  const navigation = screen.getByRole("navigation", { name: "手册目录" });
  fireEvent.click(within(navigation).getByRole("button", { name: "Agent CLI" }));
  fireEvent.click(within(navigation).getByRole("button", { name: "选择授权范围" }));
  expect(screen.getByRole("article").textContent).toContain("无需逐步批准");
  fireEvent.click(within(navigation).getByRole("button", { name: "附图、附图说明与附图标记" }));
  fireEvent.click(within(navigation).getByRole("button", { name: "CAD标号：导入与编辑" }));
  expect(screen.getByRole("heading", { level: 3, name: "CAD标号：导入与编辑" })).toBeDefined();
  expect(screen.getByRole("article").textContent).toContain("导入和编辑 DWG/DXF");
  expect(screen.getByRole("article").textContent).not.toContain("不是 CAD 建模或 DWG 回写工具");
  fireEvent.click(within(navigation).getByRole("button", { name: "CAD标号：预览与插入" }));
  expect(screen.getByRole("article").textContent).toContain("导出 DWG");
  fireEvent.click(within(navigation).getByRole("button", { name: "管理专利库" }));
  fireEvent.click(within(navigation).getByRole("button", { name: "搜索五书正文" }));
  expect(screen.getByRole("article").textContent).toContain("搜索正文");
});

test("book pagination visits every feature with correct boundary and directory selection", () => {
  render(<UserGuideDialog onClose={() => {}} />);
  const previous = screen.getByRole("button", { name: "上一页" });
  const next = screen.getByRole("button", { name: "下一页" });
  expect(previous.hasAttribute("disabled")).toBe(true);
  for (let index = 0; index < manualPages.length; index++) {
    expect(
      screen.getByRole("heading", { level: 3, name: manualPages[index]?.title ?? "" }),
    ).toBeDefined();
    expect(screen.getByLabelText("手册页码").textContent).toBe(
      `${index + 1} / ${manualPages.length}`,
    );
    expect(
      Array.from(screen.getByRole("navigation").querySelectorAll('[aria-current="page"]')).filter(
        (element) => !element.closest("[inert]"),
      ),
    ).toHaveLength(1);
    if (index < manualPages.length - 1) fireEvent.click(next);
  }
  expect(next.hasAttribute("disabled")).toBe(true);
  fireEvent.click(previous);
  expect(
    screen.getByRole("heading", { level: 3, name: manualPages.at(-2)?.title ?? "" }),
  ).toBeDefined();
});

test("Harmony manual omits unavailable AI and CLI chapters", () => {
  vi.stubGlobal("documentFontPlatform", "ohos");
  try {
    render(<UserGuideDialog onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "AI纠错与小栈AI助手" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Agent CLI" })).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
