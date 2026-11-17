import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChemicalPeriodicPanel } from "./chemical-periodic-panel";

describe("ChemicalPeriodicPanel", () => {
  test("renders all 4 tab buttons without a search tab", () => {
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "元素周期表" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "离子" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "化学式" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "同位素" })).toBeDefined();
    expect(screen.queryByRole("tab", { name: "🔍" })).toBeNull();
  });

  test("starts with elements tab active", () => {
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "元素周期表" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    // Hydrogen cell should be visible in the periodic table
    expect(screen.getByTitle(/氢 \(H\)/)).toBeDefined();
  });

  test("clicking an element calls onInsertElement with its symbol", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ChemicalPeriodicPanel onInsertElement={onInsert} />);

    await user.click(screen.getByTitle(/氢 \(H\)/));

    expect(onInsert).toHaveBeenCalledWith("H");
  });

  test("clicking a common element still calls onInsertElement", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ChemicalPeriodicPanel onInsertElement={onInsert} />);

    // Carbon is a common element with golden border
    const carbonButton = screen.getByTitle(/碳 \(C\)/);
    expect(carbonButton.className).toContain("periodic-cell-common");
    await user.click(carbonButton);

    expect(onInsert).toHaveBeenCalledWith("C");
  });

  test("switches to ions tab and shows cations and anions flat", async () => {
    const user = userEvent.setup();
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: "离子" }));

    expect(screen.getByRole("tabpanel", { name: "常用离子" })).toBeDefined();
    // Both sections visible at once (no sub-tabs)
    expect(screen.getByText("阳离子")).toBeDefined();
    expect(screen.getByText("阴离子")).toBeDefined();
  });

  test("ion tab shows both cations and anions inline", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ChemicalPeriodicPanel onInsertElement={onInsert} />);

    await user.click(screen.getByRole("tab", { name: "离子" }));

    // Both cation and anion buttons visible without switching sub-tabs
    const sodiumButton = screen.getByTitle("钠离子: Na^{+}");
    expect(sodiumButton).toBeDefined();
    const chlorideButton = screen.getByTitle("氯离子: Cl^{-}");
    expect(chlorideButton).toBeDefined();
    await user.click(chlorideButton);
    expect(onInsert).toHaveBeenCalledWith("Cl^{-}");
  });

  test("formula tab inserts a formula", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ChemicalPeriodicPanel onInsertElement={onInsert} />);

    await user.click(screen.getByRole("tab", { name: "化学式" }));
    await user.click(screen.getByTitle(/水: H_\{2\}O/));

    expect(onInsert).toHaveBeenCalledWith("H_{2}O");
  });

  test("isotope tab inserts isotope notation", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ChemicalPeriodicPanel onInsertElement={onInsert} />);

    await user.click(screen.getByRole("tab", { name: "同位素" }));
    await user.click(screen.getByTitle("氘: ^{2}H"));

    expect(onInsert).toHaveBeenCalledWith("^{2}H");
  });

  test("renders a search input in the panel header", () => {
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    const input = screen.getByPlaceholderText("搜索元素或化学式…");
    expect(input).toBeDefined();
    expect(input.getAttribute("aria-label")).toBe("搜索化学面板");
  });

  test("search highlights matching element by symbol", async () => {
    const user = userEvent.setup();
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    const input = screen.getByPlaceholderText("搜索元素或化学式…");
    await user.type(input, "fe");

    // Fe (iron) cell should be highlighted
    const iron = screen.getByTitle(/铁 \(Fe\)/);
    expect(iron.className).toContain("search-match");

    // Non-matching element (H) should not be highlighted
    const hydrogen = screen.getByTitle(/氢 \(H\)/);
    expect(hydrogen.className).not.toContain("search-match");
  });

  test("search highlights matching element by Chinese name", async () => {
    const user = userEvent.setup();
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    const input = screen.getByPlaceholderText("搜索元素或化学式…");
    await user.type(input, "氧");

    const oxygen = screen.getByTitle(/氧 \(O\)/);
    expect(oxygen.className).toContain("search-match");
  });

  test("search highlights matching element by atomic number", async () => {
    const user = userEvent.setup();
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    const input = screen.getByPlaceholderText("搜索元素或化学式…");
    await user.type(input, "8");

    const oxygen = screen.getByTitle(/氧 \(O\)/);
    expect(oxygen.className).toContain("search-match");
  });

  test("search highlights matching formula in formulas tab", async () => {
    const user = userEvent.setup();
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: "化学式" }));

    const input = screen.getByPlaceholderText("搜索元素或化学式…");
    await user.type(input, "钠");

    const button = screen.getByTitle("碳酸钠: Na_{2}CO_{3}");
    expect(button.className).toContain("search-match");

    // Non-matching should not be highlighted
    const waterButton = screen.getByTitle(/水: H_\{2\}O/);
    expect(waterButton.className).not.toContain("search-match");
  });

  test("search highlights matching ion", async () => {
    const user = userEvent.setup();
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: "离子" }));

    const input = screen.getByPlaceholderText("搜索元素或化学式…");
    await user.type(input, "so4");

    const sulfateButton = screen.getByTitle("硫酸根: SO_{4}^{2-}");
    expect(sulfateButton.className).toContain("search-match");
  });

  test("search clears highlights when query is emptied", async () => {
    const user = userEvent.setup();
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    const input = screen.getByPlaceholderText("搜索元素或化学式…");
    await user.type(input, "铁");
    const iron = screen.getByTitle(/铁 \(Fe\)/);
    expect(iron.className).toContain("search-match");

    await user.clear(input);
    // Re-query after state update
    const ironAfter = screen.getByTitle(/铁 \(Fe\)/);
    expect(ironAfter.className).not.toContain("search-match");
  });

  test("legend shows all 10 element categories", () => {
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    const categories = [
      "碱金属",
      "碱土金属",
      "过渡金属",
      "后过渡金属",
      "类金属",
      "非金属",
      "卤素",
      "稀有气体",
      "镧系",
      "锕系",
    ];
    for (const cat of categories) {
      expect(screen.getByText(cat)).toBeDefined();
    }
  });

  test("does not render a close button when onClose is omitted", () => {
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} />);

    expect(screen.queryByLabelText("收起元素面板")).toBeNull();
  });

  test("renders a close button and calls onClose when clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ChemicalPeriodicPanel onInsertElement={vi.fn()} onClose={onClose} />);

    const closeButton = screen.getByRole("button", { name: "收起元素面板" });
    expect(closeButton).toBeDefined();
    await user.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
