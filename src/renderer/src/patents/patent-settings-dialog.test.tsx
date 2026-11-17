import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PatentSettingsDialog } from "./patent-settings-dialog";

describe("patent settings dialog", () => {
  test("uses the standard medium dialog shell", () => {
    render(
      <PatentSettingsDialog
        busy={false}
        name="可调夹具"
        customer="测试客户"
        patentType="invention"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "专利设置" });
    expect(dialog.classList.contains("standard-dialog")).toBe(true);
    expect(dialog.classList.contains("standard-dialog--m")).toBe(true);
    expect(dialog.parentElement?.classList.contains("standard-dialog-overlay")).toBe(true);
    expect(
      within(dialog)
        .getByRole("button", { name: "保存设置" })
        .closest("footer")
        ?.classList.contains("standard-dialog__footer"),
    ).toBe(true);
  });

  test("limits both metadata fields to 100 characters", () => {
    render(
      <PatentSettingsDialog
        busy={false}
        name="可调夹具"
        customer="测试客户"
        patentType="invention"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("专利名称") as HTMLInputElement).maxLength).toBe(100);
    expect((screen.getByLabelText("所属客户") as HTMLInputElement).maxLength).toBe(100);
  });

  test("does not resend unchanged legacy metadata that exceeds the current limit", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <PatentSettingsDialog
        busy={false}
        name={"名".repeat(101)}
        customer={"客".repeat(101)}
        patentType="invention"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(onSave).toHaveBeenCalledWith({
      patentType: "invention",
      terminologyReplacementRequested: false,
    });
  });

  test("saves metadata-only name changes", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <PatentSettingsDialog
        busy={false}
        name="可调夹具"
        customer="测试客户"
        patentType="invention"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText("专利名称"));
    await user.type(screen.getByLabelText("专利名称"), "  新夹具  ");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(onSave).toHaveBeenCalledWith({
      name: "新夹具",
      patentType: "invention",
      terminologyReplacementRequested: false,
    });
  });

  test("allows clearing the patent name without storing a fallback display name", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <PatentSettingsDialog
        busy={false}
        name="可调夹具"
        customer="测试客户"
        patentType="invention"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText("专利名称"));
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(onSave).toHaveBeenCalledWith({
      name: null,
      patentType: "invention",
      terminologyReplacementRequested: false,
    });
  });

  test("shows a terminology replacement preview when switching patent type", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <PatentSettingsDialog
        busy={false}
        name={null}
        customer={null}
        patentType="invention"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "实用新型" }));

    expect(screen.getByText("术语替换预览")).toBeDefined();
    expect(screen.getByText("发明 → 实用新型")).toBeDefined();
    await user.click(screen.getByRole("checkbox", { name: "保存后执行全局术语替换" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(onSave).toHaveBeenCalledWith({
      patentType: "utility-model",
      terminologyReplacementRequested: true,
    });
  });
});
