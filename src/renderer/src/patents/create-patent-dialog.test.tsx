import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreatePatentDialog } from "./create-patent-dialog";

describe("create patent dialog", () => {
  test.each([
    ["发明", "invention"],
    ["实用新型", "utility-model"],
  ])(
    "double-clicking %s creates the clicked type with the entered metadata",
    async (label, patentType) => {
      const user = userEvent.setup();
      const onCreate = vi.fn();
      render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);
      await user.click(screen.getByRole("radio", { name: label === "发明" ? "实用新型" : "发明" }));
      await user.type(screen.getByLabelText("专利名称"), "  夹具  ");
      await user.type(screen.getByLabelText("所属客户"), "  客户  ");
      const option = screen.getByRole("radio", { name: label }).closest("label");
      if (!option) throw new Error("Missing patent type label");
      expect(option.style.userSelect).toBe("none");
      await user.dblClick(option);
      expect(onCreate).toHaveBeenCalledExactlyOnceWith({
        patentType,
        name: "夹具",
        customer: "客户",
      });
    },
  );

  test("double-clicking the radio creates once; busy label double-clicks do nothing", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const view = render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);
    await user.dblClick(screen.getByRole("radio", { name: "实用新型" }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      patentType: "utility-model",
      name: null,
      customer: null,
    });
    view.rerender(<CreatePatentDialog busy onCreate={onCreate} onCancel={vi.fn()} />);
    const option = screen.getByRole("radio", { name: "发明" }).closest("label");
    if (!option) throw new Error("Missing patent type label");
    await user.dblClick(option);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
  test.each(["专利名称", "所属客户"])(
    "does not submit when IME confirms text in %s",
    async (label) => {
      const onCreate = vi.fn();
      render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByRole("radio", { name: "发明" }));
      const input = screen.getByLabelText(label);
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
      expect(onCreate).not.toHaveBeenCalled();
      fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCreate).toHaveBeenCalledOnce();
    },
  );
  test("uses the standard medium dialog shell", () => {
    render(<CreatePatentDialog busy={false} onCreate={vi.fn()} onCancel={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "新建专利" });
    expect(dialog.classList.contains("standard-dialog")).toBe(true);
    expect(dialog.classList.contains("standard-dialog--m")).toBe(true);
    expect(dialog.parentElement?.classList.contains("standard-dialog-overlay")).toBe(true);
    expect(
      within(dialog)
        .getByRole("button", { name: "创建专利" })
        .closest("footer")
        ?.classList.contains("standard-dialog__footer"),
    ).toBe(true);
  });

  test("limits both metadata fields to 100 characters", () => {
    render(<CreatePatentDialog busy={false} onCreate={vi.fn()} onCancel={vi.fn()} />);

    expect((screen.getByLabelText("专利名称") as HTMLInputElement).maxLength).toBe(100);
    expect((screen.getByLabelText("所属客户") as HTMLInputElement).maxLength).toBe(100);
  });

  test("requires choosing a patent type before creating", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "创建专利" }));

    expect(screen.getByText("请选择专利类型。")).toBeDefined();
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("allows an empty patent name and submits the selected type", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "实用新型" }));
    await user.click(screen.getByRole("button", { name: "创建专利" }));

    expect(onCreate).toHaveBeenCalledWith({
      patentType: "utility-model",
      name: null,
      customer: null,
    });
  });

  test("offers the exterior-design workbench as a patent type", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "外观设计" }));
    await user.click(screen.getByRole("button", { name: "创建专利" }));

    expect(onCreate).toHaveBeenCalledWith({ patentType: "design", name: null, customer: null });
  });

  test("trims patent names without forcing a default name into stored metadata", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "发明" }));
    await user.type(screen.getByLabelText("专利名称"), "  可调节夹具  ");
    await user.click(screen.getByRole("button", { name: "创建专利" }));

    expect(onCreate).toHaveBeenCalledWith({
      patentType: "invention",
      name: "可调节夹具",
      customer: null,
    });
  });

  test("trims and submits the optional customer using the existing customer field", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "发明" }));
    await user.type(screen.getByLabelText("所属客户"), "  华东机械有限公司  ");
    await user.click(screen.getByRole("button", { name: "创建专利" }));

    expect(onCreate).toHaveBeenCalledWith({
      patentType: "invention",
      name: null,
      customer: "华东机械有限公司",
    });
  });

  test("focuses the patent name field when the dialog opens so it can be typed immediately", async () => {
    render(<CreatePatentDialog busy={false} onCreate={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("专利名称")));
  });

  test("disables actions while creating", () => {
    render(<CreatePatentDialog busy onCreate={vi.fn()} onCancel={vi.fn()} />);

    expect((screen.getByRole("button", { name: "创建中…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("creates the patent when Enter is pressed with a type selected", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "实用新型" }));
    await user.type(screen.getByLabelText("专利名称"), "{enter}");

    expect(onCreate).toHaveBeenCalledWith({
      patentType: "utility-model",
      name: null,
      customer: null,
    });
  });

  test("pressing Enter without a patent type shows the type error instead of creating", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreatePatentDialog busy={false} onCreate={onCreate} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("专利名称"), "{enter}");

    expect(screen.getByText("请选择专利类型。")).toBeDefined();
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("pressing Enter while creating does not submit again", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreatePatentDialog busy onCreate={onCreate} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "发明" }));
    await user.type(screen.getByLabelText("专利名称"), "{enter}");

    expect(onCreate).not.toHaveBeenCalled();
  });
});
