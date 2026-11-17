import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChemicalScriptSuggestion } from "../chemical-script-suggestions";
import { ChemicalSuggestionBar } from "./chemical-suggestion-bar";

function candidate(
  displayText: string,
  latex: string,
  reason: ChemicalScriptSuggestion["reason"] = "composition",
): ChemicalScriptSuggestion {
  return {
    id: `candidate:${displayText}`,
    fragment: "H2O",
    range: [0, 3],
    sourceVersion: "H2O",
    latex,
    displayText,
    reason,
  };
}

test("renders two candidates and accepts the clicked option without moving focus", async () => {
  const user = userEvent.setup();
  const onActivate = vi.fn();
  const onAccept = vi.fn();
  render(
    <ChemicalSuggestionBar
      candidates={[
        candidate("SO₄²⁻", "SO_{4}^{2-}", "ambiguous-charge"),
        candidate("SO₄₂⁻", "SO_{42}^{-}", "ambiguous-charge"),
      ]}
      activeIndex={1}
      onActivate={onActivate}
      onAccept={onAccept}
    />,
  );

  expect(screen.getByRole("listbox", { name: "化学式格式候选" })).toBeDefined();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  const active = screen.getByRole("option", { name: "使用候选 SO₄₂⁻" });
  expect(active.getAttribute("aria-selected")).toBe("true");
  expect(active.querySelector(".katex")).not.toBeNull();

  const preferred = screen.getByRole("option", { name: "使用候选 SO₄²⁻" });
  expect(fireEvent.pointerDown(preferred)).toBe(false);
  await user.click(preferred);
  expect(onActivate).toHaveBeenCalledWith(0);
  expect(onAccept).toHaveBeenCalledWith(0);
});

test("renders nothing without candidates", () => {
  const { container } = render(
    <ChemicalSuggestionBar
      candidates={[]}
      activeIndex={0}
      onActivate={vi.fn()}
      onAccept={vi.fn()}
    />,
  );

  expect(container.firstChild).toBeNull();
});
