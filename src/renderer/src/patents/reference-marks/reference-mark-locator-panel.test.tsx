import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ReferenceMarkLocatorPanel } from "./reference-mark-locator-panel";

describe("reference mark locator panel", () => {
  test("keeps the idle panel compact and synchronizes the capsule switch", () => {
    const onEnabledChange = vi.fn();
    render(
      <ReferenceMarkLocatorPanel
        enabled
        activeKeyword={null}
        onEnabledChange={onEnabledChange}
        onCancel={() => undefined}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "零部件定位" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("双击零部件高亮")).toBeTruthy();
    expect(screen.queryByText("当前高亮")).toBeNull();
    expect(screen.queryByRole("button", { name: "取消高亮" })).toBeNull();
    fireEvent.click(toggle);
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  test("expands with the current keyword and supports explicit cancellation", () => {
    const onCancel = vi.fn();
    render(
      <ReferenceMarkLocatorPanel
        enabled
        activeKeyword="电池包"
        onEnabledChange={() => undefined}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("当前高亮")).toBeTruthy();
    expect(screen.getByText("电池包")).toBeTruthy();
    expect(screen.queryByText("双击零部件高亮")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消高亮" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
