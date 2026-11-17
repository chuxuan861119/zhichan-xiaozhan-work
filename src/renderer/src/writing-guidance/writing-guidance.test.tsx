import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { guidancePosition, visibleGuidanceTarget } from "./model";
import { GUIDANCE_TOUR_EVENT, WritingGuidance } from "./writing-guidance";

const props = {
  enabled: true,
  introductionSeen: true,
  onIntroductionSeen: vi.fn(),
  ownerKey: "patent:single",
  book: "claims" as const,
  scope: "single" as const,
  onNavigate: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      x: 20,
      y: 20,
      left: 20,
      top: 20,
      right: 120,
      bottom: 50,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function openTask() {
  fireEvent.click(screen.getByRole("button", { name: "快速工具教程" }));
  fireEvent.click(screen.getByRole("button", { name: "撰写权利要求" }));
  fireEvent.click(screen.getByRole("button", { name: "给部件登记编号" }));
}

test("numbering walkthrough waits for selection and only acknowledges scoped success", async () => {
  render(
    <>
      <div data-function-rail-scope="single">
        <div className="tiptap">底座</div>
        <button type="button" disabled data-numbering-help="sequential">
          顺序编号
        </button>
      </div>
      <WritingGuidance {...props} />
    </>,
  );
  openTask();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "带我操作" }));
  });
  expect(screen.getByText("先在正文中选中一个部件名称，例如“底座”；不要选中整句话。")).toBeTruthy();
  act(() => {
    window.dispatchEvent(
      new CustomEvent("patent-workbench:guidance-progress", {
        detail: { scope: "right", kind: "numbered", label: "底座—1" },
      }),
    );
  });
  expect(screen.queryByText("已登记：底座—1")).toBeNull();
  act(() => {
    window.dispatchEvent(
      new CustomEvent("patent-workbench:guidance-progress", {
        detail: { scope: "single", kind: "numbered", label: "底座—1" },
      }),
    );
  });
  expect(screen.getByText("已登记：底座—1")).toBeTruthy();
  expect(screen.getByRole("button", { name: "继续登记" })).toBeTruthy();
});

test("copied draft survives the intended book switch but never claims it was pasted", async () => {
  const { rerender } = render(<WritingGuidance {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "快速工具教程" }));
  fireEvent.click(screen.getByRole("button", { name: "完善说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "复用权利要求生成草稿" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "带我操作" }));
  });
  act(() => {
    window.dispatchEvent(
      new CustomEvent("patent-workbench:guidance-progress", {
        detail: { scope: "single", kind: "copied", label: "发明内容" },
      }),
    );
  });
  expect(screen.getByRole("button", { name: "去说明书粘贴" })).toBeTruthy();
  rerender(<WritingGuidance {...props} book="description" />);
  expect(
    screen.getByText(
      "已复制“发明内容”草稿，尚未写入正文。请在说明书合适位置粘贴，再核对技术内容。",
    ),
  ).toBeTruthy();
  rerender(<WritingGuidance {...props} book="description" ownerKey="other:single" />);
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("numbering reads the editor selection rather than treating enabled buttons as selection", async () => {
  const content = (text: string) => (
    <>
      <div data-function-rail-scope="single">
        <div className="tiptap">底座</div>
        <button type="button" data-numbering-help="sequential">
          顺序编号
        </button>
      </div>
      <WritingGuidance {...props} readSelection={() => text} />
    </>
  );
  const { rerender } = render(content(""));
  openTask();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "带我操作" }));
  });
  expect(screen.getByText(/先在正文中选中一个部件名称/)).toBeTruthy();
  rerender(content("底座"));
  expect(screen.getByText(/已可编号：点击/)).toBeTruthy();
  expect(screen.queryByText(/已登记：/)).toBeNull();
});

test("empty claims directs draft guidance back to writing instead of the conversion button", async () => {
  render(
    <>
      <div data-function-rail-scope="single">
        <div className="tiptap">1.</div>
        <div className="claims-description-tool">
          <button type="button">说明书</button>
        </div>
      </div>
      <WritingGuidance {...props} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "快速工具教程" }));
  fireEvent.click(screen.getByRole("button", { name: "完善说明书" }));
  fireEvent.click(screen.getByRole("button", { name: "复用权利要求生成草稿" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "带我操作" }));
  });
  expect(
    screen.getByText("先在权利要求书中写入技术方案，再生成说明书草稿；空白正文不能转换。"),
  ).toBeTruthy();
});
test("opening advice never runs a business command and changing document dismisses it", () => {
  const { rerender } = render(<WritingGuidance {...props} />);
  openTask();
  expect(props.onNavigate).not.toHaveBeenCalled();
  rerender(<WritingGuidance {...props} book="description" />);
  expect(screen.queryByRole("complementary")).toBeNull();
});
test("closing invalidates delayed navigation without reopening advice", async () => {
  let resolve: (() => void) | undefined;
  const onNavigate = vi.fn(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  render(<WritingGuidance {...props} onNavigate={onNavigate} />);
  openTask();
  fireEvent.click(screen.getByRole("button", { name: "带我操作" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭快速工具教程" }));
  await act(async () => {
    resolve?.();
  });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("claims");
});
test("first-use waits for idle, skip persists and never opens writing guide", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { rerender } = render(<WritingGuidance {...props} introductionSeen={false} />);
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByRole("complementary", { name: "首次界面介绍" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "跳过" }));
  rerender(<WritingGuidance {...props} introductionSeen={false} book="description" />);
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(props.onIntroductionSeen).toHaveBeenCalledTimes(1);
});
test("finishing first tour shows only a hint; clicking entry opens choices", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  render(<WritingGuidance {...props} introductionSeen={false} />);
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
  expect(screen.queryByText("从当前文档开始")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "快速工具教程" }));
  expect(screen.getByText("从当前文档开始")).toBeTruthy();
});
test("manual replay and Escape do not change content", () => {
  render(<WritingGuidance {...props} />);
  act(() => {
    window.dispatchEvent(new Event(GUIDANCE_TOUR_EVENT));
  });
  expect(screen.getByRole("complementary", { name: "首次界面介绍" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(props.onNavigate).not.toHaveBeenCalled();
});
test("visible targets include top toolbar but exclude hidden owners", () => {
  const { container } = render(
    <>
      <div hidden>
        <button type="button">hidden</button>
      </div>
      <button type="button">visible</button>
    </>,
  );
  expect(visibleGuidanceTarget(container, "button")?.textContent).toBe("visible");
  const p = guidancePosition(null, 326, 260, 800, 600);
  expect(p.left).toBeGreaterThanOrEqual(12);
  expect(p.left + 326).toBeLessThanOrEqual(800);
  expect(p.top + 260).toBeLessThanOrEqual(600);
});

test("dual view only points at the active pane", async () => {
  render(
    <>
      <div data-function-rail-scope="left">
        <button type="button" data-numbering-help="sequential">
          left
        </button>
      </div>
      <div data-function-rail-scope="right">
        <button type="button" data-numbering-help="sequential">
          right
        </button>
      </div>
      <WritingGuidance {...props} scope="right" />
    </>,
  );
  vi.spyOn(screen.getByText("left"), "getBoundingClientRect").mockReturnValue({
    left: 30,
    top: 180,
    right: 130,
    bottom: 210,
    width: 100,
    height: 30,
  } as DOMRect);
  vi.spyOn(screen.getByText("right"), "getBoundingClientRect").mockReturnValue({
    left: 700,
    top: 180,
    right: 800,
    bottom: 210,
    width: 100,
    height: 30,
  } as DOMRect);
  openTask();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "带我操作" }));
  });
  expect(document.querySelector<HTMLElement>(".writing-guidance-ring")?.style.left).toBe("697px");
});

test("first introduction defers to existing data safety prompts", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  render(
    <>
      <section className="data-safety-guide">Backup reminder</section>
      <WritingGuidance {...props} introductionSeen={false} />
    </>,
  );
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(props.onIntroductionSeen).not.toHaveBeenCalled();
});
test("Escape leaves a business input's cancel handling intact", () => {
  render(
    <>
      <input aria-label="business input" />
      <WritingGuidance {...props} />
    </>,
  );
  openTask();
  fireEvent.keyDown(screen.getByLabelText("business input"), { key: "Escape" });
  expect(screen.getByRole("complementary")).toBeTruthy();
});
