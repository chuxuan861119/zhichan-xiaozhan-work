import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { APPLICATION_NAME } from "../../../shared/branding";
import type { OpenedPatent } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { createPatentSession, type PatentSession } from "./patent-reducer";
import { PatentTabs } from "./patent-tabs";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function session(index: number, name: string | null): PatentSession {
  const patent = createBlankPatent({ patentType: "invention", name });
  patent.patentId = testUuid(100 + index);
  patent.books.forEach((book, bookIndex) => {
    book.bookId = testUuid(300 + index * 10 + bookIndex);
    book.document.documentId = testUuid(400 + index * 10 + bookIndex);
  });
  const opened: OpenedPatent = {
    patentId: patent.patentId,
    sessionId: testUuid(200 + index),
    revision: 0,
    patent,
    saveState: "saved",
  };
  return createPatentSession(opened);
}

describe("patent tabs", () => {
  test("filters short saves without hiding persistent saves or failures", () => {
    vi.useFakeTimers();
    try {
      const activeSession = session(1, "绘图保存");
      const view = (state: PatentSession["aggregateSaveState"]) => (
        <PatentTabs
          sessions={[{ ...activeSession, aggregateSaveState: state }]}
          activePatentId={activeSession.patentId}
          libraryActive={false}
          onOpenLibrary={vi.fn()}
          onActivatePatent={vi.fn()}
          onRequestClose={vi.fn()}
        />
      );
      const { rerender } = render(view("saved"));
      const tab = screen.getByRole("tab", { name: "绘图保存" });
      for (let index = 0; index < 3; index++) {
        rerender(view("saving"));
        act(() => vi.advanceTimersByTime(100));
        expect(within(tab).queryByRole("status", { name: "保存中…" })).toBeNull();
        expect(tab.querySelector(".patent-type-badge")?.textContent).toBe("发明");
        rerender(view("saved"));
      }
      rerender(view("saving"));
      act(() => vi.advanceTimersByTime(600));
      expect(within(tab).getByRole("status", { name: "保存中…" })).toBeDefined();
      rerender(view("failed"));
      expect(within(tab).getByRole("status", { name: "保存失败" })).toBeDefined();
      rerender(view("saving"));
      expect(within(tab).queryByRole("status", { name: "保存中…" })).toBeNull();
      rerender(view("saved"));
      act(() => vi.advanceTimersByTime(1000));
      expect(within(tab).queryByRole("status")).toBeNull();
      expect(tab.querySelector(".patent-type-badge")?.textContent).toBe("发明");
    } finally {
      vi.useRealTimers();
    }
  });
  test.each([0, 2, 12])("keeps new patent outside the scrolling strip with %i tabs", (count) => {
    const sessions = Array.from({ length: count }, (_, index) =>
      session(index + 1, `专利 ${index + 1}`),
    );
    const onNewPatent = vi.fn();
    const { container } = render(
      <PatentTabs
        sessions={sessions}
        activePatentId={sessions[0]?.patentId ?? ""}
        libraryActive={count === 0}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
        onNewPatent={onNewPatent}
      />,
    );
    const viewport = container.querySelector<HTMLElement>(".patent-tabs__patent-viewport");
    const create = screen.getByRole("button", { name: "新建专利（加号）" });
    expect(viewport?.nextElementSibling).toBe(create);
    expect(viewport?.contains(create)).toBe(false);
    fireEvent.click(create);
    expect(onNewPatent).toHaveBeenCalledOnce();
  });

  test("tutorial tabs do not expose the library or IPC data center", () => {
    const active = session(1, "教学示例");
    render(
      <PatentTabs
        tutorialMode
        sessions={[active]}
        activePatentId={active.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
        onNewPatent={vi.fn()}
      />,
    );
    expect(screen.queryByRole("tab", { name: "专利库" })).toBeNull();
    expect(screen.queryByRole("button", { name: "IPC数据中心" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建专利（加号）" })).toBeNull();
    expect(screen.getByRole("tab", { name: "教学示例" })).toBeDefined();
  });
  test.each(["invention", "utility-model"] as const)(
    "shows the library type badge instead of a saved check for %s",
    (patentType) => {
      const activeSession = session(1, "类型标签专利");
      activeSession.patent.patentType = patentType;
      render(
        <PatentTabs
          sessions={[activeSession]}
          activePatentId={activeSession.patentId}
          libraryActive={false}
          onOpenLibrary={vi.fn()}
          onActivatePatent={vi.fn()}
          onRequestClose={vi.fn()}
        />,
      );
      const tab = screen.getByRole("tab", { name: "类型标签专利" });
      expect(tab.querySelector(`.patent-type-badge--${patentType}`)?.textContent).toBe(
        patentType === "invention" ? "发明" : "实用新型",
      );
      expect(within(tab).queryByRole("status", { name: "已保存" })).toBeNull();
      expect(tab.textContent).not.toContain("✓");
    },
  );
  test("starts a workspace drag with the patent's last active book", () => {
    const activeSession = session(1, "夹具专利");
    activeSession.activeBookKind = "description";
    const workspaceTabDrag = { start: vi.fn(), consumeClick: vi.fn(() => false) };

    render(
      <PatentTabs
        sessions={[activeSession]}
        activePatentId={activeSession.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
        workspaceTabDrag={workspaceTabDrag}
      />,
    );
    const tab = screen.getByRole("tab", { name: "夹具专利" });

    fireEvent.pointerDown(tab, { pointerId: 7, button: 0, clientX: 180, clientY: 20 });

    expect(workspaceTabDrag.start).toHaveBeenCalledWith(
      expect.objectContaining({
        pointerId: 7,
        sourceElement: tab,
        source: {
          key: `patent:${activeSession.patentId}`,
          label: "夹具专利",
          target: { patentId: activeSession.patentId, bookKind: "description" },
        },
      }),
    );
  });

  test("suppresses the click that follows a completed patent-tab drag", async () => {
    const activeSession = session(1, "夹具专利");
    const onActivatePatent = vi.fn();
    const workspaceTabDrag = { start: vi.fn(), consumeClick: vi.fn(() => true) };
    const user = userEvent.setup();

    render(
      <PatentTabs
        sessions={[activeSession]}
        activePatentId={activeSession.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={onActivatePatent}
        onRequestClose={vi.fn()}
        workspaceTabDrag={workspaceTabDrag}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "夹具专利" }));

    expect(onActivatePatent).not.toHaveBeenCalled();
  });

  test("animates a newly opened patent tab from zero width and opacity", () => {
    const originalAnimate = HTMLElement.prototype.animate;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
    HTMLElement.prototype.animate = animate;
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({
        width: 180,
        left: 0,
        right: 180,
        top: 0,
        bottom: 34,
        height: 34,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const first = session(1, "夹具专利");
    const second = session(2, "轴承专利");

    try {
      const { rerender } = render(
        <PatentTabs
          sessions={[first]}
          activePatentId={first.patentId}
          libraryActive={false}
          onOpenLibrary={vi.fn()}
          onActivatePatent={vi.fn()}
          onRequestClose={vi.fn()}
        />,
      );
      rerender(
        <PatentTabs
          sessions={[first, second]}
          activePatentId={second.patentId}
          libraryActive={false}
          onOpenLibrary={vi.fn()}
          onActivatePatent={vi.fn()}
          onRequestClose={vi.fn()}
        />,
      );

      expect(animate).toHaveBeenCalledWith(
        [
          { opacity: 0, width: "0px" },
          { opacity: 1, width: "180px" },
        ],
        expect.objectContaining({ duration: 400, easing: "ease-in-out" }),
      );
    } finally {
      HTMLElement.prototype.animate = originalAnimate;
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("requests closure without waiting for the patent tab animation", async () => {
    const originalAnimate = HTMLElement.prototype.animate;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const animate = vi.fn().mockReturnValue({ finished: new Promise(() => {}), cancel: vi.fn() });
    HTMLElement.prototype.animate = animate;
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({
        width: 180,
        left: 0,
        right: 180,
        top: 0,
        bottom: 34,
        height: 34,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const first = session(1, "夹具专利");
    const onRequestClose = vi.fn();

    try {
      const user = userEvent.setup();
      render(
        <PatentTabs
          sessions={[first]}
          activePatentId={first.patentId}
          libraryActive={false}
          onOpenLibrary={vi.fn()}
          onActivatePatent={vi.fn()}
          onRequestClose={onRequestClose}
        />,
      );
      await user.click(screen.getByRole("button", { name: "关闭夹具专利" }));

      expect(animate).toHaveBeenCalledWith(
        [
          { opacity: 1, width: "180px" },
          { opacity: 0, width: "0px" },
        ],
        expect.objectContaining({ duration: 400, easing: "ease-in-out" }),
      );
      await vi.waitFor(() => expect(onRequestClose).toHaveBeenCalledWith(first.patentId));
    } finally {
      HTMLElement.prototype.animate = originalAnimate;
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("keeps the library tab fixed at the left before all open patents", () => {
    render(
      <PatentTabs
        sessions={[session(1, "夹具专利"), session(2, "轴承专利")]}
        activePatentId={testUuid(102)}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
      />,
    );

    const topTabs = within(screen.getByRole("tablist", { name: "专利标签栏" })).getAllByRole("tab");
    expect(topTabs.map((tab) => tab.getAttribute("aria-label") ?? tab.textContent)).toEqual([
      "专利库",
      "夹具专利",
      "轴承专利",
    ]);
    expect(topTabs[0]?.classList.contains("is-fixed")).toBe(true);
    expect(within(topTabs[0] as HTMLElement).getByTitle(APPLICATION_NAME)).toBeDefined();
    expect(screen.queryByTestId("patent-color-dot")).toBeNull();
  });

  test("uses a single row without rendering five-book navigation", () => {
    const first = session(1, "夹具专利");
    const { container } = render(
      <div className="window-shell">
        <PatentTabs
          sessions={[first]}
          activePatentId={first.patentId}
          libraryActive={false}
          onOpenLibrary={vi.fn()}
          onActivatePatent={vi.fn()}
          onRequestClose={vi.fn()}
        />
      </div>,
    );

    const tabs = container.querySelector<HTMLElement>(".patent-tabs");
    expect(tabs).not.toBeNull();
    expect(tabs?.getAttribute("data-layout")).toBe("single-tier");
    expect(container.querySelector(".patent-tabs__top-row")).not.toBeNull();
    expect(container.querySelector(".patent-tabs__book-row")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "五书标签栏" })).toBeNull();
  });

  test("closes only the whole patent", async () => {
    const user = userEvent.setup();
    const first = session(1, null);
    const onRequestClose = vi.fn();

    render(
      <PatentTabs
        sessions={[first]}
        activePatentId={first.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={onRequestClose}
      />,
    );

    expect(screen.getByRole("tab", { name: "未命名专利 1" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "关闭未命名专利 1" }));
    expect(onRequestClose).toHaveBeenCalledWith(first.patentId);

    const closeButton = screen.getByRole("button", { name: "关闭未命名专利 1" });
    expect(closeButton.querySelector("svg")).not.toBeNull();
    expect(closeButton.textContent).toBe("");
  });

  test("uses a centered icon glyph for patent tab close buttons", () => {
    render(
      <PatentTabs
        sessions={[session(1, "夹具专利")]}
        activePatentId={testUuid(101)}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
      />,
    );

    const closeButton = screen.getByRole("button", { name: "关闭夹具专利" });
    expect(closeButton.querySelector("svg")).not.toBeNull();
  });

  test("shows aggregate save state on patent tabs", () => {
    const first = session(1, "保存状态专利");
    first.aggregateSaveState = "failed";

    render(
      <PatentTabs
        sessions={[first]}
        activePatentId={first.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
      />,
    );

    const patentTab = screen.getByRole("tab", { name: "保存状态专利" });
    expect(within(patentTab).getByRole("status", { name: "保存失败" })).not.toBeNull();
  });

  test("activates library and patent tabs through their own callbacks", async () => {
    const user = userEvent.setup();
    const first = session(1, "夹具专利");
    const onOpenLibrary = vi.fn();
    const onActivatePatent = vi.fn();

    render(
      <PatentTabs
        sessions={[first]}
        activePatentId=""
        libraryActive
        onOpenLibrary={onOpenLibrary}
        onActivatePatent={onActivatePatent}
        onRequestClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "专利库" }));
    await user.click(screen.getByRole("tab", { name: "夹具专利" }));

    expect(onOpenLibrary).toHaveBeenCalledOnce();
    expect(onActivatePatent).toHaveBeenCalledWith(first.patentId);
  });

  test("lists every open patent when the patent tab strip overflows", async () => {
    const user = userEvent.setup();
    const first = session(1, "夹具专利");
    const second = session(2, "轴承专利");
    const third = session(3, "电池专利");
    const fourth = session(4, "阀门专利");
    const sessions = [first, second, third, fourth];
    const onActivatePatent = vi.fn();
    const { container } = render(
      <PatentTabs
        sessions={sessions}
        activePatentId={first.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={onActivatePatent}
        onRequestClose={vi.fn()}
      />,
    );
    const viewport = container.querySelector<HTMLElement>(".patent-tabs__patent-viewport");
    expect(viewport).not.toBeNull();
    if (!viewport) throw new Error("专利标签视口未渲染。");
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 560 },
    });
    fireEvent(window, new Event("resize"));

    await user.click(screen.getByRole("button", { name: "全部专利" }));
    const menu = screen.getByRole("menu", { name: "全部已打开专利" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);

    await user.click(within(menu).getByRole("menuitem", { name: /阀门专利/u }));
    expect(onActivatePatent).toHaveBeenCalledWith(fourth.patentId);
    expect(screen.queryByRole("menu", { name: "全部已打开专利" })).toBeNull();
  });

  test("scrolls the newly activated patent tab into the visible area", () => {
    const first = session(1, "夹具专利");
    const second = session(2, "轴承专利");
    const sessions = [first, second];
    const { container, rerender } = render(
      <PatentTabs
        sessions={sessions}
        activePatentId={first.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
      />,
    );
    const viewport = container.querySelector<HTMLElement>(".patent-tabs__patent-viewport");
    const secondShell = container.querySelector<HTMLElement>(
      `[data-patent-tab-id="${second.patentId}"]`,
    );
    expect(viewport).not.toBeNull();
    expect(secondShell).not.toBeNull();
    if (!viewport || !secondShell) throw new Error("专利标签视口或目标标签未渲染。");
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 300 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    Object.defineProperties(secondShell, {
      offsetLeft: { configurable: true, value: 420 },
      offsetWidth: { configurable: true, value: 140 },
    });

    rerender(
      <PatentTabs
        sessions={sessions}
        activePatentId={second.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
      />,
    );

    expect(viewport.scrollLeft).toBe(260);
  });

  test("uses vertical mouse-wheel movement to browse patent tabs horizontally", () => {
    const first = session(1, "夹具专利");
    const { container } = render(
      <PatentTabs
        sessions={[first]}
        activePatentId={first.patentId}
        libraryActive={false}
        onOpenLibrary={vi.fn()}
        onActivatePatent={vi.fn()}
        onRequestClose={vi.fn()}
      />,
    );
    const viewport = container.querySelector<HTMLElement>(".patent-tabs__patent-viewport");
    expect(viewport).not.toBeNull();
    if (!viewport) throw new Error("专利标签视口未渲染。");
    Object.defineProperty(viewport, "scrollLeft", {
      configurable: true,
      value: 10,
      writable: true,
    });

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    viewport.dispatchEvent(wheelEvent);

    expect(viewport.scrollLeft).toBe(90);
    expect(wheelEvent.defaultPrevented).toBe(true);
  });
});
