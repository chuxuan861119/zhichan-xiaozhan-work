import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CustomDualViewPreset } from "../../../shared/settings/custom-dual-view";
import {
  DEFAULT_SHORTCUT_SETTINGS,
  type ShortcutSettings,
} from "../../../shared/settings/shortcuts";
import { CustomDualViewDialog } from "./custom-dual-view-dialog";

describe("custom dual-view dialog", () => {
  test("saves tools on either side and restores them when reopened", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => true);
    const props = {
      open: true,
      presets: [],
      shortcuts: DEFAULT_SHORTCUT_SETTINGS,
      onClose: vi.fn(),
      onSave,
    };
    const view = render(<CustomDualViewDialog {...props} />);
    await user.click(screen.getByRole("button", { name: "添加预设" }));
    await user.selectOptions(screen.getByLabelText("第 1 组左侧文档"), "flowchart");
    await user.selectOptions(screen.getByLabelText("第 1 组右侧文档"), "drawing-markup");
    await user.click(screen.getByRole("button", { name: "保存" }));
    const presets = [
      { leftBookKind: "flowchart" as const, rightBookKind: "drawing-markup" as const },
    ];
    expect(onSave).toHaveBeenCalledWith(presets, DEFAULT_SHORTCUT_SETTINGS);
    view.rerender(<CustomDualViewDialog {...props} open={false} presets={presets} />);
    view.rerender(<CustomDualViewDialog {...props} presets={presets} />);
    expect((screen.getByLabelText("第 1 组左侧文档") as HTMLSelectElement).value).toBe("flowchart");
    await user.selectOptions(screen.getByLabelText("第 1 组左侧文档"), "drawing-markup");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert").textContent).toContain("左右两侧不能选择相同文档");
    await user.selectOptions(screen.getByLabelText("第 1 组右侧文档"), "flowchart");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).toHaveBeenLastCalledWith(
      [{ leftBookKind: "drawing-markup", rightBookKind: "flowchart" }],
      DEFAULT_SHORTCUT_SETTINGS,
    );
  });
  test("uses the standard medium dialog shell", () => {
    render(
      <CustomDualViewDialog
        open
        presets={[]}
        shortcuts={DEFAULT_SHORTCUT_SETTINGS}
        onClose={vi.fn()}
        onSave={vi.fn(async () => true)}
      />,
    );

    expect(
      screen
        .getByRole("dialog", { name: "自定义同屏双显" })
        .classList.contains("standard-dialog--m"),
    ).toBe(true);
  });

  test("adds a preset and saves its left-right books with a shortcut", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => true);
    render(
      <CustomDualViewDialog
        open
        presets={[]}
        shortcuts={DEFAULT_SHORTCUT_SETTINGS}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "添加预设" }));
    await user.selectOptions(screen.getByLabelText("第 1 组左侧文档"), "description");
    await user.selectOptions(screen.getByLabelText("第 1 组右侧文档"), "claims");
    const shortcut = screen.getByRole("button", { name: "设置第 1 组快捷键" });
    await user.click(shortcut);
    expect(shortcut.textContent).toBe("请按快捷键");
    expect(screen.queryByText(/F1.*F12/u)).toBeNull();
    fireEvent.keyDown(shortcut, { code: "F8", key: "F8" });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledWith(
      [{ leftBookKind: "description", rightBookKind: "claims" }],
      { ...DEFAULT_SHORTCUT_SETTINGS, "open-custom-dual-view-1": "F8" },
    );
  });

  test("adds and saves more than three presets", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(
      async (_presets: CustomDualViewPreset[], _shortcuts: ShortcutSettings) => true,
    );
    render(
      <CustomDualViewDialog
        open
        presets={[]}
        shortcuts={DEFAULT_SHORTCUT_SETTINGS}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    for (let index = 0; index < 4; index += 1) {
      await user.click(screen.getByRole("button", { name: "添加预设" }));
    }
    expect(screen.getByLabelText("第 4 组左侧文档")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加预设" })).toBeTruthy();
    expect(screen.queryByText(/最多添加/u)).toBeNull();

    const shortcut = screen.getByRole("button", { name: "设置第 4 组快捷键" });
    await user.click(shortcut);
    fireEvent.keyDown(shortcut, { code: "F9", key: "F9" });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Object)]), {
      ...DEFAULT_SHORTCUT_SETTINGS,
      "open-custom-dual-view-4": "F9",
    });
    expect(onSave.mock.calls[0]?.[0]).toHaveLength(4);
  });

  test("blocks duplicate sides and compacts later shortcuts when deleting a preset", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => true);
    render(
      <CustomDualViewDialog
        open
        presets={[
          { leftBookKind: "description", rightBookKind: "claims" },
          { leftBookKind: "abstract", rightBookKind: "description" },
        ]}
        shortcuts={{
          ...DEFAULT_SHORTCUT_SETTINGS,
          "open-custom-dual-view-1": "F8",
          "open-custom-dual-view-2": "F9",
        }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.selectOptions(screen.getByLabelText("第 1 组右侧文档"), "description");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert").textContent).toContain("左右两侧不能选择相同文档");
    expect(onSave).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText("第 1 组右侧文档"), "claims");
    await user.click(screen.getByRole("button", { name: "删除第 1 组" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledWith(
      [{ leftBookKind: "abstract", rightBookKind: "description" }],
      {
        ...DEFAULT_SHORTCUT_SETTINGS,
        "open-custom-dual-view-1": "F9",
        "open-custom-dual-view-2": null,
      },
    );
  });
});
