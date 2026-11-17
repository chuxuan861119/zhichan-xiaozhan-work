import { fireEvent, render, screen } from "@testing-library/react";
import { DataSafetyGuide, shouldOfferDataSafetyGuide } from "./data-safety-guide";

test("offers the optional guide only when an open patent still lacks a safety layer", () => {
  expect(
    shouldOfferDataSafetyGuide({
      hasOpenPatent: true,
      dismissed: false,
      backupEnabled: false,
      snapshotEnabled: true,
    }),
  ).toBe(true);
  expect(
    shouldOfferDataSafetyGuide({
      hasOpenPatent: true,
      dismissed: false,
      backupEnabled: true,
      snapshotEnabled: true,
    }),
  ).toBe(false);
  expect(
    shouldOfferDataSafetyGuide({
      hasOpenPatent: false,
      dismissed: false,
      backupEnabled: false,
      snapshotEnabled: true,
    }),
  ).toBe(false);
});

test("defers the optional guide while a higher-priority onboarding overlay is visible", () => {
  expect(
    shouldOfferDataSafetyGuide({
      hasOpenPatent: true,
      dismissed: false,
      backupEnabled: false,
      snapshotEnabled: true,
      suppressedByHigherPriorityOverlay: true,
    }),
  ).toBe(false);
});

test("shows a compact backup reminder without forcing setup", () => {
  const onOpenSettings = vi.fn();
  const onDismiss = vi.fn();
  render(
    <DataSafetyGuide
      backupEnabled={false}
      snapshotEnabled
      onOpenSettings={onOpenSettings}
      onDismiss={onDismiss}
    />,
  );

  const guide = screen.getByRole("status", { name: "数据安全提示" });
  expect(screen.getByRole("heading", { name: "建议开启定时备份" })).toBeTruthy();
  expect(guide.textContent).toContain("为了数据安全，建议开启定时备份。");
  expect(guide.textContent).not.toContain("快照");
  expect(guide.textContent).not.toContain("确认已成功生成备份");
  expect(guide.textContent).not.toContain("可在设备或数据目录故障时恢复");
  expect(guide.textContent).not.toContain("工具 → 数据安全设置");
  expect(guide.classList.contains("data-safety-guide")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "稍后设置" }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "暂时关闭数据安全提示" }));
  expect(onDismiss).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "设置定时备份" }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
});

test("adapts the compact reminder when both safety layers are disabled", () => {
  render(
    <DataSafetyGuide
      backupEnabled={false}
      snapshotEnabled={false}
      onOpenSettings={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  expect(screen.getByRole("heading", { name: "建议完善数据保护" })).toBeTruthy();
  expect(screen.getByText("快照和定时备份尚未开启。建议开启后再开始正式撰写。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "去设置" })).toBeTruthy();
});
