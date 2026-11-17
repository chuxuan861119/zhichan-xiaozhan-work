import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CustomDualViewPreset } from "../../../shared/settings/custom-dual-view";
import { PatentSplitControls } from "./patent-split-controls";

test("places the independent single-document column toggle before split view", async () => {
  const onToggleColumns = vi.fn();
  render(
    <PatentSplitControls
      active={false}
      drawingsAvailable
      onToggle={vi.fn()}
      onSelectPair={vi.fn()}
      columnsActive
      onToggleColumns={onToggleColumns}
    />,
  );
  const buttons = screen.getAllByRole("button");
  expect(buttons.slice(0, 2).map((button) => button.textContent)).toEqual(["双列显示", "同屏双显"]);
  await userEvent.click(screen.getByRole("button", { name: "双列显示" }));
  expect(onToggleColumns).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "双列显示" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("keeps the main toggle independent from the quick-pair menu", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  const onSelectPair = vi.fn();
  render(
    <PatentSplitControls
      active={false}
      drawingsAvailable
      onToggle={onToggle}
      onSelectPair={onSelectPair}
    />,
  );

  const toggle = screen.getByRole("button", { name: "同屏双显" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await user.click(toggle);

  expect(onToggle).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu", { name: "常用双文档搭配" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  expect(onToggle).toHaveBeenCalledOnce();
  expect(screen.getByRole("menu", { name: "常用双文档搭配" })).toBeDefined();
  expect(onSelectPair).not.toHaveBeenCalled();
});

test("shows quick pairs in the approved order and dispatches the selected pair", async () => {
  const user = userEvent.setup();
  const onSelectPair = vi.fn();
  render(
    <PatentSplitControls active drawingsAvailable onToggle={vi.fn()} onSelectPair={onSelectPair} />,
  );

  expect(screen.getByRole("button", { name: "同屏双显" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  const menu = screen.getByRole("menu", { name: "常用双文档搭配" });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["权／说", "权／图", "图／说", "自定义"]);

  await user.click(within(menu).getByRole("menuitem", { name: "图／说" }));
  expect(onSelectPair).toHaveBeenCalledWith("drawings-description");
  expect(screen.queryByRole("menu", { name: "常用双文档搭配" })).toBeNull();
});

test("disables drawing pairs with a readable reason when drawing books are absent", async () => {
  const user = userEvent.setup();
  render(
    <PatentSplitControls
      active={false}
      drawingsAvailable={false}
      onToggle={vi.fn()}
      onSelectPair={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  expect(screen.getByRole("menuitem", { name: "权／说" }).hasAttribute("disabled")).toBe(false);
  for (const label of ["权／图", "图／说"]) {
    const item = screen.getByRole("menuitem", { name: label });
    expect(item.hasAttribute("disabled")).toBe(true);
    expect(item.getAttribute("title")).toBe("当前专利未启用说明书附图和摘要附图。");
  }
});

test("closes the quick-pair menu when clicking outside", async () => {
  const user = userEvent.setup();
  render(
    <>
      <PatentSplitControls
        active={false}
        drawingsAvailable
        onToggle={vi.fn()}
        onSelectPair={vi.fn()}
      />
      <button type="button">外部区域</button>
    </>,
  );

  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("button", { name: "外部区域" }));
  expect(screen.queryByRole("menu", { name: "常用双文档搭配" })).toBeNull();
});

test("opens custom settings from the bottom of the menu and renders preset quick buttons", async () => {
  const user = userEvent.setup();
  const presets: CustomDualViewPreset[] = [
    { leftBookKind: "description", rightBookKind: "claims" },
  ];
  const onOpenCustom = vi.fn();
  const onSelectCustomPreset = vi.fn();
  const { container } = render(
    <PatentSplitControls
      active={false}
      drawingsAvailable
      customPresets={presets}
      onToggle={vi.fn()}
      onSelectPair={vi.fn()}
      onOpenCustom={onOpenCustom}
      onSelectCustomPreset={onSelectCustomPreset}
    />,
  );

  const quickButton = screen.getByRole("button", { name: "说明书｜权利要求书" });
  expect(quickButton.textContent).toBe("说权");
  expect(quickButton.querySelector(".patent-split-controls__custom-divider")).toBeTruthy();
  await user.click(quickButton);
  expect(onSelectCustomPreset).toHaveBeenCalledWith(0);

  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  const menu = screen.getByRole("menu", { name: "常用双文档搭配" });
  expect(within(menu).getAllByRole("menuitem").at(-1)?.textContent).toBe("自定义");
  expect(container.querySelector(".patent-split-controls__menu-separator")).toBeTruthy();
  await user.click(within(menu).getByRole("menuitem", { name: "自定义" }));
  expect(onOpenCustom).toHaveBeenCalledOnce();
});

test("renders custom preset quick buttons beyond the third combination", () => {
  const presets: CustomDualViewPreset[] = [
    { leftBookKind: "description", rightBookKind: "claims" },
    { leftBookKind: "claims", rightBookKind: "description" },
    { leftBookKind: "abstract", rightBookKind: "claims" },
    { leftBookKind: "description-drawings", rightBookKind: "abstract" },
  ];
  render(
    <PatentSplitControls
      active={false}
      drawingsAvailable
      customPresets={presets}
      onToggle={vi.fn()}
      onSelectPair={vi.fn()}
      onSelectCustomPreset={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "说明书附图｜说明书摘要" })).toBeTruthy();
});

test("disables a drawing custom preset while keeping its quick button visible", () => {
  render(
    <PatentSplitControls
      active={false}
      drawingsAvailable={false}
      customPresets={[{ leftBookKind: "description-drawings", rightBookKind: "claims" }]}
      onToggle={vi.fn()}
      onSelectPair={vi.fn()}
      onOpenCustom={vi.fn()}
      onSelectCustomPreset={vi.fn()}
    />,
  );

  const button = screen.getByRole("button", { name: "说明书附图｜权利要求书" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(button.getAttribute("title")).toBe("当前专利未启用说明书附图");
});
