import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PatentApi } from "../../../shared/ipc/contract";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import type { PageMargins } from "../../../shared/settings/page-margins";
import { PageMarginDialog } from "./page-margin-dialog";

function patentApiMock(pageMargins: PageMargins = DEFAULT_APP_SETTINGS.pageMargins) {
  const read = vi.fn(async () => ({
    ok: true as const,
    value: { ...DEFAULT_APP_SETTINGS, pageMargins },
  }));
  const update = vi.fn(async (patch: unknown) => ({
    ok: true as const,
    value: { ...DEFAULT_APP_SETTINGS, ...(patch as object) },
  }));
  window.patentApi = {
    settings: { read, update },
  } as unknown as PatentApi;
  return { read, update };
}

function renderDialog(
  options: {
    pageWidthMm?: number;
    pageHeightMm?: number;
    embedded?: boolean;
    hasEditableDocument?: boolean;
    pageMargins?: PageMargins;
  } = {},
) {
  const api = patentApiMock(options.pageMargins);
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <PageMarginDialog
      open
      onClose={onClose}
      onSaved={onSaved}
      pageWidthMm={options.pageWidthMm ?? 210}
      pageHeightMm={options.pageHeightMm ?? 297}
      {...(options.embedded === undefined ? {} : { embedded: options.embedded })}
      {...(options.hasEditableDocument === undefined
        ? {}
        : { hasEditableDocument: options.hasEditableDocument })}
    />,
  );
  return { ...api, onSaved, onClose };
}

describe("page margin dialog", () => {
  test("rejects margins that cannot fit tables before saving settings", async () => {
    const api = patentApiMock();
    const onSaved = vi.fn();
    render(
      <PageMarginDialog
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        pageWidthMm={210}
        pageHeightMm={297}
        validateChange={() => "表格无法容纳"}
      />,
    );
    await screen.findByLabelText("左边距 (cm)");
    fireEvent.change(screen.getByLabelText("左边距 (cm)"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("表格无法容纳");
    expect(api.update).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
  test("only exposes left and right margin controls in embedded page settings", async () => {
    renderDialog({ embedded: true });

    await screen.findByLabelText("左边距 (cm)");

    expect(screen.queryByRole("dialog", { name: "页边距设置" })).toBeNull();
    expect(screen.getByRole("region", { name: "页面设置" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "页边距设置" })).toBeNull();
    expect(screen.queryByText(/默认左右页边距为/u)).toBeNull();
    expect(screen.getByLabelText("右边距 (cm)")).toBeDefined();
    expect(screen.queryByLabelText("上边距 (cm)")).toBeNull();
    expect(screen.queryByLabelText("下边距 (cm)")).toBeNull();
  });

  test("keeps the embedded page settings compact and updates its paper preview with the margins", async () => {
    renderDialog({ embedded: true });

    await screen.findByLabelText("左边距 (cm)");

    const preview = screen.getByLabelText("页面预览");
    expect(preview.getAttribute("data-content-width-mm")).toBe("146.6");
    expect(preview.getAttribute("data-content-height-mm")).toBe("246.2");

    fireEvent.change(screen.getByLabelText("左边距 (cm)"), { target: { value: "2" } });

    expect(preview.getAttribute("data-content-width-mm")).toBe("158.3");
  });

  test("uses the right half as a two-paragraph document preview", async () => {
    renderDialog({ embedded: true });

    await screen.findByLabelText("左边距 (cm)");

    const previewContent = screen.getByLabelText("页面预览内容");
    const paragraphs = within(previewContent).getAllByRole("paragraph");

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toContain("本发明涉及专利文档编辑技术领域");
    expect(paragraphs[1]?.textContent).toContain("通过调整页面边距");
    expect(screen.queryByText(/^内容区$/u)).toBeNull();
  });

  test("places embedded page actions outside the scrolling form and preview area", async () => {
    renderDialog({ embedded: true });

    await screen.findByLabelText("左边距 (cm)");

    const actions = screen.getByRole("button", { name: "保存" }).parentElement;
    expect(actions?.classList.contains("page-margin-dialog__actions")).toBe(true);
    expect(actions?.closest(".page-margin-dialog__card")).not.toBeNull();
    expect(actions?.previousElementSibling?.classList.contains("page-margin-dialog__layout")).toBe(
      true,
    );
  });

  test("saves global margins without an open document", async () => {
    const { update, onClose } = renderDialog({ embedded: true, hasEditableDocument: false });

    await screen.findByLabelText("左边距 (cm)");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  test("reverts embedded unsaved changes to the last saved values", async () => {
    const { update } = renderDialog({ embedded: true });
    await screen.findByLabelText("左边距 (cm)");
    fireEvent.change(screen.getByLabelText("左边距 (cm)"), { target: { value: "2" } });
    fireEvent.click(screen.getByText("还原未保存修改"));
    expect(screen.getByLabelText("左边距 (cm)")).toHaveProperty("value", "3.17");
    expect(update).not.toHaveBeenCalled();
  });

  test("saves from embedded page settings when an editable document is available", async () => {
    const user = userEvent.setup();
    const { update, onSaved } = renderDialog({ embedded: true, hasEditableDocument: true });
    await screen.findByLabelText("左边距 (cm)");

    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ pageMargins: DEFAULT_APP_SETTINGS.pageMargins }),
    );
    expect(onSaved).toHaveBeenCalledWith(DEFAULT_APP_SETTINGS.pageMargins);
  });

  test("shows a per-field error and blocks saving when a single margin exceeds 60mm", async () => {
    const user = userEvent.setup();
    const { update, onSaved } = renderDialog();
    await screen.findByLabelText("左边距 (cm)");

    fireEvent.change(screen.getByLabelText("左边距 (cm)"), { target: { value: "6.01" } });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/不能超过 60mm/u)).toBeDefined();
    expect(screen.getByLabelText("左边距 (cm)").getAttribute("aria-invalid")).toBe("true");
    expect(update).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("saves the Word wide preset with 5.08cm left and right margins", async () => {
    const user = userEvent.setup();
    const { update, onSaved, onClose } = renderDialog();
    await screen.findByLabelText("左边距 (cm)");

    await user.selectOptions(screen.getByLabelText("页边距预设："), "wide");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        pageMargins: {
          marginTopMm: 25.4,
          marginRightMm: 50.8,
          marginBottomMm: 25.4,
          marginLeftMm: 50.8,
        },
      }),
    );
    expect(onSaved).toHaveBeenCalledWith({
      marginTopMm: 25.4,
      marginRightMm: 50.8,
      marginBottomMm: 25.4,
      marginLeftMm: 50.8,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("keeps existing top and bottom margins when applying a horizontal preset", async () => {
    const user = userEvent.setup();
    const { update } = renderDialog({
      pageMargins: {
        marginTopMm: 18,
        marginRightMm: 22,
        marginBottomMm: 32,
        marginLeftMm: 20,
      },
    });
    await screen.findByLabelText("左边距 (cm)");

    await user.selectOptions(screen.getByLabelText("页边距预设："), "wide");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        pageMargins: {
          marginTopMm: 18,
          marginRightMm: 50.8,
          marginBottomMm: 32,
          marginLeftMm: 50.8,
        },
      }),
    );
  });

  test("shows a combined error and blocks saving when opposite margins exceed the page", async () => {
    const user = userEvent.setup();
    // 小页面（100mm 宽）下，左右各 50mm/45mm 单边合法但合计 95mm > 90mm 触发组合校验。
    const { update, onSaved } = renderDialog({ pageWidthMm: 100, pageHeightMm: 100 });
    await screen.findByLabelText("左边距 (cm)");

    fireEvent.change(screen.getByLabelText("左边距 (cm)"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("右边距 (cm)"), { target: { value: "4.5" } });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/左、右边距之和过大/u)).toBeDefined();
    expect(update).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("saves valid margins through settings.update and reports them via onSaved", async () => {
    const user = userEvent.setup();
    const { update, onSaved, onClose } = renderDialog();
    await screen.findByLabelText("左边距 (cm)");

    fireEvent.change(screen.getByLabelText("左边距 (cm)"), { target: { value: "3.17" } });
    fireEvent.change(screen.getByLabelText("右边距 (cm)"), { target: { value: "3.17" } });
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        pageMargins: {
          marginTopMm: 25.4,
          marginRightMm: 31.7,
          marginBottomMm: 25.4,
          marginLeftMm: 31.7,
        },
      }),
    );
    expect(onSaved).toHaveBeenCalledWith({
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("restores only the left and right Word defaults", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByLabelText("左边距 (cm)");

    fireEvent.change(screen.getByLabelText("左边距 (cm)"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("右边距 (cm)"), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: "恢复默认" }));

    expect(screen.getByLabelText("左边距 (cm)")).toHaveProperty("value", "3.17");
    expect(screen.getByLabelText("右边距 (cm)")).toHaveProperty("value", "3.17");
  });

  test("keeps existing top and bottom margins when restoring horizontal defaults", async () => {
    const user = userEvent.setup();
    const { update } = renderDialog({
      pageMargins: {
        marginTopMm: 18,
        marginRightMm: 22,
        marginBottomMm: 32,
        marginLeftMm: 20,
      },
    });
    await screen.findByLabelText("左边距 (cm)");

    await user.click(screen.getByRole("button", { name: "恢复默认" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        pageMargins: {
          marginTopMm: 18,
          marginRightMm: 31.7,
          marginBottomMm: 32,
          marginLeftMm: 31.7,
        },
      }),
    );
  });
});
