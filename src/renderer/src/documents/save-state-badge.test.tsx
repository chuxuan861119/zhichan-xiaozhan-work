import { render, screen } from "@testing-library/react";
import { SaveStateBadge } from "./save-state-badge";

test("compact saved badge retains its accessible status and timestamp", () => {
  render(<SaveStateBadge state="saved" compact lastSavedAt="2026-08-01T01:02:00.000Z" />);
  const badge = screen.getByRole("status", { name: "已保存" });
  expect(badge.textContent).toBe("✓");
  expect(badge.title).toContain("已保存于");
});

test.each(["saving", "failed"] as const)("compact %s badge still explains the state", (state) => {
  render(<SaveStateBadge state={state} compact />);
  expect(screen.getByRole("status").textContent).toContain(
    state === "failed" ? "保存失败" : "保存中",
  );
});

test.each([
  ["saving", "保存中…"],
  ["saved", "已保存"],
  ["failed", "保存失败"],
] as const)("renders an accessible %s save badge", (state, label) => {
  render(<SaveStateBadge state={state} lastSavedAt="2026-08-01T01:02:00.000Z" />);

  const badge = screen.getByRole("status", { name: label });
  expect(badge).toBeDefined();
  expect(screen.getByText(label)).toBeDefined();
});

test("includes the last saved time in the saved badge title", () => {
  render(<SaveStateBadge state="saved" lastSavedAt="2026-08-01T01:02:00.000Z" />);

  expect(screen.getByRole("status", { name: "已保存" }).getAttribute("title")).toMatch(/已保存于/u);
});

test("does not render a checkmark for the saved state", () => {
  render(<SaveStateBadge state="saved" lastSavedAt="2026-08-01T01:02:00.000Z" />);

  expect(screen.getByRole("status", { name: "已保存" })).toBeDefined();
  expect(screen.queryByText("✓")).toBeNull();
});
