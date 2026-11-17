import { act, renderHook, waitFor } from "@testing-library/react";
import { useToolbarOverflow } from "./use-toolbar-overflow";

test("moves an AI action and its notice together without creating a notice-only overflow command", () => {
  const toolbar = document.createElement("div");
  toolbar.innerHTML =
    '<div class="tool-group optional-tools"><div class="ai-experimental-entry"><button aria-label="AI 纠错"></button><button class="ai-experimental-badge" aria-label="AI 纠错实验功能说明"></button></div></div><button class="more-tools"></button>';
  Object.defineProperty(toolbar, "clientWidth", { value: 10 });
  const group = toolbar.firstElementChild as HTMLElement;
  Object.defineProperty(group, "offsetWidth", {
    get: () => (group.querySelector(".ai-experimental-entry[data-overflow-hidden]") ? 0 : 100),
  });
  document.body.append(toolbar);
  const { result, unmount } = renderHook(() => useToolbarOverflow({ current: toolbar }, true));
  expect(result.current).toEqual(["AI 纠错"]);
  expect(group.querySelector(".ai-experimental-entry")?.hasAttribute("data-overflow-hidden")).toBe(
    true,
  );
  unmount();
  toolbar.remove();
});

test("keeps command placement stable when selection changes availability", () => {
  const toolbar = document.createElement("div");
  toolbar.style.padding = "0 10px";
  toolbar.style.columnGap = "6px";
  const style = document.createElement("style");
  style.textContent = "[data-overflow-hidden] { display: none !important; }";
  document.head.append(style);
  const fixed = document.createElement("div");
  Object.defineProperty(fixed, "offsetWidth", { value: 200 });
  const commands = document.createElement("div");
  commands.className = "tool-group optional-tools";
  // 前两个是"置灰不可用"的工具（附图书册里的一大批），后两个仍然可用。
  for (const [label, disabled] of [
    ["下标", true],
    ["上标", true],
    ["左对齐", false],
    ["居中", false],
  ] as const) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", label);
    if (disabled) button.setAttribute("aria-disabled", "true");
    commands.append(button);
  }
  Object.defineProperty(commands, "offsetWidth", {
    get: () => {
      const count = commands.querySelectorAll("button:not([data-overflow-hidden])").length;
      return count * 32 + Math.max(0, count - 1) * 3;
    },
  });
  const more = document.createElement("button");
  more.className = "more-tools";
  Object.defineProperty(more, "offsetWidth", { value: 32 });
  Object.defineProperty(toolbar, "clientWidth", { value: 360 });
  toolbar.append(fixed, commands, more);
  document.body.append(toolbar);
  try {
    const { result, unmount } = renderHook(() => useToolbarOverflow({ current: toolbar }, true));
    // Availability must never change which suffix is placed in the more menu.
    expect(result.current).toEqual(["左对齐", "居中"]);
    expect(commands.querySelectorAll("button:not([data-overflow-hidden])")).toHaveLength(2);
    const positions = Array.from(commands.children, (button) =>
      button.hasAttribute("data-overflow-hidden"),
    );
    for (const button of Array.from(commands.children))
      button.setAttribute("aria-disabled", "false");
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current).toEqual(["左对齐", "居中"]);
    expect(
      Array.from(commands.children, (button) => button.hasAttribute("data-overflow-hidden")),
    ).toEqual(positions);
    for (const button of Array.from(commands.children))
      button.setAttribute("aria-disabled", "true");
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current).toEqual(["左对齐", "居中"]);
    expect(
      Array.from(commands.children, (button) => button.hasAttribute("data-overflow-hidden")),
    ).toEqual(positions);
    unmount();
  } finally {
    toolbar.remove();
    style.remove();
  }
});

test("keeps the largest prefix, reserves more-button space, and restores commands on resize", () => {
  const toolbar = document.createElement("div");
  toolbar.style.padding = "0 10px";
  toolbar.style.columnGap = "6px";
  const style = document.createElement("style");
  style.textContent = "[data-overflow-hidden] { display: none !important; }";
  document.head.append(style);
  const fixed = document.createElement("div");
  Object.defineProperty(fixed, "offsetWidth", { value: 200 });
  const commands = document.createElement("div");
  commands.className = "tool-group optional-tools";
  for (const label of ["下标", "上标", "左对齐", "居中"]) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", label);
    commands.append(button);
  }
  Object.defineProperty(commands, "offsetWidth", {
    get: () => {
      const count = commands.querySelectorAll("button:not([data-overflow-hidden])").length;
      return count * 32 + Math.max(0, count - 1) * 3;
    },
  });
  const more = document.createElement("button");
  more.className = "more-tools";
  Object.defineProperty(more, "offsetWidth", { value: 32 });
  let availableWidth = 360;
  Object.defineProperty(toolbar, "clientWidth", { get: () => availableWidth });
  toolbar.append(fixed, commands, more);
  document.body.append(toolbar);
  try {
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useToolbarOverflow({ current: toolbar }, enabled),
      { initialProps: { enabled: true } },
    );
    // 200 + 67 + 32 + 12 gap + 20 padding = 331; three commands need 366.
    expect(result.current).toEqual(["左对齐", "居中"]);
    availableWidth = 363; // All four fit without the more button.
    // Full row is 200 + 137 + 6 + 20 = 363.
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current).toEqual([]);
    availableWidth = 300;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current).toEqual(["上标", "左对齐", "居中"]);
    rerender({ enabled: false });
    expect(result.current).toEqual([]);
    expect(commands.querySelector("[data-overflow-hidden]")).toBeNull();
    unmount();
  } finally {
    toolbar.remove();
    style.remove();
  }
});

test("remeasures when a contextual toolbar group becomes visible or hidden", async () => {
  const toolbar = document.createElement("div");
  toolbar.style.padding = "0 10px";
  toolbar.style.columnGap = "6px";
  const style = document.createElement("style");
  style.textContent = "[data-overflow-hidden] { display: none !important; }";
  document.head.append(style);
  const fixed = document.createElement("div");
  Object.defineProperty(fixed, "offsetWidth", { value: 200 });
  const commands = document.createElement("div");
  commands.className = "tool-group optional-tools";
  for (const label of ["查找", "替换"]) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", label);
    commands.append(button);
  }
  Object.defineProperty(commands, "offsetWidth", {
    get: () => {
      const count = commands.querySelectorAll("button:not([data-overflow-hidden])").length;
      return count * 32 + Math.max(0, count - 1) * 3;
    },
  });
  const contextual = document.createElement("div");
  contextual.hidden = true;
  Object.defineProperty(contextual, "offsetWidth", { value: 100 });
  const more = document.createElement("button");
  more.className = "more-tools";
  Object.defineProperty(more, "offsetWidth", { value: 32 });
  Object.defineProperty(toolbar, "clientWidth", { value: 380 });
  toolbar.append(fixed, commands, contextual, more);
  document.body.append(toolbar);
  try {
    const { result, unmount } = renderHook(() => useToolbarOverflow({ current: toolbar }, true));
    expect(result.current).toEqual([]);

    act(() => {
      contextual.hidden = false;
    });
    await waitFor(() => expect(result.current).toEqual(["查找", "替换"]));

    act(() => {
      contextual.hidden = true;
    });
    await waitFor(() => expect(result.current).toEqual([]));
    expect(commands.querySelector("[data-overflow-hidden]")).toBeNull();
    unmount();
  } finally {
    toolbar.remove();
    style.remove();
  }
});

test("counts and collapses toolbar groups inside display-contents motion wrappers", () => {
  const toolbar = document.createElement("div");
  toolbar.style.padding = "0 10px";
  toolbar.style.columnGap = "6px";
  const style = document.createElement("style");
  style.textContent = "[data-overflow-hidden] { display: none !important; }";
  document.head.append(style);
  const fixed = document.createElement("div");
  Object.defineProperty(fixed, "offsetWidth", { value: 200 });
  const commands = document.createElement("div");
  commands.className = "tool-group optional-tools";
  for (const label of ["查找", "替换"]) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", label);
    commands.append(button);
  }
  Object.defineProperty(commands, "offsetWidth", { value: 67 });
  const motionWrapper = document.createElement("div");
  motionWrapper.style.display = "contents";
  const separator = document.createElement("div");
  Object.defineProperty(separator, "offsetWidth", { value: 1 });
  const formulas = document.createElement("div");
  formulas.className = "tool-group optional-tools";
  for (const label of ["公式 1", "公式 2", "公式 3", "公式 4"]) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", label);
    formulas.append(button);
  }
  Object.defineProperty(formulas, "offsetWidth", {
    get: () => {
      const count = formulas.querySelectorAll("button:not([data-overflow-hidden])").length;
      return count * 32 + Math.max(0, count - 1) * 3;
    },
  });
  motionWrapper.append(separator, formulas);
  const more = document.createElement("button");
  more.className = "more-tools";
  Object.defineProperty(more, "offsetWidth", { value: 32 });
  const popupWrapper = document.createElement("div");
  popupWrapper.style.display = "contents";
  const popup = document.createElement("div");
  popup.style.position = "fixed";
  Object.defineProperty(popup, "offsetWidth", { value: 176 });
  popupWrapper.append(popup);
  Object.defineProperty(toolbar, "clientWidth", { value: 380 });
  toolbar.append(fixed, commands, motionWrapper, more, popupWrapper);
  document.body.append(toolbar);
  try {
    const { result, unmount } = renderHook(() => useToolbarOverflow({ current: toolbar }, true));
    expect(result.current).toEqual(["公式 2", "公式 3", "公式 4"]);
    expect(formulas.querySelectorAll("button:not([data-overflow-hidden])")).toHaveLength(1);
    unmount();
  } finally {
    toolbar.remove();
    style.remove();
  }
});
