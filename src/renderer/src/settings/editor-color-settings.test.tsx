import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { StandardDialog } from "../shared/standard-dialog";
import { EditorColorSettings } from "./editor-color-settings";
import { GeneralSettings } from "./general-settings";
import { SettingsDraftProvider, useSettingsClose } from "./settings-drafts";

const editorColorStyles = readFileSync(
  "src/renderer/src/settings/editor-color-settings.css",
  "utf8",
);

test("palette uses the full available height and overlaps its trigger when necessary", () => {
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 300,
    bottom: 340,
    left: 0,
    right: 320,
    width: 320,
    height: 40,
    x: 0,
    y: 300,
    toJSON: () => ({}),
  });
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(450);
  try {
    render(
      <EditorColorSettings
        value={DEFAULT_APP_SETTINGS.editorColors}
        disabled={false}
        onApply={async () => true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "页面颜色" }));
    const popup = screen.getByRole("group", { name: "页面颜色可用颜色" });
    expect(popup.style.maxHeight).toBe(`${window.innerHeight - 16}px`);
    expect(Number.parseFloat(popup.style.top)).toBeLessThan(40);
    expect(Number.parseFloat(popup.style.top) + 300 + 450).toBeLessThanOrEqual(
      window.innerHeight - 8,
    );
  } finally {
    bounds.mockRestore();
    height.mockRestore();
  }
});

test("unified picker keeps presets and gamut open and synchronizes hue after a preset click", () => {
  render(
    <EditorColorSettings
      value={{ ...DEFAULT_APP_SETTINGS.editorColors, canvas: "#25282e", page: "#fffef0" }}
      disabled={false}
      onApply={async () => true}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "页面颜色" }));
  expect(screen.getByLabelText("当前配色方案").textContent).toBe("自定义");
  expect(screen.queryByRole("button", { name: "自定义颜色" })).toBeNull();
  expect(screen.getByRole("slider", { name: "可用色域" })).toBeTruthy();
  const grid = document.querySelector(".editor-color-picker__grid");
  expect(grid?.querySelectorAll("button").length).toBeLessThanOrEqual(24);
  expect(screen.getByRole("button", { name: "当前颜色" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "浅绿" }));
  expect(screen.getByRole("group", { name: "页面颜色可用颜色" })).toBeTruthy();
  expect(
    Number((screen.getByRole("slider", { name: "色相" }) as HTMLInputElement).value),
  ).toBeCloseTo(110, 0);
  expect(screen.getByRole("button", { name: "浅绿" }).getAttribute("aria-pressed")).toBe("true");
  expect(grid?.querySelectorAll("button").length).toBeLessThanOrEqual(24);
  expect(editorColorStyles).toMatch(/grid-template-columns:\s*repeat\(12,/);
  expect(editorColorStyles).toMatch(/grid-template-rows:\s*repeat\(2,/);
});

test("custom gamut changes only the draft, supports keyboard hue and color adjustment, and cancels", () => {
  const onApply = vi.fn(async () => true);
  render(
    <EditorColorSettings
      value={DEFAULT_APP_SETTINGS.editorColors}
      disabled={false}
      onApply={onApply}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "页面颜色" }));
  const hue = screen.getByRole("slider", { name: "色相" });
  fireEvent.change(hue, { target: { value: "120" } });
  const plane = screen.getByRole("slider", { name: "可用色域" });
  fireEvent.keyDown(plane, { key: "ArrowRight" });
  fireEvent.keyDown(plane, { key: "ArrowDown" });
  expect(screen.getByLabelText("页面颜色").getAttribute("data-color")).not.toBe("#ffffff");
  expect(screen.getByLabelText("空背景颜色").getAttribute("data-color")).toBe(
    DEFAULT_APP_SETTINGS.editorColors.canvas,
  );
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.getByLabelText("当前色值").getAttribute("readonly")).not.toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "取消调整" }));
  expect(screen.getByLabelText("页面颜色").getAttribute("data-color")).toBe("#ffffff");
});

test("custom color applies through the existing settings save path", async () => {
  const onApply = vi.fn(async () => true);
  render(
    <EditorColorSettings
      value={DEFAULT_APP_SETTINGS.editorColors}
      disabled={false}
      onApply={onApply}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "空背景颜色" }));
  fireEvent.keyDown(screen.getByRole("slider", { name: "可用色域" }), {
    key: "ArrowDown",
    shiftKey: true,
  });
  const selected = screen.getByLabelText("空背景颜色").getAttribute("data-color");
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "应用配色" }));
  await waitFor(() =>
    expect(onApply).toHaveBeenCalledWith({
      ...DEFAULT_APP_SETTINGS.editorColors,
      canvas: selected,
    }),
  );
});

test("Escape closes the color palette before its parent settings dialog", () => {
  const onCancel = vi.fn();
  render(
    <StandardDialog open title="配色设置" onCancel={onCancel}>
      <EditorColorSettings
        value={DEFAULT_APP_SETTINGS.editorColors}
        disabled={false}
        onApply={async () => true}
      />
    </StandardDialog>,
  );
  fireEvent.click(screen.getByRole("button", { name: "页面颜色" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "页面颜色可用颜色" })).toBeNull();
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledOnce();
});

test("display preferences keep their intended layout inside the settings dialog", () => {
  expect(editorColorStyles).toMatch(
    /\.application-settings-dialog\s+\.settings-workspace-content\s+\.settings-workspace-content__route--standard\s+\.settings-preferences\.display-preferences\s*\{[^}]*max-width:\s*920px/su,
  );
  expect(editorColorStyles).toMatch(
    /\.application-settings-dialog\s+\.settings-workspace-content\s+\.settings-workspace-content__route--standard\s+\.display-preferences\s*>\s*\.preference-group\s*>\s*\.preference-card\s*>\s*\.preference-row\s*\{[^}]*padding:\s*13px\s+17px/su,
  );
  expect(editorColorStyles).toMatch(
    /\.application-settings-dialog\s+\.settings-workspace-content\s+\.settings-workspace-content__route--standard\s+\.display-preferences\s+\.editor-color-controls\s+\.preference-row\s*\{[^}]*padding:\s*12px\s+0/su,
  );
  expect(editorColorStyles).toMatch(
    /\.application-settings-dialog\s+\.settings-workspace-content\s+\.settings-workspace-content__route--standard\s+\.display-preferences\s+\.editor-color-actions\s+\.editor-color-apply\s*\{[^}]*color:\s*#fff/su,
  );
});

test("unrelated settings refresh preserves draft, genuine palette change resets it", () => {
  const value = DEFAULT_APP_SETTINGS.editorColors;
  const onApply = async () => true;
  const view = render(<EditorColorSettings value={value} disabled={false} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: "暖纸" }));
  view.rerender(<EditorColorSettings value={{ ...value }} disabled={false} onApply={onApply} />);
  expect(screen.getByLabelText("页面颜色").getAttribute("data-color")).toBe("#faf4e6");
  view.rerender(
    <EditorColorSettings
      value={{ ...value, page: "#e7f1e5" }}
      disabled={false}
      onApply={onApply}
    />,
  );
  expect(screen.getByLabelText("页面颜色").getAttribute("data-color")).toBe("#e7f1e5");
});

function CloseSettings() {
  const close = useSettingsClose();
  return (
    <button type="button" onClick={close}>
      关闭设置
    </button>
  );
}

test("closing protects unapplied colors and failed saves", async () => {
  const close = vi.fn();
  const save = vi.fn().mockResolvedValue(false);
  render(
    <SettingsDraftProvider onClose={close}>
      <CloseSettings />
      <GeneralSettings kind="display" preferences={DEFAULT_APP_SETTINGS} onSavePreferences={save} />
    </SettingsDraftProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "雾蓝" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
  expect(screen.getByRole("dialog", { name: "未保存设置" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
  await screen.findByRole("alert");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
  expect(close).toHaveBeenCalledOnce();
});

test("preset preview is local until applied and saves coordinated colors", async () => {
  const save = vi.fn(async () => true);
  render(
    <GeneralSettings kind="display" preferences={DEFAULT_APP_SETTINGS} onSavePreferences={save} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "雾蓝" }));
  expect(screen.getByLabelText("页面颜色").getAttribute("data-color")).toBe("#f0f4fa");
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "应用配色" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      editorColors: {
        page: "#f0f4fa",
        canvas: "#ced7e3",
        panel: "#f7f9fc",
        panelFollowsPage: false,
      },
    }),
  );
});

test("only offers usable colors and following page hides the independent picker", () => {
  const save = vi.fn(async () => true);
  render(
    <GeneralSettings kind="display" preferences={DEFAULT_APP_SETTINGS} onSavePreferences={save} />,
  );
  expect(document.querySelector('input[type="color"]')).toBeNull();
  expect(screen.queryByLabelText("页面颜色色值")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "页面颜色" }));
  const palette = screen.getByRole("group", { name: "页面颜色可用颜色" });
  expect(within(palette).queryByRole("button", { name: /炭黑/ })).toBeNull();
  fireEvent.click(within(palette).getByRole("button", { name: "米白" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("页面颜色").getAttribute("data-color")).toBe("#faf4e6");
  fireEvent.click(screen.getByRole("checkbox", { name: "功能栏跟随页面颜色" }));
  expect(screen.queryByLabelText("功能栏颜色")).toBeNull();
  expect(screen.getByLabelText("页面颜色")).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("checkbox", { name: "功能栏跟随页面颜色" }));
  expect(screen.getByLabelText("功能栏颜色").getAttribute("data-color")).toBe("#ffffff");
  expect(save).not.toHaveBeenCalled();
});

test("preserves saved custom colors and closes the palette with Escape or an outside click", () => {
  const onApply = vi.fn(async () => true);
  render(
    <EditorColorSettings
      value={{ ...DEFAULT_APP_SETTINGS.editorColors, page: "#fffef0" }}
      disabled={false}
      onApply={onApply}
    />,
  );
  const trigger = screen.getByLabelText("页面颜色");
  fireEvent.click(trigger);
  expect(screen.getByRole("button", { name: "当前颜色" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "米白" }));
  expect(screen.getByRole("button", { name: "已保存颜色" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "页面颜色可用颜色" })).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("group", { name: "页面颜色可用颜色" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消调整" }));
  expect(trigger.getAttribute("data-color")).toBe("#fffef0");
  expect(onApply).not.toHaveBeenCalled();
});

test("failed save stays explicit and draft can be retried", async () => {
  render(
    <GeneralSettings
      kind="display"
      preferences={DEFAULT_APP_SETTINGS}
      onSavePreferences={async () => false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "暖纸" }));
  fireEvent.click(screen.getByRole("button", { name: "应用配色" }));
  await screen.findByText(/保存失败/);
  expect(screen.getByRole("button", { name: "应用配色" })).toHaveProperty("disabled", false);
});
