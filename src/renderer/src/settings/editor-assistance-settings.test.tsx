import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { EditorAssistanceSettings } from "./editor-assistance-settings";

test("opens the shared invention-content settings", () => {
  const onOpenInventionContentSettings = vi.fn();
  render(
    <EditorAssistanceSettings
      referenceMarkLocatorEnabled
      onReferenceMarkLocatorEnabledChange={vi.fn()}
      onOpenInventionContentSettings={onOpenInventionContentSettings}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "发明内容设置" }));
  expect(onOpenInventionContentSettings).toHaveBeenCalledOnce();
});

test("explains and updates the default-enabled reference-mark locator", () => {
  const onReferenceMarkLocatorEnabledChange = vi.fn();
  render(
    <EditorAssistanceSettings
      referenceMarkLocatorEnabled
      onReferenceMarkLocatorEnabledChange={onReferenceMarkLocatorEnabledChange}
    />,
  );

  expect(screen.getByText("零部件定位")).toBeTruthy();
  expect(screen.getByText(/双击关键词可定位三书中的全部出现位置/u)).toBeTruthy();
  const toggle = screen.getByRole("switch", { name: "零部件定位" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(onReferenceMarkLocatorEnabledChange).toHaveBeenCalledWith(false);
});
