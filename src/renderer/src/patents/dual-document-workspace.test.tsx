import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DualDocumentWorkspace } from "./dual-document-workspace";
import { usePatentFunctionRail } from "./function-rail/function-rail-context";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function RailProbe({ label }: Readonly<{ label: string }>) {
  const rail = usePatentFunctionRail();
  return (
    <div>
      <span>{`${label}:${rail.userIntent}`}</span>
      <output
        aria-label={`${label}呈现`}
      >{`${rail.presentation.expanded}:${rail.presentation.reason}`}</output>
      <button type="button" onClick={rail.pin}>{`固定${label}`}</button>
      <button type="button" onClick={rail.collapse}>{`收起${label}`}</button>
    </div>
  );
}

function LocalStateProbe({ label }: Readonly<{ label: string }>) {
  const [count, setCount] = useState(0);
  return (
    <div>
      <span>{`${label}本地:${count}`}</span>
      <button
        type="button"
        onClick={() => setCount((current) => current + 1)}
      >{`增加${label}`}</button>
    </div>
  );
}

const leftDocument = {
  kind: "document" as const,
  targetKey: "patent-a:claims",
  patentName: "电池装置",
  bookKind: "claims" as const,
  zoomPercent: 64,
  content: (
    <div className="patent-page-with-rail">
      <main aria-label="左侧页面">权利要求正文</main>
      <aside aria-label="左侧完整功能栏">功能</aside>
      <RailProbe label="文档甲" />
      <LocalStateProbe label="文档甲" />
    </div>
  ),
};

const rightDocument = {
  kind: "document" as const,
  targetKey: "patent-b:description",
  patentName: "回收工艺",
  bookKind: "description" as const,
  zoomPercent: 58,
  content: (
    <div className="patent-page-with-rail">
      <main aria-label="右侧页面">说明书正文</main>
      <aside aria-label="右侧完整功能栏">功能</aside>
      <RailProbe label="文档乙" />
      <LocalStateProbe label="文档乙" />
    </div>
  ),
};

test("renders left pane, fixed divider, and right pane in a strict equal grid", () => {
  const { container } = render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const workspace = screen.getByRole("region", { name: "同屏双文档工作区" });
  expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1fr) auto minmax(0, 1fr)");
  expect([...workspace.children].map((child) => child.getAttribute("data-layout-part"))).toEqual([
    "left",
    "divider",
    "right",
  ]);
  expect(container.querySelector('[data-pane="left"]')?.getAttribute("data-active")).toBe("true");
  expect(container.querySelector('[data-pane="right"]')?.getAttribute("data-active")).toBe("false");
  expect(container.querySelector('[data-function-rail-scope="left"]')).toBeDefined();
  expect(container.querySelector('[data-function-rail-scope="right"]')).toBeDefined();
});

test("shows document headers and preserves page plus full rail inside each pane", () => {
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="right"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  expect(screen.getByText("电池装置 · 权利要求书")).toBeDefined();
  expect(screen.getByText("回收工艺 · 说明书")).toBeDefined();
  const leftPane = screen.getByRole("region", { name: "左侧文档" });
  expect(within(leftPane).getByRole("main", { name: "左侧页面" })).toBeDefined();
  expect(within(leftPane).getByRole("complementary", { name: "左侧完整功能栏" })).toBeDefined();
});

test("opens the document from either physical title bar on double-click", () => {
  const onOpenSinglePane = vi.fn();
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onOpenSinglePane={onOpenSinglePane}
      onSwap={vi.fn()}
    />,
  );

  const leftHeader = screen.getByRole("region", { name: "左侧文档" }).querySelector("header");
  const rightHeader = screen.getByRole("region", { name: "右侧文档" }).querySelector("header");
  expect(leftHeader).not.toBeNull();
  expect(rightHeader).not.toBeNull();

  fireEvent.doubleClick(leftHeader as HTMLElement);
  fireEvent.doubleClick(rightHeader as HTMLElement);

  expect(onOpenSinglePane.mock.calls).toEqual([["left"], ["right"]]);
});

test("ignores title-bar double-clicks for selection panes and independent controls", () => {
  const onOpenSinglePane = vi.fn();
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={{ kind: "selection", picker: <div>请选择文档</div> }}
      activePane="left"
      initialRailSpace="fits"
      switchers={{ left: <button type="button">面板内部操作</button> }}
      onActivatePane={vi.fn()}
      onClosePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onOpenSinglePane={onOpenSinglePane}
      onSwap={vi.fn()}
    />,
  );

  const rightHeader = screen.getByRole("region", { name: "右侧文档" }).querySelector("header");
  fireEvent.doubleClick(rightHeader as HTMLElement);
  fireEvent.doubleClick(screen.getByRole("button", { name: "交换左右文档" }));
  fireEvent.doubleClick(screen.getByRole("button", { name: "关闭左侧文档" }));
  const leftTriggers = within(screen.getByRole("region", { name: "左侧文档" })).getAllByRole(
    "button",
    { name: "切换左侧文档" },
  );
  fireEvent.doubleClick(leftTriggers[1] as HTMLButtonElement);
  fireEvent.click(leftTriggers[1] as HTMLButtonElement);
  fireEvent.doubleClick(screen.getByRole("button", { name: "面板内部操作" }));

  expect(onOpenSinglePane).not.toHaveBeenCalled();
});

test("completes two swaps when the second click is retargeted to the header", () => {
  const onOpenSinglePane = vi.fn();
  const onSwap = vi.fn();
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onOpenSinglePane={onOpenSinglePane}
      onSwap={onSwap}
    />,
  );

  const swapButton = screen.getByRole("button", { name: "交换左右文档" });
  const rightHeader = screen.getByRole("region", { name: "右侧文档" }).querySelector("header");
  expect(rightHeader).not.toBeNull();

  fireEvent.click(swapButton, { clientX: 320, clientY: 24, detail: 1, timeStamp: 100 });
  fireEvent.click(rightHeader as HTMLElement, {
    clientX: 320,
    clientY: 24,
    detail: 2,
    timeStamp: 150,
  });
  fireEvent.doubleClick(rightHeader as HTMLElement, {
    clientX: 320,
    clientY: 24,
    detail: 2,
    timeStamp: 150,
  });

  expect(onSwap).toHaveBeenCalledTimes(2);
  expect(onOpenSinglePane).not.toHaveBeenCalled();
});

test("delays a title click and cancels it when the title is double-clicked", () => {
  vi.useFakeTimers();
  const onOpenSinglePane = vi.fn();
  try {
    render(
      <DualDocumentWorkspace
        left={leftDocument}
        right={rightDocument}
        activePane="left"
        initialRailSpace="fits"
        switchers={{ left: <button type="button">左侧选择器内容</button> }}
        onActivatePane={vi.fn()}
        onOpenPicker={vi.fn()}
        onOpenSinglePane={onOpenSinglePane}
        onSwap={vi.fn()}
      />,
    );

    const leftTitle = screen.getByText("电池装置 · 权利要求书").closest("button");
    fireEvent.click(leftTitle as HTMLButtonElement);
    expect(screen.queryByRole("dialog", { name: "切换左侧文档" })).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog", { name: "切换左侧文档" })).toBeDefined();

    fireEvent.click(leftTitle as HTMLButtonElement);
    fireEvent.doubleClick(leftTitle as HTMLButtonElement);
    act(() => vi.advanceTimersByTime(200));

    expect(screen.queryByRole("dialog", { name: "切换左侧文档" })).toBeNull();
    expect(onOpenSinglePane).toHaveBeenCalledOnce();
    expect(onOpenSinglePane).toHaveBeenCalledWith("left");
  } finally {
    vi.useRealTimers();
  }
});

test("opens either pane switcher from its title or adjacent dropdown and keeps only one open", async () => {
  const user = userEvent.setup();
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      switchers={{
        left: <button type="button">左侧选择器内容</button>,
        right: <button type="button">右侧选择器内容</button>,
      }}
      onActivatePane={vi.fn()}
      onClosePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const leftTitle = screen.getByText("电池装置 · 权利要求书").closest("button");
  expect(leftTitle).not.toBeNull();
  await user.click(leftTitle as HTMLButtonElement);
  expect(await screen.findByRole("dialog", { name: "切换左侧文档" })).toBeDefined();
  expect(screen.getByRole("button", { name: "左侧选择器内容" })).toBeDefined();

  const rightPane = screen.getByRole("region", { name: "右侧文档" });
  const rightTriggers = within(rightPane).getAllByRole("button", { name: "切换右侧文档" });
  expect(rightTriggers).toHaveLength(2);
  await user.click(rightTriggers[1] as HTMLButtonElement);
  expect(screen.queryByRole("dialog", { name: "切换左侧文档" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "切换右侧文档" })).toBeDefined();
});

test("dismisses a switcher outside without changing documents and keeps inside interactions open", async () => {
  const user = userEvent.setup();
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      switchers={{ left: <button type="button">面板内部操作</button> }}
      onActivatePane={vi.fn()}
      onClosePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const leftTitle = screen.getByText("电池装置 · 权利要求书").closest("button");
  await user.click(leftTitle as HTMLButtonElement);
  await screen.findByRole("dialog", { name: "切换左侧文档" });
  await user.click(screen.getByRole("button", { name: "面板内部操作" }));
  expect(screen.getByRole("dialog", { name: "切换左侧文档" })).toBeDefined();

  await user.click(document.body);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换左侧文档" })).toBeNull());
  expect(screen.getByText("电池装置 · 权利要求书")).toBeDefined();
  expect(screen.getByText("回收工艺 · 说明书")).toBeDefined();
});

test("dismisses a switcher with Escape and restores focus to the trigger", async () => {
  const user = userEvent.setup();
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      switchers={{ left: <button type="button">面板内部操作</button> }}
      onActivatePane={vi.fn()}
      onClosePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const leftPane = screen.getByRole("region", { name: "左侧文档" });
  const leftDropdown = within(leftPane).getAllByRole("button", {
    name: "切换左侧文档",
  })[1] as HTMLButtonElement;
  await user.click(leftDropdown);
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "切换左侧文档" })).toBeNull();
    expect(document.activeElement).toBe(leftDropdown);
  });
});

test("closes an open switcher when that pane target changes", async () => {
  const user = userEvent.setup();
  const commonProps = {
    right: rightDocument,
    activePane: "left" as const,
    initialRailSpace: "fits" as const,
    switchers: { left: <button type="button">面板内部操作</button> },
    onActivatePane: vi.fn(),
    onClosePane: vi.fn(),
    onOpenPicker: vi.fn(),
    onSwap: vi.fn(),
  };
  const { rerender } = render(<DualDocumentWorkspace {...commonProps} left={leftDocument} />);

  await user.click(screen.getByText("电池装置 · 权利要求书").closest("button") as HTMLElement);
  expect(await screen.findByRole("dialog", { name: "切换左侧文档" })).toBeDefined();

  rerender(
    <DualDocumentWorkspace
      {...commonProps}
      left={{ ...leftDocument, targetKey: "patent-c:claims", patentName: "新装置" }}
    />,
  );
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换左侧文档" })).toBeNull());
});

test("routes each far-right close control to its physical pane", async () => {
  const user = userEvent.setup();
  const onClosePane = vi.fn();
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onClosePane={onClosePane}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "关闭左侧文档" }));
  await user.click(screen.getByRole("button", { name: "关闭右侧文档" }));
  expect(onClosePane.mock.calls).toEqual([["left"], ["right"]]);
});

test("renders the dual document swap control with a two-stroke linear icon", () => {
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const button = screen.getByRole("button", { name: "交换左右文档" });
  const icon = button.querySelector("svg.dual-document-pane__swap-icon");

  expect(icon).not.toBeNull();
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(icon?.querySelectorAll("path")).toHaveLength(2);
  expect(button.textContent?.trim()).toBe("");
});

test("places the swap button in the physical right header and dispatches the pane swap", async () => {
  const user = userEvent.setup();
  const onSwap = vi.fn();
  const { rerender } = render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={onSwap}
    />,
  );
  const leftPage = screen.getByRole("main", { name: "左侧页面" });
  const divider = screen.getByRole("separator", { name: "双文档分隔线" });
  const rightHeader = screen.getByRole("region", { name: "右侧文档" }).querySelector("header");
  expect(
    within(divider.closest(".dual-document-divider") as HTMLElement).queryByRole("button"),
  ).toBeNull();
  const swapButton = within(rightHeader as HTMLElement).getByRole("button", {
    name: "交换左右文档",
  });
  await user.click(swapButton);
  expect(onSwap).toHaveBeenCalledOnce();

  rerender(
    <DualDocumentWorkspace
      left={rightDocument}
      right={leftDocument}
      activePane="right"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={onSwap}
    />,
  );
  expect(screen.getByRole("main", { name: "左侧页面" })).not.toBe(leftPage);
});

test("animates only the two compositor panes while suppressing live editor motion", async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalAnimate = HTMLElement.prototype.animate;
  const originalGetAnimations = HTMLElement.prototype.getAnimations;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const cancelLiveAnimation = vi.fn();
  const cancelGhostAnimation = vi.fn();
  const onSwap = vi.fn();
  const pendingFrames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  let finishAnimations: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finishAnimations = resolve;
  });
  const animate = vi.fn().mockReturnValue({ cancel: cancelGhostAnimation, finished });

  HTMLElement.prototype.getBoundingClientRect = function () {
    const pane = this.closest<HTMLElement>("[data-pane]");
    const left = pane?.dataset.pane === "right" ? 500 : 0;
    return {
      x: left,
      y: 0,
      top: 0,
      right: left + 480,
      bottom: 700,
      left,
      width: 480,
      height: 700,
      toJSON: () => ({}),
    };
  };
  HTMLElement.prototype.animate = animate;
  HTMLElement.prototype.getAnimations = vi
    .fn()
    .mockReturnValue([{ cancel: cancelLiveAnimation } as unknown as Animation]);
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    pendingFrames.set(frameId, (time) => {
      pendingFrames.delete(frameId);
      callback(time);
    });
    return frameId;
  });
  window.cancelAnimationFrame = vi.fn((frameId: number) => {
    pendingFrames.delete(frameId);
  });

  function SwapHarness() {
    const [swapped, setSwapped] = useState(false);
    return (
      <DualDocumentWorkspace
        left={swapped ? rightDocument : leftDocument}
        right={swapped ? leftDocument : rightDocument}
        activePane={swapped ? "right" : "left"}
        initialRailSpace="fits"
        onActivatePane={vi.fn()}
        onOpenPicker={vi.fn()}
        onSwap={() => {
          onSwap();
          setSwapped((current) => !current);
        }}
      />
    );
  }

  try {
    render(<SwapHarness />);
    const leftBody = screen
      .getByRole("region", { name: "左侧文档" })
      .querySelector<HTMLElement>(".dual-document-pane__body");
    if (leftBody) leftBody.scrollTop = 42;
    fireEvent.click(screen.getByRole("button", { name: "交换左右文档" }));

    expect(animate).toHaveBeenCalledTimes(2);
    expect(onSwap).not.toHaveBeenCalled();
    expect(cancelLiveAnimation).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("dual-pane-swap-motion")).toBe(true);
    expect(document.querySelector(".dual-pane-swap-ghost-layer")).not.toBeNull();
    expect(
      document.querySelector<HTMLElement>(
        '.dual-pane-swap-ghost-layer [data-swap-ghost="left"] .dual-document-pane__body',
      )?.scrollTop,
    ).toBe(42);
    expect(screen.getByRole("region", { name: "同屏双文档工作区" }).dataset.swapContentHidden).toBe(
      "true",
    );
    expect(animate.mock.calls.map(([frames]) => frames)).toEqual(
      expect.arrayContaining([
        [{ transform: "translateX(0)" }, { transform: "translateX(500px)" }],
        [{ transform: "translateX(0)" }, { transform: "translateX(-500px)" }],
      ]),
    );

    const firstFrame = pendingFrames.values().next().value;
    expect(firstFrame).toBeDefined();
    await act(async () => firstFrame?.(16));
    expect(onSwap).not.toHaveBeenCalled();
    const secondFrame = pendingFrames.values().next().value;
    expect(secondFrame).toBeDefined();
    await act(async () => secondFrame?.(32));
    expect(onSwap).toHaveBeenCalledOnce();
    expect(cancelLiveAnimation).toHaveBeenCalledOnce();
    expect(cancelGhostAnimation).not.toHaveBeenCalled();

    finishAnimations?.();
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dual-pane-swap-motion")).toBe(false),
    );
    expect(document.querySelector(".dual-pane-swap-ghost-layer")).toBeNull();
  } finally {
    document.documentElement.classList.remove("dual-pane-swap-motion");
    document.querySelector(".dual-pane-swap-ghost-layer")?.remove();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    HTMLElement.prototype.animate = originalAnimate;
    if (originalGetAnimations) HTMLElement.prototype.getAnimations = originalGetAnimations;
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("automatically slides documents that cross panes after an external layout change", async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.getBoundingClientRect = function () {
    const pane = this.closest<HTMLElement>("[data-pane]");
    const left = pane?.dataset.pane === "right" ? 500 : 0;
    return {
      x: left,
      y: 0,
      top: 0,
      right: left + 480,
      bottom: 700,
      left,
      width: 480,
      height: 700,
      toJSON: () => ({}),
    };
  };
  HTMLElement.prototype.animate = animate;

  try {
    const props = {
      activePane: "left" as const,
      initialRailSpace: "fits" as const,
      onActivatePane: vi.fn(),
      onOpenPicker: vi.fn(),
      onSwap: vi.fn(),
    };
    const { rerender } = render(
      <DualDocumentWorkspace {...props} left={leftDocument} right={rightDocument} />,
    );
    animate.mockClear();

    rerender(<DualDocumentWorkspace {...props} left={rightDocument} right={leftDocument} />);

    await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
    expect(animate).toHaveBeenCalledWith(
      [
        expect.objectContaining({ transform: expect.stringContaining("translateX(") }),
        { transform: "translateX(0)" },
      ],
      expect.objectContaining({ duration: 400, easing: "ease-in-out" }),
    );
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("does not start inverse pane animations when equivalent views rerender during a swap", async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  let animationTransformsVisible = false;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const pane = this.closest<HTMLElement>("[data-pane]");
    const physicalLeft = pane?.dataset.pane === "right" ? 500 : 0;
    const left = animationTransformsVisible ? 500 - physicalLeft : physicalLeft;
    return {
      x: left,
      y: 0,
      top: 0,
      right: left + 480,
      bottom: 700,
      left,
      width: 480,
      height: 700,
      toJSON: () => ({}),
    };
  };
  HTMLElement.prototype.animate = animate;

  try {
    const props = {
      activePane: "left" as const,
      initialRailSpace: "fits" as const,
      onActivatePane: vi.fn(),
      onOpenPicker: vi.fn(),
      onSwap: vi.fn(),
    };
    const { rerender } = render(
      <DualDocumentWorkspace {...props} left={leftDocument} right={rightDocument} />,
    );
    animate.mockClear();

    rerender(<DualDocumentWorkspace {...props} left={rightDocument} right={leftDocument} />);
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));

    animationTransformsVisible = true;
    rerender(
      <DualDocumentWorkspace {...props} left={{ ...rightDocument }} right={{ ...leftDocument }} />,
    );

    expect(animate).toHaveBeenCalledTimes(2);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("uses the current pane distance when the workspace width changes before a swap", async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  let rightPaneLeft = 500;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const pane = this.closest<HTMLElement>("[data-pane]");
    const left = pane?.dataset.pane === "right" ? rightPaneLeft : 0;
    return {
      x: left,
      y: 0,
      top: 0,
      right: left + 480,
      bottom: 700,
      left,
      width: 480,
      height: 700,
      toJSON: () => ({}),
    };
  };
  HTMLElement.prototype.animate = animate;

  try {
    const props = {
      activePane: "left" as const,
      initialRailSpace: "fits" as const,
      onActivatePane: vi.fn(),
      onOpenPicker: vi.fn(),
      onSwap: vi.fn(),
    };
    const { rerender } = render(
      <DualDocumentWorkspace {...props} left={leftDocument} right={rightDocument} />,
    );
    animate.mockClear();

    rightPaneLeft = 800;
    rerender(
      <DualDocumentWorkspace {...props} left={{ ...leftDocument }} right={{ ...rightDocument }} />,
    );
    rerender(<DualDocumentWorkspace {...props} left={rightDocument} right={leftDocument} />);

    await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
    expect(animate.mock.calls.map(([frames]) => frames)).toEqual(
      expect.arrayContaining([
        [{ transform: "translateX(800px)" }, { transform: "translateX(0)" }],
        [{ transform: "translateX(-800px)" }, { transform: "translateX(0)" }],
      ]),
    );
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("fades and lifts a replacement document without scaling the page", async () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  const replacement = {
    ...leftDocument,
    targetKey: "patent-a:abstract",
    bookKind: "abstract" as const,
    content: <main aria-label="替换页面">摘要正文</main>,
  };

  try {
    const props = {
      right: rightDocument,
      activePane: "left" as const,
      initialRailSpace: "fits" as const,
      onActivatePane: vi.fn(),
      onOpenPicker: vi.fn(),
      onSwap: vi.fn(),
    };
    const { rerender } = render(<DualDocumentWorkspace {...props} left={leftDocument} />);
    animate.mockClear();

    rerender(<DualDocumentWorkspace {...props} left={replacement} />);

    await waitFor(() =>
      expect(animate).toHaveBeenCalledWith(
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        expect.objectContaining({ duration: 400 }),
      ),
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("fades a selected document into a pane that showed the picker without scaling the page", async () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;

  const commonProps = {
    left: leftDocument,
    activePane: "right" as const,
    initialRailSpace: "fits" as const,
    onActivatePane: vi.fn(),
    onOpenPicker: vi.fn(),
    onSwap: vi.fn(),
  };

  try {
    const { rerender } = render(
      <DualDocumentWorkspace
        {...commonProps}
        right={{ kind: "selection", picker: <div>请选择文档</div> }}
      />,
    );
    rerender(<DualDocumentWorkspace {...commonProps} right={rightDocument} />);

    await waitFor(() =>
      expect(animate).toHaveBeenCalledWith(
        [{ opacity: 0 }, { opacity: 1 }],
        expect.objectContaining({ duration: 400 }),
      ),
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("activates a pane before pointer and focus events continue and allows a picker opposite a document", () => {
  const onActivatePane = vi.fn();
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={{ kind: "selection", picker: <div>请选择文档</div> }}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={onActivatePane}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const rightPane = screen.getByRole("region", { name: "右侧文档" });
  const pointerEvent = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  fireEvent(rightPane, pointerEvent);
  expect(onActivatePane).toHaveBeenLastCalledWith("right");
  expect(pointerEvent.defaultPrevented).toBe(false);

  onActivatePane.mockClear();
  fireEvent.keyDown(document, { key: "Tab" });
  fireEvent.focusIn(rightPane);
  expect(onActivatePane).toHaveBeenCalledWith("right");
  expect(within(rightPane).getAllByText("请选择文档")).toHaveLength(2);
  expect(screen.getByRole("main", { name: "左侧页面" })).toBeDefined();
});

test("uses the first plain click in an inactive text pane only to activate it when a selection is retained", () => {
  const onActivatePane = vi.fn();
  const onPreserveSelectionPointer = vi.fn();
  const onRestoreRetainedSelection = vi.fn();
  const onEditorMouseDown = vi.fn();
  const hasNonEmptyTextSelection = vi.fn(
    (editorId: string) => editorId === "session-b:description",
  );
  const rightTextDocument = {
    ...rightDocument,
    editorId: "session-b:description",
    content: (
      <div data-patent-text-projection="session-b:description">
        <div data-patent-editor-id="session-b:description">已选中的说明书正文</div>
      </div>
    ),
  };
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightTextDocument}
      activePane="left"
      initialRailSpace="fits"
      hasNonEmptyTextSelection={hasNonEmptyTextSelection}
      onPreserveSelectionPointer={onPreserveSelectionPointer}
      onRestoreRetainedSelection={onRestoreRetainedSelection}
      onActivatePane={onActivatePane}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const editor = screen.getByText("已选中的说明书正文");
  editor.addEventListener("mousedown", onEditorMouseDown);
  const pointerEvent = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 29,
  });
  fireEvent(editor, pointerEvent);
  const mouseEvent = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  fireEvent(editor, mouseEvent);

  expect(hasNonEmptyTextSelection).toHaveBeenCalledWith("session-b:description");
  expect(onActivatePane).toHaveBeenCalledWith("right");
  expect(onPreserveSelectionPointer).toHaveBeenCalledWith(29);
  expect(onRestoreRetainedSelection).toHaveBeenCalledWith("session-b:description");
  expect(pointerEvent.defaultPrevented).toBe(true);
  expect(mouseEvent.defaultPrevented).toBe(true);
  expect(onEditorMouseDown).not.toHaveBeenCalled();
});

test("keeps normal pointer behavior when the inactive text pane has no retained selection", () => {
  const onActivatePane = vi.fn();
  const rightTextDocument = {
    ...rightDocument,
    editorId: "session-b:description",
    content: (
      <div data-patent-text-projection="session-b:description">
        <div data-patent-editor-id="session-b:description">普通说明书正文</div>
      </div>
    ),
  };
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightTextDocument}
      activePane="left"
      initialRailSpace="fits"
      hasNonEmptyTextSelection={() => false}
      onActivatePane={onActivatePane}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const pointerEvent = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  fireEvent(screen.getByText("普通说明书正文"), pointerEvent);

  expect(onActivatePane).toHaveBeenCalledWith("right");
  expect(pointerEvent.defaultPrevented).toBe(false);
});

test("does not consume controls in an inactive text pane even when text is selected", () => {
  const onActivatePane = vi.fn();
  const rightTextDocument = {
    ...rightDocument,
    editorId: "session-b:description",
    content: (
      <div data-patent-text-projection="session-b:description">
        <button type="button">说明书操作</button>
      </div>
    ),
  };
  render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightTextDocument}
      activePane="left"
      initialRailSpace="fits"
      hasNonEmptyTextSelection={() => true}
      onActivatePane={onActivatePane}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  const pointerEvent = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  fireEvent(screen.getByRole("button", { name: "说明书操作" }), pointerEvent);

  expect(onActivatePane).toHaveBeenCalledWith("right");
  expect(pointerEvent.defaultPrevented).toBe(false);
});

test("keeps independent manual rail state in each physical pane across document changes and swaps", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "固定文档甲" }));
  await user.click(screen.getByRole("button", { name: "收起文档乙" }));
  await user.click(screen.getByRole("button", { name: "增加文档甲" }));
  expect(screen.getByText("文档甲:pinned")).toBeDefined();
  expect(screen.getByText("文档乙:collapsed")).toBeDefined();
  expect(screen.getByText("文档甲本地:1")).toBeDefined();

  const replacementLeft = {
    ...leftDocument,
    targetKey: "patent-c:claims",
    content: (
      <div className="patent-page-with-rail">
        <main aria-label="替换页面">替换正文</main>
        <aside aria-label="替换功能栏">功能</aside>
        <RailProbe label="文档丙" />
        <LocalStateProbe label="文档丙" />
      </div>
    ),
  };
  rerender(
    <DualDocumentWorkspace
      left={replacementLeft}
      right={rightDocument}
      activePane="left"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );
  expect(screen.getByText("文档丙:pinned")).toBeDefined();
  expect(screen.getByText("文档乙:collapsed")).toBeDefined();
  expect(screen.getByText("文档丙本地:0")).toBeDefined();

  await user.click(screen.getByRole("button", { name: "增加文档丙" }));
  expect(screen.getByText("文档丙本地:1")).toBeDefined();

  rerender(
    <DualDocumentWorkspace
      left={rightDocument}
      right={replacementLeft}
      activePane="right"
      initialRailSpace="fits"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );
  expect(screen.getByText("文档乙:pinned")).toBeDefined();
  expect(screen.getByText("文档丙:collapsed")).toBeDefined();
  expect(screen.getByText("文档乙本地:0")).toBeDefined();
  expect(screen.getByText("文档丙本地:0")).toBeDefined();
});

test("rebuilds pane content when switching between a document and its picker without rebuilding the rail scope", async () => {
  const user = userEvent.setup();
  const props = {
    right: rightDocument,
    activePane: "left" as const,
    initialRailSpace: "fits" as const,
    onActivatePane: vi.fn(),
    onOpenPicker: vi.fn(),
    onSwap: vi.fn(),
  };
  const { rerender } = render(<DualDocumentWorkspace {...props} left={leftDocument} />);

  await user.click(screen.getByRole("button", { name: "固定文档甲" }));
  await user.click(screen.getByRole("button", { name: "增加文档甲" }));

  rerender(
    <DualDocumentWorkspace
      {...props}
      left={{
        kind: "selection",
        picker: (
          <div className="patent-page-with-rail">
            <main>选择器</main>
            <aside>选择功能</aside>
            <RailProbe label="选择器" />
            <LocalStateProbe label="选择器" />
          </div>
        ),
      }}
    />,
  );

  expect(screen.getByText("选择器:pinned")).toBeDefined();
  expect(screen.getByText("选择器本地:0")).toBeDefined();

  rerender(<DualDocumentWorkspace {...props} left={leftDocument} />);
  expect(screen.getByText("文档甲:pinned")).toBeDefined();
  expect(screen.getByText("文档甲本地:0")).toBeDefined();
});

test("routes an external tool request only to its target pane", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="left"
      initialRailSpace="constrained"
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "收起文档甲" }));
  await user.click(screen.getByRole("button", { name: "收起文档乙" }));

  rerender(
    <DualDocumentWorkspace
      left={leftDocument}
      right={rightDocument}
      activePane="right"
      initialRailSpace="constrained"
      toolIdsByPane={{ left: ["find-replace"] }}
      onActivatePane={vi.fn()}
      onOpenPicker={vi.fn()}
      onSwap={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("文档甲呈现").textContent).toBe("true:tool");
  expect(screen.getByLabelText("文档乙呈现").textContent).toBe("false:manual-collapse");
});

/** jsdom 不做布局，拖动分隔线时需要显式给出工作区宽度。 */
function mockWorkspaceRect(width: number): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 700,
    width,
    height: 700,
    toJSON: () => ({}),
  });
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

function dividerElement(container: HTMLElement): HTMLElement {
  const divider = container.querySelector<HTMLElement>('[data-layout-part="divider"]');
  if (!divider) throw new Error("未找到双文档分隔线");
  return divider;
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  init: PointerEventInit,
): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, ...init });
}

const dualProps = {
  activePane: "left" as const,
  initialRailSpace: "fits" as const,
  onActivatePane: vi.fn(),
  onOpenPicker: vi.fn(),
  onSwap: vi.fn(),
};

test("drags the central divider to resize both documents in one gesture", () => {
  const restoreRect = mockWorkspaceRect(2015);
  try {
    const { container } = render(
      <DualDocumentWorkspace {...dualProps} left={leftDocument} right={rightDocument} />,
    );
    const workspace = screen.getByRole("region", { name: "同屏双文档工作区" });
    const divider = dividerElement(container);
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1fr) auto minmax(0, 1fr)");
    expect(workspace.getAttribute("data-split-resizing")).toBe("false");

    fireEvent(divider, pointer("pointerdown", { button: 0, clientX: 500 }));
    expect(divider.getAttribute("data-split-resizing")).toBe("true");
    expect(workspace.getAttribute("data-split-resizing")).toBe("true");

    // 2000px 可分栏宽、向右拖 240px：左栏 50% → 62%，两侧宽度同时变化。
    fireEvent(divider, pointer("pointermove", { buttons: 1, clientX: 740 }));
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1.24fr) auto minmax(0, 0.76fr)");
    expect(screen.getByRole("main", { name: "左侧页面" })).toBeDefined();
    expect(screen.getByRole("main", { name: "右侧页面" })).toBeDefined();

    fireEvent(divider, pointer("pointerup", { button: 0, clientX: 740 }));
    expect(divider.getAttribute("data-split-resizing")).toBe("false");
    expect(workspace.getAttribute("data-split-resizing")).toBe("false");
  } finally {
    restoreRect();
  }
});

test("marks the divider as snapped while a drag settles on the equal split", () => {
  const restoreRect = mockWorkspaceRect(2015);
  try {
    const { container } = render(
      <DualDocumentWorkspace {...dualProps} left={leftDocument} right={rightDocument} />,
    );
    const divider = dividerElement(container);
    // 没拖动时不带吸附特效，避免一进双屏就被当成"已吸住"。
    expect(divider.getAttribute("data-split-snapped")).toBe("false");

    fireEvent(divider, pointer("pointerdown", { button: 0, clientX: 500 }));
    // 起点本来就是等宽：按下即给出"已吸住"的反馈。
    expect(divider.getAttribute("data-split-snapped")).toBe("true");

    // 从等宽起步立即跟随，不设置 20px 死区。
    fireEvent(divider, pointer("pointermove", { buttons: 1, clientX: 519 }));
    expect(divider.getAttribute("data-split-snapped")).toBe("false");

    // 拖到明显的非等宽位置后松手。
    fireEvent(divider, pointer("pointermove", { buttons: 1, clientX: 740 }));
    expect(divider.getAttribute("data-split-snapped")).toBe("false");

    // 同一次手势离开吸附区后再拖回中心附近，也应重新吸住。
    fireEvent(divider, pointer("pointermove", { buttons: 1, clientX: 519 }));
    expect(divider.getAttribute("data-split-snapped")).toBe("true");
    fireEvent(divider, pointer("pointerup", { button: 0, clientX: 519 }));

    expect(divider.getAttribute("data-split-snapped")).toBe("false");
  } finally {
    restoreRect();
  }
});

test("stops a hard divider drag from collapsing either document", () => {
  const restoreRect = mockWorkspaceRect(2015);
  try {
    const { container } = render(
      <DualDocumentWorkspace {...dualProps} left={leftDocument} right={rightDocument} />,
    );
    const workspace = screen.getByRole("region", { name: "同屏双文档工作区" });
    const divider = dividerElement(container);

    fireEvent(divider, pointer("pointerdown", { button: 0, clientX: 500 }));
    fireEvent(divider, pointer("pointermove", { buttons: 1, clientX: 3000 }));
    // 每侧至少 528px：上限 73.6%。
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1.472fr) auto minmax(0, 0.528fr)");

    fireEvent(divider, pointer("pointermove", { buttons: 1, clientX: -3000 }));
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 0.528fr) auto minmax(0, 1.472fr)");
  } finally {
    restoreRect();
  }
});

test("restores an equal split when the divider is double-clicked", () => {
  const restoreRect = mockWorkspaceRect(2015);
  try {
    const { container } = render(
      <DualDocumentWorkspace {...dualProps} left={leftDocument} right={rightDocument} />,
    );
    const workspace = screen.getByRole("region", { name: "同屏双文档工作区" });
    const divider = dividerElement(container);

    fireEvent(divider, pointer("pointerdown", { button: 0, clientX: 500 }));
    fireEvent(divider, pointer("pointermove", { buttons: 1, clientX: 300 }));
    fireEvent(divider, pointer("pointerup", { button: 0, clientX: 300 }));
    expect(workspace.style.gridTemplateColumns).not.toBe("minmax(0, 1fr) auto minmax(0, 1fr)");

    fireEvent.doubleClick(divider);
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1fr) auto minmax(0, 1fr)");
  } finally {
    restoreRect();
  }
});

test("adjusts the split from the keyboard with 2%/10% steps and Home", () => {
  const restoreRect = mockWorkspaceRect(2015);
  try {
    const { container } = render(
      <DualDocumentWorkspace {...dualProps} left={leftDocument} right={rightDocument} />,
    );
    const workspace = screen.getByRole("region", { name: "同屏双文档工作区" });
    const divider = screen.getByRole("separator", { name: "双文档分隔线" });
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    expect(divider.getAttribute("aria-valuetext")).toBe("左侧 50%，右侧 50%");
    expect(dividerElement(container)).toBe(divider);

    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1.04fr) auto minmax(0, 0.96fr)");

    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1.24fr) auto minmax(0, 0.76fr)");
    expect(divider.getAttribute("aria-valuenow")).toBe("62");
    expect(divider.getAttribute("aria-valuetext")).toBe("左侧 62%，右侧 38%");

    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1.2fr) auto minmax(0, 0.8fr)");

    fireEvent.keyDown(divider, { key: "Home" });
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1fr) auto minmax(0, 1fr)");
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
  } finally {
    restoreRect();
  }
});

test("keeps the dragged split when the documents swap sides", () => {
  const restoreRect = mockWorkspaceRect(2015);
  try {
    const { container, rerender } = render(
      <DualDocumentWorkspace {...dualProps} left={leftDocument} right={rightDocument} />,
    );
    const workspace = screen.getByRole("region", { name: "同屏双文档工作区" });
    const divider = dividerElement(container);

    fireEvent(divider, pointer("pointerdown", { button: 0, clientX: 500 }));
    fireEvent(divider, pointer("pointermove", { buttons: 1, clientX: 740 }));
    fireEvent(divider, pointer("pointerup", { button: 0, clientX: 740 }));

    rerender(
      <DualDocumentWorkspace
        {...dualProps}
        left={rightDocument}
        right={leftDocument}
        activePane="right"
      />,
    );
    // 分栏属于物理中线，交换文档内容不改变两侧宽度。
    expect(workspace.style.gridTemplateColumns).toBe("minmax(0, 1.24fr) auto minmax(0, 0.76fr)");
  } finally {
    restoreRect();
  }
});
