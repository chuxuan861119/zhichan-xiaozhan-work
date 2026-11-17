import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../../../shared/document/defaults";
import { ClaimsToDescriptionPanel } from "./claims-to-description-panel";

const rich = (text: string) =>
  text.split("\n").map((line) => ({
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text" as const, text: line, marks: [] }],
  }));

const prepared = {
  ok: true as const,
  text: "一种装置。",
  paragraphs: rich("一种装置。"),
  targetNodeId: "heading-1",
  claimCount: 1,
};
test("renders converted paragraphs separately for first-line indentation", () => {
  const { onPrepare, writeText } = setup();
  onPrepare.mockReturnValue({
    ...prepared,
    text: "第一段。\n第二段。",
    paragraphs: rich("第一段。\n第二段。"),
  });
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "发明内容" }));
  const region = screen.getByRole("region", { name: "处理后的文字" });
  expect(Array.from(region.querySelectorAll("p"), (p) => p.textContent)).toEqual([
    "第一段。",
    "第二段。",
  ]);
  expect(writeText).not.toHaveBeenCalled();
});
function setup() {
  const onOpenSettings = vi.fn();
  const writeText = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("patentApi", { clipboard: { writeText } });
  const onPrepare = vi.fn().mockReturnValue(prepared);
  const onCopied = vi.fn();
  const onFeedback = vi.fn();
  const view = render(
    <ClaimsToDescriptionPanel
      onOpenSettings={onOpenSettings}
      onPrepare={onPrepare}
      onCopied={onCopied}
      onFeedback={onFeedback}
    />,
  );
  return { onOpenSettings, writeText, onPrepare, onCopied, onFeedback, ...view };
}

test("guidance receives copied progress only after successful clipboard writing", async () => {
  const { container, writeText } = setup();
  container.setAttribute("data-function-rail-scope", "left");
  const progress = vi.fn();
  window.addEventListener("patent-workbench:guidance-progress", progress);
  try {
    writeText.mockResolvedValue({ ok: false, error: { message: "无法复制" } });
    fireEvent.click(screen.getByRole("button", { name: "说明书" }));
    fireEvent.click(screen.getByRole("button", { name: "发明内容" }));
    expect(progress).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制并跳转" }));
    });
    expect(progress).not.toHaveBeenCalled();
    writeText.mockResolvedValue({ ok: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制并跳转" }));
    });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0]?.[0].detail).toEqual({
      scope: "left",
      kind: "copied",
      label: "发明内容",
    });
  } finally {
    window.removeEventListener("patent-workbench:guidance-progress", progress);
  }
});

test("closes when scrolling clips the trigger but stays open while it is visible", () => {
  const { container } = setup();
  container.style.overflowY = "auto";
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 250, 150));
  const toggle = screen.getByRole("button", { name: "说明书" });
  const rect = vi
    .spyOn(toggle, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(10, 120, 180, 40));
  fireEvent.click(toggle);
  fireEvent.scroll(container);
  expect(screen.queryByRole("region", { name: "转为说明书" })).not.toBeNull();
  rect.mockReturnValue(new DOMRect(10, 40, 180, 40));
  fireEvent.scroll(container);
  expect(screen.queryByRole("region", { name: "转为说明书" })).toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

test("renders dropdown outside the clipping toolbar and keeps pointer actions usable", () => {
  const { container, onOpenSettings } = setup();
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  const panel = screen.getByRole("region", { name: "转为说明书" });
  expect(container.contains(panel)).toBe(false);
  const settings = screen.getByRole("button", { name: "发明内容设置" });
  fireEvent.pointerDown(settings);
  expect(screen.getByRole("region", { name: "转为说明书" })).toBe(panel);
  fireEvent.click(settings);
  expect(onOpenSettings).toHaveBeenCalledOnce();
});

test("opens settings beside invention content without converting", () => {
  const { onOpenSettings, onPrepare } = setup();
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "发明内容设置" }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
  expect(onPrepare).not.toHaveBeenCalled();
});
afterEach(() => vi.unstubAllGlobals());
test("shows a compact dropdown without drafting guidance and closes outside or on Escape", () => {
  setup();
  const toggle = screen.getByRole("button", { name: "说明书" });
  expect(toggle.getAttribute("data-menu-open")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("data-menu-open")).toBe("true");
  expect(screen.queryByText("转换后的文字为三段式写法，建议进一步优化调整")).toBeNull();
  expect(screen.getByRole("button", { name: "发明内容设置" }).parentElement).toBe(
    screen.getByRole("button", { name: "发明内容" }).parentElement,
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(toggle.getAttribute("data-menu-open")).toBe("false");
  expect(screen.queryByRole("button", { name: "发明内容" })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("button", { name: "发明内容" })).toBeNull();
  expect(screen.queryByText("转换全文并复制，随后前往对应章节。正文不会自动改动。")).toBeNull();
  expect(screen.queryByText("粘贴前请复核技术内容及各项方案的关系。")).toBeNull();
});
test("starts collapsed and copies the selected mode before navigating", async () => {
  const { onPrepare, writeText, onCopied } = setup();
  expect(screen.queryByRole("button", { name: "发明内容" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "发明内容" }));
  expect(screen.getByRole("dialog", { name: "发明内容预览" })).toBeTruthy();
  expect(screen.getByText(prepared.text)).toBeTruthy();
  expect(writeText).not.toHaveBeenCalled();
  expect(onCopied).not.toHaveBeenCalled();
  onPrepare.mockReturnValue({ ...prepared, text: "不同的内容" });
  fireEvent.click(screen.getByRole("button", { name: "复制并跳转" }));
  await waitFor(() =>
    expect(onCopied).toHaveBeenCalledExactlyOnceWith("invention-content", "heading-1"),
  );
  expect(onPrepare).toHaveBeenCalledExactlyOnceWith("invention-content");
  expect(writeText).toHaveBeenCalledExactlyOnceWith({
    paragraphs: prepared.paragraphs,
    style: "formatted-draft",
  });
});
test("copies text with no jump target and explains the skipped navigation", async () => {
  const { onPrepare, writeText, onCopied, onFeedback } = setup();
  onPrepare.mockReturnValue({ ...prepared, targetNodeId: null });
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "发明内容" }));
  fireEvent.click(screen.getByRole("button", { name: "复制并跳转" }));
  await waitFor(() => expect(onCopied).toHaveBeenCalledExactlyOnceWith("invention-content", null));
  expect(writeText).toHaveBeenCalledOnce();
  expect(onFeedback).toHaveBeenCalledWith(
    expect.objectContaining({
      tone: "success",
      message: "说明书里没有唯一的“发明内容”标题，已跳过跳转。",
    }),
  );
});
test("validation failures leave clipboard and navigation alone", async () => {
  const { onPrepare, writeText, onCopied, onFeedback } = setup();
  onPrepare.mockReturnValue({ ok: false, message: "编号冲突" });
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "具体实施方式" }));
  await waitFor(() =>
    expect(onFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error", message: "编号冲突" }),
    ),
  );
  expect(writeText).not.toHaveBeenCalled();
  expect(onCopied).not.toHaveBeenCalled();
});
test.each(["response", "rejection"])("clipboard %s failure never navigates", async (kind) => {
  const { writeText, onCopied, onFeedback } = setup();
  if (kind === "response")
    writeText.mockResolvedValue({ ok: false, error: { message: "无法复制" } });
  else writeText.mockRejectedValue(new Error("剪贴板不可用"));
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "发明内容" }));
  fireEvent.click(screen.getByRole("button", { name: "复制并跳转" }));
  await waitFor(() =>
    expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" })),
  );
  expect(onCopied).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "发明内容预览" })).toBeTruthy();
  writeText.mockResolvedValue({ ok: true });
  fireEvent.click(screen.getByRole("button", { name: "复制并跳转" }));
  await waitFor(() => expect(onCopied).toHaveBeenCalledOnce());
});
test("prevents repeated actions and late navigation after leaving", async () => {
  const { writeText, onCopied, unmount } = setup();
  let resolve!: (result: { ok: true }) => void;
  writeText.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "发明内容" }));
  fireEvent.click(screen.getByRole("button", { name: "复制并跳转" }));
  fireEvent.click(screen.getByRole("button", { name: "正在复制…" }));
  expect(writeText).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => resolve({ ok: true }));
  expect(onCopied).not.toHaveBeenCalled();
});

test("does not navigate from a cached book that was hidden while copying", async () => {
  const { writeText, onCopied, container } = setup();
  let resolve!: (result: { ok: true }) => void;
  writeText.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "发明内容" }));
  fireEvent.click(screen.getByRole("button", { name: "复制并跳转" }));
  container.hidden = true;
  await act(async () => resolve({ ok: true }));
  expect(onCopied).not.toHaveBeenCalled();
});

test.each(["取消", "关闭具体实施方式预览"])(
  "preview %s leaves clipboard and navigation untouched",
  (label) => {
    const { writeText, onCopied } = setup();
    fireEvent.click(screen.getByRole("button", { name: "说明书" }));
    fireEvent.click(screen.getByRole("button", { name: "具体实施方式" }));
    expect(screen.getByRole("dialog", { name: "具体实施方式预览" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  },
);
