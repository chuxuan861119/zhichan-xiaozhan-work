import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadAppearancePanel } from "./cad-appearance-panel";
afterEach(cleanup);
test("a queued rail scroll does not dismiss the color palette; scrolling repositions it", () => {
  render(
    <CadAppearancePanel
      defaults={{ color: "#000000", lineweight: 0.25, linetype: "Continuous" }}
      selected={[]}
      linetypes={[]}
      disabled={false}
      apply={vi.fn()}
      focusCanvas={vi.fn()}
      onError={vi.fn()}
    />,
  );
  const trigger = screen.getByLabelText("颜色");
  const bounds = vi.spyOn(trigger, "getBoundingClientRect");
  bounds.mockReturnValue({ left: 100, bottom: 200, top: 180 } as DOMRect);
  fireEvent.click(trigger);
  fireEvent.scroll(document.body);
  expect(screen.getByRole("dialog", { name: "颜色" })).toBeDefined();
  bounds.mockReturnValue({ left: 100, bottom: 240, top: 220 } as DOMRect);
  fireEvent.scroll(document.body);
  expect(screen.getByRole("dialog", { name: "颜色" }).style.top).toBe("244px");
});

test("inapplicable text properties are visibly disabled, color stays available", () => {
  render(
    <CadAppearancePanel
      defaults={{ color: "#000000", lineweight: 0.25, linetype: "Continuous" }}
      selected={[]}
      linetypes={[]}
      disabled={false}
      available={{ lineweight: false, linetype: false }}
      apply={vi.fn()}
      focusCanvas={vi.fn()}
      onError={vi.fn()}
    />,
  );
  expect((screen.getByLabelText("线宽") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText("线型") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText("颜色") as HTMLButtonElement).disabled).toBe(false);
});

test("changes only the chosen property for mixed selected objects and restores canvas focus", async () => {
  const apply = vi.fn().mockResolvedValue(undefined),
    focusCanvas = vi.fn();
  render(
    <CadAppearancePanel
      defaults={{ color: "#000000", lineweight: 0.25, linetype: "Continuous" }}
      selected={[
        { color: "#ff0000", lineweight: 0.25, linetype: "Continuous" },
        { color: "#000000", lineweight: 0.7, linetype: "DASHED" },
      ]}
      linetypes={[]}
      disabled={false}
      apply={apply}
      focusCanvas={focusCanvas}
      onError={vi.fn()}
    />,
  );
  expect((screen.getByLabelText("线宽") as HTMLSelectElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("线宽"), { target: { value: "0.5" } });
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ lineweight: 0.5 }));
  expect(focusCanvas).toHaveBeenCalled();
});

test("custom color stays a draft until confirmed and Escape cancels without writing", () => {
  const apply = vi.fn(),
    focusCanvas = vi.fn();
  render(
    <CadAppearancePanel
      defaults={{ color: "#000000", lineweight: 0.25, linetype: "Continuous" }}
      selected={[]}
      linetypes={[]}
      disabled={false}
      apply={apply}
      focusCanvas={focusCanvas}
      onError={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByLabelText("颜色"));
  fireEvent.click(screen.getByRole("button", { name: "其他颜色" }));
  fireEvent.change(screen.getByLabelText("HEX"), { target: { value: "#123456" } });
  expect(apply).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByLabelText("HEX"), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "其他颜色" })).toBeNull();
  expect(apply).not.toHaveBeenCalled();
  expect(focusCanvas).toHaveBeenCalled();
});
