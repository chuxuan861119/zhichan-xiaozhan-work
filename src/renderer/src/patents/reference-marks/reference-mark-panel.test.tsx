import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import { REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE } from "../../../../shared/patent/reference-mark-operations";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../../shared/settings/shortcuts";
import { ShortcutProvider } from "../../app/shortcut-dispatcher";
import { ReferenceMarkPanel } from "./reference-mark-panel";

const crossDocumentEditingTest = REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE ? test : test.skip;

describe("reference mark panel", () => {
  test("closes keyword editing immediately when reduced motion is enabled", () => {
    const previousMotion = document.documentElement.dataset.reducedMotion;
    document.documentElement.dataset.reducedMotion = "true";
    try {
      const patent = createBlankPatent({ patentType: "invention", name: "减少编辑动画" });
      patent.referenceMarks = [{ referenceMarkId: "mark-1", number: 1, keyword: "箱体" }];
      const view = render(
        <ReferenceMarkPanel
          patent={patent}
          missingReferenceMarkIds={new Set()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={() => ({ ok: true, message: "" })}
          onCancel={() => ({ ok: true, message: "" })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "编辑箱体" }));
      fireEvent.click(screen.getByRole("button", { name: "取消箱体修改" }));
      expect(screen.queryByLabelText("箱体关键词")).toBeNull();
      expect(screen.getByRole("button", { name: "编辑箱体" })).toBeDefined();
      view.unmount();
    } finally {
      if (previousMotion === undefined) delete document.documentElement.dataset.reducedMotion;
      else document.documentElement.dataset.reducedMotion = previousMotion;
    }
  });

  test("retains keyword editing during reverse collapse and safely reopens it", () => {
    vi.useFakeTimers();
    const previousMotion = document.documentElement.dataset.reducedMotion;
    document.documentElement.dataset.reducedMotion = "false";
    try {
      const patent = createBlankPatent({ patentType: "invention", name: "编辑动画" });
      patent.referenceMarks = [{ referenceMarkId: "mark-1", number: 1, keyword: "箱体" }];
      const view = render(
        <ReferenceMarkPanel
          patent={patent}
          missingReferenceMarkIds={new Set()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={() => ({ ok: true, message: "" })}
          onCancel={() => ({ ok: true, message: "" })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "编辑箱体" }));
      const input = screen.getByLabelText("箱体关键词");
      const surface = input.closest(".spatial-collapse");
      expect(surface?.getAttribute("data-motion")).toBe("enter");
      fireEvent.change(input, { target: { value: "外壳" } });
      fireEvent.click(screen.getByRole("button", { name: "取消箱体修改" }));
      expect(surface?.getAttribute("data-motion")).toBe("exit");
      expect(surface?.hasAttribute("inert")).toBe(true);
      expect(screen.queryByRole("textbox", { name: "箱体关键词" })).toBeNull();
      act(() => vi.advanceTimersByTime(150));
      fireEvent.click(screen.getByRole("button", { name: "编辑箱体" }));
      expect(screen.getByLabelText("箱体关键词")).toBe(input);
      expect((input as HTMLInputElement).value).toBe("箱体");
      expect(surface?.hasAttribute("inert")).toBe(false);
      act(() => vi.advanceTimersByTime(420));
      expect(screen.getByLabelText("箱体关键词")).toBe(input);
      fireEvent.keyDown(input, { key: "Escape" });
      act(() => vi.advanceTimersByTime(420));
      expect(screen.queryByLabelText("箱体关键词")).toBeNull();
      view.unmount();
    } finally {
      vi.useRealTimers();
      if (previousMotion === undefined) delete document.documentElement.dataset.reducedMotion;
      else document.documentElement.dataset.reducedMotion = previousMotion;
    }
  });

  test("commits the requested order without changing numbers or body", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "排序" });
    patent.referenceMarks = [
      { referenceMarkId: "first", number: 8, keyword: "底座" },
      { referenceMarkId: "second", number: 3, keyword: "丝杆" },
    ];
    const original = JSON.stringify(patent);
    const onReorder = vi.fn(() => ({ ok: true, message: "" }));
    const props = {
      patent,
      onReorder,
      missingReferenceMarkIds: new Set<string>(),
      onSetSynchronizedEditing: () => ({ ok: true, message: "" }),
      onEdit: () => ({ ok: true, message: "" }),
      onCancel: () => ({ ok: true, message: "" }),
    };
    const view = render(<ReferenceMarkPanel {...props} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "调整底座位置" }), {
      altKey: true,
      key: "ArrowDown",
    });
    const order = () =>
      [...document.querySelectorAll("[data-reference-list-id]")].map((row) =>
        row.getAttribute("data-reference-list-id"),
      );
    expect(onReorder).toHaveBeenCalledWith(["second", "first"]);
    expect(JSON.stringify(patent)).toBe(original);
    const reordered = { ...patent, referenceMarks: [...patent.referenceMarks].reverse() };
    view.rerender(<ReferenceMarkPanel {...props} patent={reordered} />);
    expect(order()).toEqual(["second", "first"]);
    view.unmount();
    render(<ReferenceMarkPanel {...props} patent={reordered} />);
    expect(order()).toEqual(["second", "first"]);
    expect(screen.getByRole("button", { name: "调整底座位置" }).title).toContain("拖动");
  });
  test("highlights the active keyword and only scrolls its rail when outside the visible area", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "定位" });
    patent.referenceMarks = [{ referenceMarkId: "mark-1", number: 1, keyword: "防护壳" }];
    const props = {
      patent,
      missingReferenceMarkIds: new Set<string>(),
      onSetSynchronizedEditing: () => ({ ok: true, message: "" }),
      onEdit: () => ({ ok: true, message: "" }),
      onCancel: () => ({ ok: true, message: "" }),
    };
    const ui = (activeReferenceMarkId: string | null) => (
      <div className="patent-global-function-rail">
        <ReferenceMarkPanel {...props} activeReferenceMarkId={activeReferenceMarkId} />
      </div>
    );
    const view = render(ui(null));
    const row = screen
      .getByText("防护壳")
      .closest(".reference-mark-panel__rows > div") as HTMLElement;
    const rail = view.container.querySelector(".patent-global-function-rail") as HTMLElement;
    const scrollTo = vi.fn();
    rail.scrollTo = scrollTo;
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 400,
      height: 300,
    } as DOMRect);
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: 700,
      bottom: 740,
      height: 40,
    } as DOMRect);
    view.rerender(ui("mark-1"));
    expect(row.classList.contains("is-keyword-active")).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 470, behavior: "smooth" });
    view.rerender(ui(null));
    expect(row.classList.contains("is-keyword-active")).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  test("keeps keyword selectable, highlights on click and edits on double click", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "关键词选择" });
    const id = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId: id, number: 1, keyword: "电池包主体" }];
    const onActivateKeyword = vi.fn();
    const props = {
      patent,
      missingReferenceMarkIds: new Set<string>(),
      onSetSynchronizedEditing: () => ({ ok: true, message: "" }),
      onEdit: () => ({ ok: true, message: "" }),
      onCancel: () => ({ ok: true, message: "" }),
      onActivateKeyword,
    };
    const { rerender } = render(<ReferenceMarkPanel {...props} keywordHighlightEnabled />);
    const keyword = screen.getByText("电池包主体");
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(keyword);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe("电池包主体");
    expect(fireEvent.mouseDown(keyword, { detail: 1 })).toBe(true);
    fireEvent.click(keyword);
    expect(onActivateKeyword).toHaveBeenCalledExactlyOnceWith(id);
    fireEvent.click(keyword, { detail: 2 });
    expect(onActivateKeyword).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("电池包主体关键词")).toBeNull();
    rerender(<ReferenceMarkPanel {...props} keywordHighlightEnabled={false} />);
    fireEvent.click(keyword);
    expect(onActivateKeyword).toHaveBeenCalledTimes(1);
    await userEvent.setup().dblClick(keyword);
    expect(screen.getByLabelText("电池包主体关键词")).toBeDefined();
    expect(onActivateKeyword).toHaveBeenCalledTimes(1);
  });

  test("double clicking a keyword does not bypass a number mismatch lock", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "关键词编辑限制" });
    const id = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId: id, number: 1, keyword: "箱体" }];
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        mismatchReferenceMarkIds={new Set([id])}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    const menu = screen.getByRole("button", { name: "编辑箱体" }) as HTMLButtonElement;
    expect(menu.disabled).toBe(true);
    fireEvent.doubleClick(screen.getByText("箱体"));
    expect(screen.queryByLabelText("箱体关键词")).toBeNull();
  });

  test("a missing keyword can be corrected without removing its registration", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "登记纠错" });
    const id = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId: id, number: 10, keyword: "错词" }];
    const onEdit = vi.fn(() => ({ ok: true, message: "已保存" }));
    render(<ReferenceMarkPanel patent={patent} missingReferenceMarkIds={new Set([id])}
      missingReferenceMarkBooks={new Map([[id, ["claims", "description"]]])}
      onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
      onEdit={onEdit} onCancel={() => ({ ok: true, message: "" })} />);
    await user.click(screen.getByRole("button", { name: "修改标记：错词" }));
    await user.clear(screen.getByLabelText("错词序号"));
    await user.type(screen.getByLabelText("错词序号"), "11");
    await user.clear(screen.getByLabelText("错词关键词"));
    await user.type(screen.getByLabelText("错词关键词"), "传动杆");
    await user.click(screen.getByRole("button", { name: "保存错词" }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({referenceMarkId:id, number:11, keyword:"传动杆"});
  });

  test("releasing a dragged handle does not highlight or edit the keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "拖动关键词" });
    const id = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId: id, number: 1, keyword: "箱体" }];
    const onActivateKeyword = vi.fn();
    const onReorder = vi.fn(() => ({ ok: true, message: "" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        keywordHighlightEnabled
        onActivateKeyword={onActivateKeyword}
        onReorder={onReorder}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    const handle = screen.getByRole("button", { name: "调整箱体位置" });
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => false;
    const pointer = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { pointerId: 1, button: 0, clientY });
      return event;
    };
    fireEvent(handle, pointer("pointerdown", 10));
    fireEvent(window, pointer("pointermove", 30));
    expect(document.documentElement.dataset.referenceMarkDragging).toBe("true");
    fireEvent(window, pointer("pointerup", 30));
    expect(onReorder).toHaveBeenCalledWith([id]);
    fireEvent.click(handle);
    fireEvent.doubleClick(handle);
    expect(onActivateKeyword).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("箱体关键词")).toBeNull();
    fireEvent.click(screen.getByText("箱体"));
    expect(onActivateKeyword).toHaveBeenCalledExactlyOnceWith(id);
  });

  test.each(["missing", "mismatch", "warning"] as const)(
    "marks the whole %s row as an issue and clears it after correction",
    (issue) => {
      const patent = createBlankPatent({ patentType: "invention", name: "问题边框" });
      const referenceMarkId = crypto.randomUUID();
      patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
      const props = {
        patent,
        missingReferenceMarkIds: new Set<string>(),
        onSetSynchronizedEditing: () => ({ ok: true, message: "" }),
        onEdit: () => ({ ok: true, message: "" }),
        onCancel: () => ({ ok: true, message: "" }),
      };
      const { container, rerender } = render(
        <ReferenceMarkPanel
          {...props}
          missingReferenceMarkIds={new Set(issue === "missing" ? [referenceMarkId] : [])}
          mismatchReferenceMarkIds={new Set(issue === "mismatch" ? [referenceMarkId] : [])}
          warningMessages={new Map(issue === "warning" ? [[referenceMarkId, ["编号不匹配"]]] : [])}
        />,
      );
      expect(container.querySelector(".reference-mark-panel__rows > .is-issue")).not.toBeNull();
      rerender(<ReferenceMarkPanel {...props} />);
      expect(container.querySelector(".reference-mark-panel__rows > .is-issue")).toBeNull();
    },
  );

  test.each(["number", "keyword"] as const)(
    "saves %s edits with Enter and cancels with Escape",
    async (field) => {
      const user = userEvent.setup();
      const patent = createBlankPatent({ patentType: "invention", name: "键盘操作" });
      const referenceMarkId = crypto.randomUUID();
      patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
      const onEdit = vi.fn(() => ({ ok: true, message: "已保存" }));
      render(
        <ReferenceMarkPanel
          patent={patent}
          missingReferenceMarkIds={new Set()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={onEdit}
          onCancel={() => ({ ok: true, message: "" })}
        />,
      );
      const label = field === "number" ? "箱体序号" : "箱体关键词";
      await user.click(screen.getByRole("button", { name: "编辑箱体" }));
      const input = screen.getByLabelText(label);
      await user.clear(input);
      await user.type(input, field === "number" ? "3" : "外壳");
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      expect(onEdit).not.toHaveBeenCalled();
      await user.keyboard("{Enter}");
      expect(onEdit).toHaveBeenCalledExactlyOnceWith({
        referenceMarkId,
        number: field === "number" ? 3 : 1,
        keyword: field === "keyword" ? "外壳" : "箱体",
      });
      await user.click(screen.getByRole("button", { name: "编辑箱体" }));
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), field === "number" ? "4" : "机壳");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
      await user.click(screen.getByRole("button", { name: "编辑箱体" }));
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(
        field === "number" ? "1" : "箱体",
      );
      expect(onEdit).toHaveBeenCalledOnce();
    },
  );

  test("disables previous and next when only one issue is located", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "单处定位" });
    const referenceMarkId = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    const onNavigateLocatedIssue = vi.fn();
    const onCancelLocatedIssues = vi.fn();
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        locatedIssueState={{ referenceMarkId, count: 1, activeIndex: 0 }}
        onNavigateLocatedIssue={onNavigateLocatedIssue}
        onCancelLocatedIssues={onCancelLocatedIssues}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    const locator = screen.getByRole("group", { name: "定位箱体的问题" });
    for (const name of ["上一处", "下一处"]) {
      const button = within(locator).getByRole("button", { name });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      await userEvent.click(button);
    }
    expect(onNavigateLocatedIssue).not.toHaveBeenCalled();
    expect(within(locator).getByText("1 / 1")).toBeTruthy();
    await userEvent.click(within(locator).getByRole("button", { name: "结束定位" }));
    expect(onCancelLocatedIssues).toHaveBeenCalledOnce();
  });
  test("runs configured sequential and custom numbering shortcuts", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "组件测试" });
    const onAssignReferenceNumber = vi.fn(() => ({ ok: true, message: "" }));
    render(
      <ShortcutProvider
        settings={{
          ...DEFAULT_SHORTCUT_SETTINGS,
          "assign-reference-number": "F7",
          "assign-custom-reference-number": "F8",
        }}
      >
        <ReferenceMarkPanel
          patent={patent}
          missingReferenceMarkIds={new Set()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={() => ({ ok: true, message: "" })}
          onCancel={() => ({ ok: true, message: "" })}
          onAssignReferenceNumber={onAssignReferenceNumber}
        />
      </ShortcutProvider>,
    );

    expect(screen.getByRole("button", { name: "顺序编号" }).getAttribute("aria-keyshortcuts")).toBe(
      "F7",
    );
    expect(screen.getByRole("button", { name: "顺序编号" }).hasAttribute("title")).toBe(false);
    expect(screen.getByText("需要在权利要求书中选择关键词进行编号。")).toBeTruthy();
    expect(screen.getByText("暂无附图标记").tagName).toBe("SPAN");
    expect(
      screen
        .getByRole("button", { name: "顺序编号" })
        .querySelector("svg")
        ?.getAttribute("stroke-width"),
    ).toBe("1.5");
    expect(
      screen
        .getByRole("button", { name: "自定义编号" })
        .querySelector("svg")
        ?.getAttribute("stroke-width"),
    ).toBe("1.5");
    expect(
      screen.getByRole("button", { name: "自定义编号" }).getAttribute("aria-keyshortcuts"),
    ).toBe("F8");
    expect(screen.getByRole("button", { name: "自定义编号" }).hasAttribute("title")).toBe(false);
    fireEvent.keyDown(window, { code: "F7", key: "F7" });
    expect(onAssignReferenceNumber).toHaveBeenCalledWith();
    fireEvent.keyDown(window, { code: "F8", key: "F8" });
    expect(screen.getByLabelText("自定义编号数字")).toBeTruthy();
  });

  test("hides cross-document editing while keeping claims-only mark editing available", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "组件测试" });
    const referenceMarkId = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarkSettings.pendingReview = {
      referenceMarkId,
      ownerBookKind: "claims",
      previousNumber: 1,
      previousKeyword: "旧箱体",
      number: 1,
      keyword: "箱体",
      counts: { claims: 1, description: 1, abstract: 1 },
      createdAt: "2026-09-02T00:00:00.000Z",
    };

    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    expect(screen.queryByRole("checkbox", { name: "跨文档同步修改" })).toBeNull();
    expect(screen.queryByText(/请在所有文档中核对/u)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "编辑箱体" }));
    expect(screen.getByLabelText("箱体序号")).toBeTruthy();
    expect(screen.getByLabelText("箱体关键词")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消箱体编号" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "填入说明书" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
  });

  crossDocumentEditingTest("explains synchronized editing before the first enable", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "组件测试" });
    const onSet = vi.fn(() => ({ ok: true, message: "" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        introDismissed={false}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={onSet}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    const editingSwitch = screen.getByRole("checkbox", { name: "跨文档同步修改" });
    const editingLabel = editingSwitch.parentElement;
    expect(editingLabel?.querySelector(".reference-mark-panel__switch-label")?.textContent).toBe(
      "跨文档同步修改",
    );
    expect(
      editingLabel?.lastElementChild?.classList.contains("reference-mark-panel__switch-control"),
    ).toBe(true);
    await userEvent.click(editingSwitch);
    expect(
      screen.getByRole("dialog", { name: "同步修改说明" }).classList.contains("standard-dialog--m"),
    ).toBe(true);
    expect(onSet).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "同步修改说明" })).toBeNull();
    expect(onSet).not.toHaveBeenCalled();
  });
  test("shows editable claims-only rows and copies the combined text", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "组件测试" });
    patent.referenceMarks = [
      { referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" },
      { referenceMarkId: crypto.randomUUID(), number: 2, keyword: "箱盖" },
    ];
    const writeText = vi.fn(async () => ({ ok: true as const, value: undefined }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { clipboard: { writeText } },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => Promise.reject(new Error("browser clipboard denied"))),
      },
    });
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    expect(screen.queryByRole("list", { name: "附图标记列表" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "编辑箱体" }));
    expect(screen.getByLabelText("箱体序号")).toBeTruthy();
    expect(screen.getByLabelText("箱体关键词")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "编辑箱盖" }));
    expect(screen.getByLabelText("箱盖序号")).toBeTruthy();
    expect(screen.getByLabelText("箱盖关键词")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("1、箱体；2、箱盖");
  });

  test("shows an error when clipboard writing fails", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "复制失败" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        clipboard: {
          writeText: vi.fn(async () => ({
            ok: false as const,
            error: {
              code: "NO_PERMISSION" as const,
              message: "denied",
              nextAction: "retry",
            },
          })),
        },
      },
    });
    const onOperationFeedback = vi.fn();
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onOperationFeedback={onOperationFeedback}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "error",
      title: "复制失败",
      message: "无法写入剪贴板，请重试。",
    });
  });

  test("identifies both books when the registered keyword is missing from both", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "缺词提示" });
    const referenceMarkId = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set([referenceMarkId])}
        missingReferenceMarkBooks={new Map([[referenceMarkId, ["claims", "description"]]])}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    const item = screen
      .getByRole("button", { name: "编辑箱体" })
      .closest(".reference-mark-panel__rows > div");
    if (!(item instanceof HTMLElement)) throw new Error("reference-mark row not found");
    expect(within(item).getByText("未找到关键词：权利要求书、说明书。")).toBeTruthy();
  });

  test("does not mark an entry missing when only the description lacks its keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "说明书尚未撰写" });
    const referenceMarkId = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set([referenceMarkId])}
        missingReferenceMarkBooks={new Map([[referenceMarkId, ["description"]]])}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    const item = screen
      .getByRole("button", { name: "编辑箱体" })
      .closest(".reference-mark-panel__rows > div");
    if (!(item instanceof HTMLElement)) throw new Error("reference-mark row not found");
    expect(item.className).not.toContain("is-missing");
    expect(within(item).queryByText(/缺少关键词/u)).toBeNull();
  });

  test("waits for a manual fill attempt before explaining a description structure problem", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "手动填入提示" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    const onFillReferenceMarks = vi.fn(() => ({
      ok: false,
      message: "找不到说明书中的“附图说明”部分。请先在说明书中添加“附图说明”标题，然后重试。",
    }));
    const onOperationFeedback = vi.fn();
    render(
      <ReferenceMarkPanel
        patent={patent}
        sync={{ status: "paused", message: "附图标记结构已被破坏，已暂停同步。" }}
        referenceMarkDescription={{
          status: "different",
          currentText: "",
          targetText: "其中：1、箱体。",
        }}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onFillReferenceMarks={onFillReferenceMarks}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onOperationFeedback={onOperationFeedback}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("全文档编辑暂停")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "填入说明书" }));

    expect(onFillReferenceMarks).toHaveBeenCalledOnce();
    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "error",
      title: "无法填入",
      message: "找不到说明书中的“附图说明”部分。请先在说明书中添加“附图说明”标题，然后重试。",
    });
  });

  crossDocumentEditingTest(
    "shows paused sync and disables structured editing for a damaged legend",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "暂停测试" });
      patent.referenceMarkSettings.synchronizedEditingEnabled = true;
      patent.referenceMarks = [
        { referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" },
      ];
      render(
        <ReferenceMarkPanel
          patent={patent}
          sync={{ status: "paused", message: "附图标记格式无效，已暂停同步。" }}
          missingReferenceMarkIds={new Set()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={() => ({ ok: true, message: "" })}
          onCancel={() => ({ ok: true, message: "" })}
        />,
      );
      expect(screen.getByRole("alert").textContent).toContain("同步已暂停");
      expect((screen.getByLabelText("箱体序号") as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByLabelText("箱体关键词") as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByRole("button", { name: "复制" }).hasAttribute("disabled")).toBe(false);
    },
  );

  test("removes the full-document status label and keeps fill/copy actions with clear placement", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "动作布局" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    const onFillReferenceMarks = vi.fn(() => ({ ok: true, message: "已填入说明书。" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        referenceMarkDescription={{
          status: "different",
          currentText: "",
          targetText: "其中：1、箱体。",
        }}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onFillReferenceMarks={onFillReferenceMarks}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    // “全文档编辑可用/暂停”状态标签已删除。
    expect(screen.queryByText("全文档编辑可用")).toBeNull();
    expect(screen.queryByText("全文档编辑暂停")).toBeNull();

    // “填入说明书”与“复制”保留在同一操作行，停用的全文档编辑开关不再显示。
    const fillButton = screen.getByRole("button", { name: "填入说明书" });
    expect(fillButton.closest(".reference-mark-panel__header")).toBeNull();
    const syncRow = fillButton.closest(".reference-mark-panel__sync-row");
    expect(syncRow).not.toBeNull();
    expect(
      within(syncRow as HTMLElement).queryByRole("checkbox", { name: "跨文档同步修改" }),
    ).toBeNull();

    // “复制”紧跟在“填入说明书”右侧，可访问名称不变。
    const copyButton = screen.getByRole("button", { name: "复制" });
    expect(copyButton.closest(".reference-mark-panel__sync-row")).toBe(syncRow);
    const actions = fillButton.closest(".reference-mark-panel__actions");
    expect(actions?.children[0]).toBe(screen.getByRole("button", { name: "新增附图标记" }));
    expect(actions?.children[1]).toBe(fillButton);
    expect(actions?.children[2]).toBe(copyButton);
    expect(actions?.children).toHaveLength(3);

    await userEvent.click(fillButton);
    expect(onFillReferenceMarks).toHaveBeenCalledOnce();
  });

  crossDocumentEditingTest(
    "keeps full-document editing available before reference marks are manually filled",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "手动填入解耦" });
      patent.referenceMarkSettings.synchronizedEditingEnabled = true;
      patent.referenceMarks = [
        { referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" },
      ];
      render(
        <ReferenceMarkPanel
          patent={patent}
          referenceMarkDescription={{
            status: "different",
            currentText: "",
            targetText: "其中：1、箱体。",
          }}
          missingReferenceMarkIds={new Set()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={() => ({ ok: true, message: "" })}
          onCancel={() => ({ ok: true, message: "" })}
        />,
      );

      expect(
        (screen.getByRole("checkbox", { name: "跨文档同步修改" }) as HTMLInputElement).disabled,
      ).toBe(false);
      expect((screen.getByLabelText("箱体关键词") as HTMLInputElement).disabled).toBe(false);
      expect(screen.queryByText("全文档编辑已暂停")).toBeNull();
    },
  );

  test("confirms overwriting the description via an in-app dialog instead of window.confirm", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "覆盖确认" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    const onFillReferenceMarks = vi.fn(() => ({ ok: true, message: "已填入说明书。" }));
    const confirmSpy = vi.spyOn(window, "confirm");
    render(
      <ReferenceMarkPanel
        patent={patent}
        referenceMarkDescription={{
          status: "different",
          currentText: "其中：1、箱体。",
          targetText: "其中：2、箱盖。",
        }}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onFillReferenceMarks={onFillReferenceMarks}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    // 点击“填入说明书”：出现应用内确认弹窗，不使用系统原生 confirm。
    await user.click(screen.getByRole("button", { name: "填入说明书" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "填入附图标记" });
    expect(dialog.classList.contains("standard-dialog--m")).toBe(true);
    expect(within(dialog).getByText("其中：1、箱体。")).toBeDefined();
    expect(within(dialog).getByText("其中：2、箱盖。")).toBeDefined();
    expect(onFillReferenceMarks).not.toHaveBeenCalled();

    // 取消：不执行填入。
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "填入附图标记" })).toBeNull();
    expect(onFillReferenceMarks).not.toHaveBeenCalled();

    // 再次打开并确认覆盖：执行填入。
    await user.click(screen.getByRole("button", { name: "填入说明书" }));
    await user.click(screen.getByRole("button", { name: "确认覆盖" }));
    expect(onFillReferenceMarks).toHaveBeenCalledOnce();
    confirmSpy.mockRestore();
  });

  test("allows an aligned legend to be filled again after explicit replacement confirmation", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "重复填入" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    const onFillReferenceMarks = vi.fn(() => ({ ok: true, message: "已填入说明书。" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        referenceMarkDescription={{
          status: "aligned",
          currentText: "其中：1、箱体。",
          targetText: "其中：1、箱体。",
        }}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onFillReferenceMarks={onFillReferenceMarks}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    const fillButton = screen.getByRole("button", { name: "填入说明书" });
    expect(fillButton.hasAttribute("disabled")).toBe(false);
    await user.click(fillButton);
    const dialog = screen.getByRole("dialog", { name: "填入附图标记" });
    expect(within(dialog).getByText("将替换说明书当前的附图标记")).toBeDefined();
    expect(onFillReferenceMarks).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "确认覆盖" }));
    expect(onFillReferenceMarks).toHaveBeenCalledOnce();
  });

  test("does not submit on blur and saves one edited row explicitly", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "行编辑" });
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009991", number: 1, keyword: "箱体" },
    ];
    const onEdit = vi.fn(() => ({ ok: true, message: "" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={onEdit}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "编辑箱体" }));
    const numberInput = screen.getByLabelText("箱体序号");
    const keywordInput = screen.getByLabelText("箱体关键词");
    await user.click(numberInput);
    await user.clear(numberInput);
    await user.type(numberInput, "2");
    await user.click(keywordInput);
    await user.tab();
    expect(onEdit).toHaveBeenCalledTimes(0);
    await user.click(screen.getByRole("button", { name: "保存箱体" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({
      referenceMarkId: "00000000-0000-4000-8000-000000009991",
      number: 2,
      keyword: "箱体",
    });
  });

  test("cancels an unsaved row edit without changing the patent", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "单次提交" });
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009990", number: 1, keyword: "箱体" },
    ];
    const onEdit = vi.fn(() => ({ ok: true, message: "" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={onEdit}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "编辑箱体" }));
    const numberInput = screen.getByLabelText("箱体序号");
    await user.click(numberInput);
    await user.clear(numberInput);
    await user.type(numberInput, "3");
    await user.click(screen.getByRole("button", { name: "取消箱体修改" }));
    expect(onEdit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText("箱体序号")).toBeNull());
    await user.click(screen.getByRole("button", { name: "编辑箱体" }));
    expect((screen.getByLabelText("箱体序号") as HTMLInputElement).value).toBe("1");
  });

  test("allows only one reference-mark row to be edited at a time", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "单项编辑" });
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009972", number: 1, keyword: "箱体" },
      { referenceMarkId: "00000000-0000-4000-8000-000000009973", number: 2, keyword: "箱盖" },
    ];
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "编辑箱体" }));
    const firstKeyword = screen.getByLabelText("箱体关键词");
    const secondEdit = screen.getByRole("button", { name: "编辑箱盖" }) as HTMLButtonElement;
    await user.clear(firstKeyword);
    await user.type(firstKeyword, "新箱体");

    expect(secondEdit.disabled).toBe(true);
    await user.click(secondEdit);
    expect(screen.queryByLabelText("箱盖关键词")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "跨文档同步修改" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "取消箱体修改" }));
    expect(secondEdit.disabled).toBe(false);
    await user.click(secondEdit);
    expect(screen.getByLabelText("箱盖关键词")).toBeTruthy();
  });

  test("keeps the draft and shows an inline error for duplicate values", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "重复值" });
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009989", number: 1, keyword: "箱体" },
      { referenceMarkId: "00000000-0000-4000-8000-000000009988", number: 2, keyword: "箱盖" },
    ];
    const onEdit = vi.fn(() => ({ ok: true, message: "" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={onEdit}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "编辑箱体" }));
    const numberInput = screen.getByLabelText("箱体序号");
    await user.click(numberInput);
    await user.clear(numberInput);
    await user.type(numberInput, "2");
    await user.click(screen.getByRole("button", { name: "保存箱体" }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("不能重复");
    expect((numberInput as HTMLInputElement).value).toBe("2");
  });

  test("clearing a field shows validation and never deletes implicitly", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "清空取消" });
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009987", number: 1, keyword: "箱体" },
    ];
    const onCancel = vi.fn(() => ({ ok: true, message: "" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: "编辑箱体" }));
    const numberInput = screen.getByLabelText("箱体序号");
    await user.click(numberInput);
    await user.clear(numberInput);
    await user.click(screen.getByRole("button", { name: "保存箱体" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("不能为空");
  });

  test("cancels numbering through an application confirmation dialog", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "显式删除" });
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009985", number: 1, keyword: "箱体" },
    ];
    const onCancel = vi.fn(() => ({ ok: true, message: "已删除。" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "编辑箱体" }));
    expect(screen.getByRole("button", { name: "取消箱体编号" }).textContent).toBe("取消编号");
    await user.click(screen.getByRole("button", { name: "取消箱体编号" }));
    const dialog = screen.getByRole("alertdialog", { name: "取消附图标记编号" });
    expect(dialog.textContent).toContain("仅取消权利要求书");
    expect(dialog.textContent).toContain("说明书、说明书摘要和已填入的图例保持不变");
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "确认取消编号" }));
    expect(onCancel).toHaveBeenCalledWith("00000000-0000-4000-8000-000000009985");
  });

  crossDocumentEditingTest(
    "explains why cross-document sync is unavailable in the empty state",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "暂停空状态" });
      render(
        <ReferenceMarkPanel
          patent={patent}
          sync={{ status: "paused", message: "附图说明标题不存在，已暂停同步。" }}
          missingReferenceMarkIds={new Set()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={() => ({ ok: true, message: "" })}
          onCancel={() => ({ ok: true, message: "" })}
          onRepairSync={() => undefined}
        />,
      );

      expect(screen.getByRole("status").textContent).toContain("附图说明标题不存在");
      expect(screen.getByText("暂无附图标记")).toBeTruthy();
      expect(screen.getByRole("button", { name: "前往说明书修复" })).toBeTruthy();
      expect(
        (screen.getByRole("checkbox", { name: "跨文档同步修改" }) as HTMLInputElement).disabled,
      ).toBe(true);
    },
  );

  crossDocumentEditingTest(
    "keeps numbering buttons and shortcuts consistent while sync is paused",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "暂停编号" });
      patent.referenceMarkSettings.synchronizedEditingEnabled = true;
      render(
        <ShortcutProvider settings={DEFAULT_SHORTCUT_SETTINGS}>
          <ReferenceMarkPanel
            patent={patent}
            sync={{ status: "paused", message: "附图说明格式异常。" }}
            missingReferenceMarkIds={new Set()}
            onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
            onEdit={() => ({ ok: true, message: "" })}
            onCancel={() => ({ ok: true, message: "" })}
            onAssignReferenceNumber={() => ({ ok: true, message: "" })}
          />
        </ShortcutProvider>,
      );

      expect((screen.getByRole("button", { name: "顺序编号" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(
        (screen.getByRole("button", { name: "自定义编号" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    },
  );

  test("offers inline recovery actions for inconsistent marks", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "异常恢复" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009985";
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    const onLocateIssue = vi.fn();
    const onRemoveRegistration = vi.fn(() => ({ ok: true, message: "已移除登记。" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set([referenceMarkId])}
        locatableIssueCounts={new Map([[referenceMarkId, 2]])}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onLocateIssue={onLocateIssue}
        onRemoveRegistration={onRemoveRegistration}
      />,
    );

    expect(screen.getByText("未找到关键词：权利要求书。")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "处理附图标记问题" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "定位问题" }));
    expect(onLocateIssue).toHaveBeenCalledWith(referenceMarkId);

    const remove = screen.getByRole("button", { name: "移出标记：箱体" });
    expect(remove.textContent).toBe("移出标记");
    await user.click(remove);
    const dialog = screen.getByRole("alertdialog", { name: "移出标记" });
    expect(dialog.classList.contains("reference-mark-remove-dialog")).toBe(true);
    expect(within(dialog).getByText("关键词")).toBeTruthy();
    expect(within(dialog).getByText("箱体")).toBeTruthy();
    expect(within(dialog).getByText("仅移出标记列表，不修改正文和编号。")).toBeTruthy();
    expect(onRemoveRegistration).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog", { name: "移出标记" })).toBeNull();
    expect(onRemoveRegistration).not.toHaveBeenCalled();

    await user.click(remove);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", { name: "移出标记" })).toBeNull();
    expect(onRemoveRegistration).not.toHaveBeenCalled();

    await user.click(remove);
    await user.click(screen.getByRole("button", { name: "关闭移出标记" }));
    expect(onRemoveRegistration).not.toHaveBeenCalled();

    await user.click(remove);
    await user.click(
      within(screen.getByRole("alertdialog", { name: "移出标记" })).getByRole("button", {
        name: "确认移出",
      }),
    );
    expect(onRemoveRegistration).toHaveBeenCalledWith(referenceMarkId);
    expect(onRemoveRegistration).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog", { name: "移出标记" })).toBeNull();
  });

  test("does not offer a guessed location for a fully missing keyword", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "缺失关键词" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009986";
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    const onLocateIssue = vi.fn();
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set([referenceMarkId])}
        locatableIssueCounts={new Map([[referenceMarkId, 0]])}
        onLocateIssue={onLocateIssue}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    expect(screen.queryByRole("button", { name: "定位问题" })).toBeNull();
    expect(onLocateIssue).not.toHaveBeenCalled();
  });

  test("shows the located count and navigation controls on the affected row", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "问题导航" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009987";
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    const onNavigateLocatedIssue = vi.fn();
    const onCancelLocatedIssues = vi.fn();
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        mismatchReferenceMarkIds={new Set([referenceMarkId])}
        locatableIssueCounts={new Map([[referenceMarkId, 3]])}
        locatedIssueState={{ referenceMarkId, count: 3, activeIndex: 1 }}
        onNavigateLocatedIssue={onNavigateLocatedIssue}
        onCancelLocatedIssues={onCancelLocatedIssues}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    const locator = screen.getByRole("group", { name: "定位箱体的问题" });
    expect(locator.textContent).toContain("共定位 3 处");
    expect(locator.textContent).toContain("2 / 3");
    await userEvent.click(within(locator).getByRole("button", { name: "上一处" }));
    await userEvent.click(within(locator).getByRole("button", { name: "下一处" }));
    await userEvent.click(within(locator).getByRole("button", { name: "结束定位" }));
    expect(onNavigateLocatedIssue).toHaveBeenNthCalledWith(1, "previous");
    expect(onNavigateLocatedIssue).toHaveBeenNthCalledWith(2, "next");
    expect(onCancelLocatedIssues).toHaveBeenCalledOnce();
  });

  test("places the numbering action inside the panel", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "编号入口" });
    const onAssign = vi.fn();
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onAssignReferenceNumber={onAssign}
      />,
    );
    expect(screen.getByText("需要在权利要求书中选择关键词进行编号。")).toBeTruthy();
    expect(screen.queryByText("系统会自动分配下一个可用序号")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "顺序编号" }));
    expect(onAssign).toHaveBeenCalledTimes(1);
  });

  test("expands a focused custom-number row and confirms with Enter", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "自定义编号" });
    const onAssign = vi.fn(() => ({ ok: true, message: "编号完成。" }));
    const onCustomNumberOpenChange = vi.fn();
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onAssignReferenceNumber={onAssign}
        onCustomNumberOpenChange={onCustomNumberOpenChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "自定义编号" }));
    const input = screen.getByRole("textbox", { name: "自定义编号数字" });
    expect(screen.getByText("指定编号")).toBeTruthy();
    expect(input.getAttribute("placeholder")).toBe("请输入正整数");
    expect(document.activeElement).toBe(input);
    expect(onCustomNumberOpenChange).toHaveBeenLastCalledWith(true);
    await user.type(input, "12{Enter}");

    expect(onAssign).toHaveBeenCalledWith(12);
    expect(onCustomNumberOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("textbox", { name: "自定义编号数字" })).toBeNull();
  });

  test("shows red validation, selects the invalid number, and supports both cancel paths", async () => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "自定义编号校验" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009984", number: 7, keyword: "箱盖" },
    ];
    const onAssign = vi.fn(() => ({ ok: true, message: "编号完成。" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onAssignReferenceNumber={onAssign}
      />,
    );

    await user.click(screen.getByRole("button", { name: "自定义编号" }));
    const input = screen.getByRole("textbox", { name: "自定义编号数字" }) as HTMLInputElement;
    await user.type(input, "7");
    await user.click(screen.getByRole("button", { name: "确认自定义编号" }));
    const error = screen.getByRole("alert");
    expect(error.textContent).toContain("已被“箱盖”使用");
    expect(error.className).toContain("reference-mark-panel__custom-error");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "自定义编号数字" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "自定义编号" }));
    await user.click(screen.getByRole("button", { name: "取消自定义编号" }));
    expect(screen.queryByRole("textbox", { name: "自定义编号数字" })).toBeNull();
    expect(onAssign).not.toHaveBeenCalled();
  });

  test.each(["1e3", "02", "+2"])("rejects non-decimal custom number syntax %s", async (value) => {
    const user = userEvent.setup();
    const patent = createBlankPatent({ patentType: "invention", name: "严格序号" });
    const onAssign = vi.fn(() => ({ ok: true, message: "编号完成。" }));
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onAssignReferenceNumber={onAssign}
      />,
    );

    await user.click(screen.getByRole("button", { name: "自定义编号" }));
    const input = screen.getByRole("textbox", { name: "自定义编号数字" });
    await user.type(input, value);
    await user.click(screen.getByRole("button", { name: "确认自定义编号" }));

    expect(screen.getByRole("alert").textContent).toContain("十进制正整数");
    expect(onAssign).not.toHaveBeenCalled();
  });

  test("shows detailed non-blocking warnings for a registered mark", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "详细警告" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009983", number: 1, keyword: "箱体" },
    ];
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        warningMessages={
          new Map([
            [
              "00000000-0000-4000-8000-000000009983",
              ["权利要求书中有 2 处“箱体”未编号", "有 1 处编号格式不规范"],
            ],
          ])
        }
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );

    expect(screen.getByText("权利要求书中有 2 处“箱体”未编号")).toBeTruthy();
    expect(screen.getByText("有 1 处编号格式不规范")).toBeTruthy();
  });

  test("shows an amber mismatch warning for inconsistent body numbers", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "一致性" });
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009986", number: 1, keyword: "箱体" },
    ];
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        mismatchReferenceMarkIds={new Set(["00000000-0000-4000-8000-000000009986"])}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />,
    );
    const warning = screen.getByText("编号不一致");
    expect(warning.textContent).toBe("编号不一致");
    expect(warning.className).toContain("reference-mark-panel__warning");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "编辑箱体" }).disabled).toBe(true);
  });

  crossDocumentEditingTest(
    "shows one inline review task and blocks further row edits until completion",
    async () => {
      const user = userEvent.setup();
      const patent = createBlankPatent({ patentType: "invention", name: "待核对" });
      const referenceMarkId = "00000000-0000-4000-8000-000000009976";
      patent.referenceMarks = [{ referenceMarkId, number: 2, keyword: "新箱体" }];
      patent.referenceMarkSettings.synchronizedEditingEnabled = true;
      patent.referenceMarkSettings.pendingReview = {
        referenceMarkId,
        ownerBookKind: "claims",
        previousNumber: 1,
        previousKeyword: "箱体",
        number: 2,
        keyword: "新箱体",
        counts: { claims: 2, description: 1, abstract: 1 },
        createdAt: "2026-09-01T00:00:00.000Z",
      };
      const onCompleteReview = vi.fn(() => ({ ok: true, message: "核对已完成。" }));
      const onNavigateReview = vi.fn();
      const onUndoReview = vi.fn(() => ({ ok: true, message: "本次修改已撤销。" }));

      render(
        <ReferenceMarkPanel
          patent={patent}
          missingReferenceMarkIds={new Set()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={() => ({ ok: true, message: "" })}
          onCancel={() => ({ ok: true, message: "" })}
          onCompleteReview={onCompleteReview}
          onNavigateReview={onNavigateReview}
          canUndoReview
          onUndoReview={onUndoReview}
        />,
      );

      expect(screen.getByText("请在所有文档中核对“新箱体”")).toBeTruthy();
      expect(
        screen.getByText("修改时命中：权利要求书 2 处 · 说明书 1 处 · 说明书摘要 1 处"),
      ).toBeTruthy();
      expect(
        (screen.getByRole("textbox", { name: "新箱体序号" }) as HTMLInputElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("textbox", { name: "新箱体关键词" }) as HTMLInputElement).disabled,
      ).toBe(true);
      await user.click(screen.getByRole("button", { name: "下一处" }));
      expect(onNavigateReview).toHaveBeenCalledWith("next");
      await user.click(screen.getByRole("button", { name: "撤销本次修改" }));
      expect(onUndoReview).toHaveBeenCalledOnce();
      await user.click(screen.getByRole("button", { name: "核对无问题" }));
      expect(onCompleteReview).toHaveBeenCalledWith(referenceMarkId);
      await user.click(screen.getByRole("button", { name: "保留当前内容并完成" }));
      expect(onCompleteReview).toHaveBeenLastCalledWith(referenceMarkId, {
        acceptCurrentDocument: true,
      });
    },
  );

  crossDocumentEditingTest(
    "keeps a persisted review visible and completable when its mark entry is missing",
    async () => {
      const user = userEvent.setup();
      const patent = createBlankPatent({ patentType: "invention", name: "异常待核对" });
      const referenceMarkId = "00000000-0000-4000-8000-000000009974";
      patent.referenceMarkSettings.pendingReview = {
        referenceMarkId,
        ownerBookKind: "description",
        previousNumber: 1,
        previousKeyword: "箱体",
        number: 2,
        keyword: "新箱体",
        counts: { claims: 0, description: 0, abstract: 0 },
        createdAt: "2026-09-01T00:00:00.000Z",
      };
      const onCompleteReview = vi.fn(() => ({ ok: true, message: "核对已完成。" }));

      const { container } = render(
        <ReferenceMarkPanel
          patent={patent}
          missingReferenceMarkIds={new Set()}
          collapsed
          onToggleCollapsed={vi.fn()}
          onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
          onEdit={() => ({ ok: true, message: "" })}
          onCancel={() => ({ ok: true, message: "" })}
          onCompleteReview={onCompleteReview}
        />,
      );

      expect((container.querySelector("#reference-mark-panel-body") as HTMLDivElement).hidden).toBe(
        false,
      );
      expect(
        (screen.getByRole("button", { name: "折叠附图标记" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      await user.click(screen.getByRole("button", { name: "核对无问题" }));
      expect(onCompleteReview).toHaveBeenCalledWith(referenceMarkId);
    },
  );

  test("collapses the panel body via the explicit toggle and keeps the title row", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "折叠标记" });
    const onToggleCollapsed = vi.fn();
    const panelProps = {
      patent,
      missingReferenceMarkIds: new Set() as ReadonlySet<string>,
      onSetSynchronizedEditing: () => ({ ok: true, message: "" }),
      onEdit: () => ({ ok: true, message: "" }),
      onCancel: () => ({ ok: true, message: "" }),
      onToggleCollapsed,
    };
    const { rerender } = render(<ReferenceMarkPanel {...panelProps} collapsed={false} />);

    const toggle = screen.getByRole("button", { name: "折叠附图标记" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("reference-mark-panel-body");
    expect(document.getElementById("reference-mark-panel-body")?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(screen.queryByRole("checkbox", { name: "跨文档同步修改" })).toBeNull();
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();

    fireEvent.click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledOnce();

    rerender(<ReferenceMarkPanel {...panelProps} collapsed={true} />);
    expect(screen.getByRole("region", { name: "附图标记" }).getAttribute("data-collapsed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "展开附图标记" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(document.getElementById("reference-mark-panel-body")?.hasAttribute("hidden")).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "跨文档同步修改" })).toBeNull();
    // 复制按钮位于折叠隐藏的正文内，折叠时不可见。
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  });

  test("toggles from the title row and keeps the copy action out of the toggle area", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "折叠点击区域" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        clipboard: {
          writeText: vi.fn(async () => ({ ok: true as const, value: undefined })),
        },
      },
    });
    const onToggleCollapsed = vi.fn();
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );

    // 标题行与折叠符号位于同一按钮内（与附图说明一致），点击即折叠。
    const toggle = screen.getByRole("button", { name: "折叠附图标记" });
    expect(toggle.querySelector(".reference-mark-panel__toggle-caret")).not.toBeNull();
    fireEvent.click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledOnce();

    // 点击复制按钮不触发折叠。
    await fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  test("omits the bottom empty container when the panel is collapsible", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "折叠空状态" });
    render(
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
        onToggleCollapsed={() => undefined}
      />,
    );

    expect(screen.queryByText("暂无附图标记")).toBeNull();
    expect(screen.queryByText("需要在权利要求书中选择关键词进行编号。")).toBeNull();
  });
});
