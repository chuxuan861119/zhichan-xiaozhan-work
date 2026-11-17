import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpenedPatent } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import type { PatentFigure } from "../../../shared/patent/model";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { ShortcutProvider } from "../app/shortcut-dispatcher";
import { PatentBookTools } from "./patent-book-tools";
import { createPatentSession, type PatentSession } from "./patent-reducer";

function session(activeBookKind: OpenedPatent["patent"]["activeBookKind"]): PatentSession {
  const patent = createBlankPatent({
    patentType: "utility-model",
    name: "环保回收装置",
  });
  patent.activeBookKind = activeBookKind;
  return createPatentSession({
    patentId: patent.patentId,
    sessionId: "session-1",
    revision: 0,
    patent,
    saveState: "saved",
  });
}

function renderTools(
  activeBookKind: OpenedPatent["patent"]["activeBookKind"],
  abstractCharacterCount = 123,
  options: {
    onCheckProblems?: () => void;
    onAiCorrection?: () => void;
    onTextPolish?: () => void;
  } = {},
) {
  return render(
    <PatentBookTools
      session={session(activeBookKind)}
      editorId={activeBookKind.includes("drawing") ? null : `session-1:${activeBookKind}`}
      abstractCharacterCount={abstractCharacterCount}
      onInsertDependentClaim={vi.fn()}
      onClearExtraFormatting={vi.fn()}
      onSelectAbstractDrawing={vi.fn()}
      onCheckProblems={options.onCheckProblems ?? vi.fn()}
      onAiCorrection={options.onAiCorrection ?? vi.fn()}
      onTextPolish={options.onTextPolish ?? vi.fn()}
    />,
  );
}

describe("patent book tools", () => {
  test.each(["claims", "description", "description-drawings"] as const)(
    "supports direct reference registration on %s", kind => {
      const add = vi.fn(() => ({ ok: true, message: "" }));
      render(<PatentBookTools session={session(kind)} editorId={`session-1:${kind}`} abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()} onSelectAbstractDrawing={vi.fn()} onAddReferenceMark={add} />);
      const plus = screen.getByRole("button", { name: "新增附图标记" });
      const fill = screen.getByRole("button", { name: "填入说明书" });
      expect(plus.nextElementSibling).toBe(fill);
      fireEvent.click(plus);
      const dialog = screen.getByRole("dialog", { name: "新增附图标记" });
      fireEvent.change(within(dialog).getByLabelText("关键词"), { target: { value: "箱体" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /^添加$/ }));
      expect(add).toHaveBeenCalledWith({ number: 1, keyword: "箱体" });
    },
  );
  test("routes every document shortcut to the active pane, including after switching panes", () => {
    const left = { clear: vi.fn(), check: vi.fn(), ai: vi.fn(), insert: vi.fn(), number: vi.fn() };
    const right = { clear: vi.fn(), check: vi.fn(), ai: vi.fn(), insert: vi.fn(), number: vi.fn() };
    const settings = {
      ...DEFAULT_SHORTCUT_SETTINGS,
      "clear-extra-formatting": "F5",
      "check-problems": "F6",
      "ai-correction": "F7",
      "insert-dependent-claim": "F8",
      "assign-reference-number": "F9",
      "assign-custom-reference-number": "F10",
    };
    const view = (active: "left" | "right") => (
      <ShortcutProvider settings={settings}>
        {(["left", "right"] as const).map((side) => {
          const actions = side === "left" ? left : right;
          return (
            <PatentBookTools
              key={side}
              session={session("claims")}
              editorId={side}
              abstractCharacterCount={0}
              shortcutsEnabled={side === active}
              onClearExtraFormatting={actions.clear}
              onCheckProblems={actions.check}
              onAiCorrection={actions.ai}
              onInsertDependentClaim={actions.insert}
              onAssignReferenceNumber={actions.number}
              onSelectAbstractDrawing={vi.fn()}
            />
          );
        })}
      </ShortcutProvider>
    );
    const { rerender } = render(view("left"));
    for (const key of ["F5", "F6", "F7", "F8", "F9"]) fireEvent.keyDown(window, { key, code: key });
    for (const action of Object.values(left)) expect(action).toHaveBeenCalledOnce();
    for (const action of Object.values(right)) expect(action).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "F10", code: "F10" });
    expect(screen.getAllByLabelText("自定义编号数字")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "取消自定义编号" }));
    rerender(view("right"));
    for (const key of ["F5", "F6", "F7", "F8", "F9"]) fireEvent.keyDown(window, { key, code: key });
    for (const action of [...Object.values(left), ...Object.values(right)])
      expect(action).toHaveBeenCalledOnce();
  });
  test("keeps claim actions before intelligent assistance", () => {
    const insert = vi.fn();
    render(
      <PatentBookTools
        session={session("claims")}
        editorId="session-1:claims"
        abstractCharacterCount={0}
        onInsertDependentClaim={insert}
        onSelectAbstractDrawing={vi.fn()}
        onPrepareClaimsDescription={vi.fn()}
        onClaimsDescriptionCopied={vi.fn()}
        onOperationFeedback={vi.fn()}
      />,
    );
    const tools = screen.getByRole("group", { name: "权利要求书工具" });
    const assistance = within(tools).getByText("智能辅助");
    const insertButton = within(tools).getByRole("button", { name: "插入从权" });
    const description = within(tools).getByRole("button", { name: /说明书/ });
    for (const action of [insertButton, description]) {
      expect(
        action.compareDocumentPosition(assistance) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    fireEvent.click(insertButton);
    expect(insert).toHaveBeenCalledOnce();
    fireEvent.click(description);
    expect(description.getAttribute("aria-expanded")).toBe("true");
  });
  test("routes supplement shortcuts only to the active dual-view pane", () => {
    const left = vi.fn();
    const right = vi.fn();
    const view = (active: "left" | "right") => (
      <ShortcutProvider
        settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "supplement-reference-numbers": "F9" }}
      >
        {(["left", "right"] as const).map((side) => (
          <PatentBookTools
            key={side}
            session={session("description")}
            editorId={side}
            abstractCharacterCount={0}
            onInsertDependentClaim={vi.fn()}
            onSelectAbstractDrawing={vi.fn()}
            supplementShortcutEnabled={active === side}
            onSupplementReferenceNumbers={side === "left" ? left : right}
          />
        ))}
      </ShortcutProvider>
    );
    const { rerender } = render(view("left"));
    fireEvent.keyDown(window, { code: "F9", key: "F9" });
    expect(left).toHaveBeenCalledOnce();
    expect(right).not.toHaveBeenCalled();
    rerender(view("right"));
    fireEvent.keyDown(window, { code: "F9", key: "F9" });
    expect(left).toHaveBeenCalledOnce();
    expect(right).toHaveBeenCalledOnce();
  });
  test.each(["description", "claims", "abstract", "description-drawings"] as const)(
    "limits supplement shortcuts to enabled claims or description: %s",
    (kind) => {
      const current = session(kind);
      const supplement = vi.fn();
      const settings = {
        ...DEFAULT_SHORTCUT_SETTINGS,
        "supplement-reference-numbers": "F9",
      };
      const view = () => (
        <ShortcutProvider settings={settings}>
          <PatentBookTools
            session={current}
            editorId={`session-1:${kind}`}
            abstractCharacterCount={0}
            onInsertDependentClaim={vi.fn()}
            onSelectAbstractDrawing={vi.fn()}
            onSupplementReferenceNumbers={supplement}
          />
        </ShortcutProvider>
      );
      const { rerender } = render(view());
      fireEvent.keyDown(window, { code: "F9", key: "F9" });
      expect(supplement).toHaveBeenCalledTimes(kind === "description" || kind === "claims" ? 1 : 0);
      if (kind === "description" || kind === "claims") {
        expect(
          screen.getByRole("button", { name: "增补编号" }).querySelector(".lucide-circle-plus"),
        ).not.toBeNull();
        expect(screen.getByRole("button", { name: "增补编号" }).hasAttribute("title")).toBe(false);
        expect(
          screen.getByRole("button", { name: "增补编号" }).getAttribute("aria-keyshortcuts"),
        ).toBe("F9");
        current.patent.drawingBooksEnabled = false;
        rerender(view());
        fireEvent.keyDown(window, { code: "F9", key: "F9" });
        expect(supplement).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "增补编号" }).hasAttribute("disabled")).toBe(
          true,
        );
      }
    },
  );
  test("single click locates a keyword and double click opens its editor", () => {
    const current = session("claims");
    const id = crypto.randomUUID();
    current.patent.referenceMarks = [{ referenceMarkId: id, number: 1, keyword: "电池包" }];
    const activate = vi.fn();
    render(
      <PatentBookTools
        session={current}
        editorId="session-1:claims"
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
        onActivateReferenceMarkKeyword={activate}
      />,
    );
    fireEvent.click(screen.getByText("电池包"));
    expect(activate).toHaveBeenCalledExactlyOnceWith(id);
    fireEvent.doubleClick(screen.getByText("电池包"));
    expect(screen.getByRole("textbox", { name: "电池包关键词" })).toBeTruthy();
  });

  test("shows the reference-mark locator in text-book rails and exposes the active keyword", async () => {
    const onEnabledChange = vi.fn();
    const onCancel = vi.fn();
    render(
      <PatentBookTools
        session={session("abstract")}
        editorId="session-1:abstract"
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
        referenceMarkLocatorEnabled
        activeReferenceMarkKeyword="电池包"
        onReferenceMarkLocatorEnabledChange={onEnabledChange}
        onCancelReferenceMarkLocator={onCancel}
      />,
    );

    expect(screen.getByRole("switch", { name: "零部件定位" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("当前高亮")).not.toBeNull();
    expect(screen.getByText("电池包")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "取消高亮" }));
    expect(onCancel).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("switch", { name: "零部件定位" }));
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  test("opens AI correction from every text-book rail", async () => {
    const onAiCorrection = vi.fn();
    renderTools("description", 0, { onAiCorrection });

    await userEvent.click(screen.getByRole("button", { name: "AI 纠错" }));
    expect(onAiCorrection).toHaveBeenCalledOnce();
  });

  test("places text polish immediately below AI correction in text-book rails", async () => {
    const onTextPolish = vi.fn();
    renderTools("description", 0, { onTextPolish });

    const aiCorrection = screen.getByRole("button", { name: "AI 纠错" });
    const textPolish = screen.getByRole("button", { name: "小栈AI助手" });
    expect(aiCorrection.parentElement?.nextElementSibling).toBe(textPolish.parentElement);
    expect(aiCorrection.nextElementSibling?.getAttribute("aria-label")).toBe("AI 纠错实验功能说明");
    expect(aiCorrection.nextElementSibling?.textContent).toBe("");
    expect(textPolish.nextElementSibling?.textContent).toBe("");
    expect(aiCorrection.querySelector("svg.lucide-spell-check")).not.toBeNull();
    expect(textPolish.querySelector(".xiaozhan-ai-tool-icon")?.textContent).toBe("AI");
    expect(textPolish.querySelector("svg.lucide-sparkles")).toBeNull();
    await userEvent.click(textPolish);
    expect(onTextPolish).toHaveBeenCalledOnce();
  });

  test("runs configured book actions only in the matching book", () => {
    const onClearExtraFormatting = vi.fn();
    const onInsertDependentClaim = vi.fn();
    const onImportDrawingImages = vi.fn();
    const onCheckProblems = vi.fn();
    const shortcuts = {
      ...DEFAULT_SHORTCUT_SETTINGS,
      "clear-extra-formatting": "F6",
      "check-problems": "F7",
      "insert-dependent-claim": "F8",
      "import-drawing-images": "F10",
    };
    const { rerender } = render(
      <ShortcutProvider settings={shortcuts}>
        <PatentBookTools
          session={session("claims")}
          editorId="session-1:claims"
          abstractCharacterCount={0}
          onInsertDependentClaim={onInsertDependentClaim}
          onClearExtraFormatting={onClearExtraFormatting}
          onSelectAbstractDrawing={vi.fn()}
          onCheckProblems={onCheckProblems}
        />
      </ShortcutProvider>,
    );

    fireEvent.keyDown(window, { code: "F6", key: "F6" });
    fireEvent.keyDown(window, { code: "F7", key: "F7" });
    fireEvent.keyDown(window, { code: "F8", key: "F8" });
    expect(onClearExtraFormatting).toHaveBeenCalledOnce();
    expect(onInsertDependentClaim).toHaveBeenCalledOnce();
    expect(onCheckProblems).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "本地检查结果" })).toBeNull();
    expect(screen.getByRole("button", { name: "清除多余格式" }).getAttribute("title")).toBe("F6");
    expect(screen.getByRole("button", { name: "本地检查" }).getAttribute("aria-keyshortcuts")).toBe(
      "F7",
    );
    for (const name of ["本地检查", "AI 纠错", "小栈AI助手"]) {
      expect(screen.getByRole("button", { name }).hasAttribute("title")).toBe(false);
    }
    expect(screen.getByRole("button", { name: "插入从权" }).getAttribute("title")).toBe("F8");

    rerender(
      <ShortcutProvider settings={shortcuts}>
        <PatentBookTools
          session={session("description-drawings")}
          editorId={null}
          abstractCharacterCount={0}
          onInsertDependentClaim={vi.fn()}
          onSelectAbstractDrawing={vi.fn()}
          onImportDrawingImages={onImportDrawingImages}
          onCheckProblems={vi.fn()}
        />
      </ShortcutProvider>,
    );
    fireEvent.keyDown(window, { code: "F10", key: "F10" });
    expect(onImportDrawingImages).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "导入图片" }).getAttribute("title")).toBe("F10");
  });

  test("hides numbering and the shared reference-mark panel when drawing books are disabled", () => {
    const activeSession = session("claims");
    activeSession.patent.patentType = "invention";
    activeSession.patent.drawingBooksEnabled = false;
    render(
      <PatentBookTools
        session={activeSession}
        editorId="session-1:claims"
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
        onAssignReferenceNumber={vi.fn()}
      />,
    );

    expect(screen.queryByRole("region", { name: "附图标记" })).toBeNull();
    expect(screen.queryByRole("button", { name: "顺序编号" })).toBeNull();
  });

  test.each(["claims", "description", "description-drawings"] as const)(
    "renders the shared reference panel in %s",
    (kind) => {
      renderTools(kind);
      expect(screen.getByRole("region", { name: "附图标记" })).toBeDefined();
    },
  );

  test("passes the manual description fill state and action to the shared reference panel", () => {
    const activeSession = session("claims");
    activeSession.patent.referenceMarks = [
      {
        referenceMarkId: crypto.randomUUID(),
        number: 1,
        keyword: "箱体",
      },
    ];
    const onFillReferenceMarks = vi.fn(() => ({
      ok: true,
      message: "已填入说明书。",
    }));
    render(
      <PatentBookTools
        session={activeSession}
        editorId="session-1:claims"
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
        referenceMarkDescription={{
          status: "different",
          currentText: "",
          targetText: "其中：1、箱体。",
        }}
        onFillReferenceMarks={onFillReferenceMarks}
      />,
    );

    const fill = screen.getByRole("button", { name: "填入说明书" });
    expect(fill.hasAttribute("disabled")).toBe(false);
    fireEvent.click(fill);
    expect(onFillReferenceMarks).toHaveBeenCalledOnce();
  });
  test("keeps clear-extra-formatting first in compact text book actions", () => {
    const clearClaims = vi.fn();
    const { rerender } = render(
      <PatentBookTools
        session={session("claims")}
        editorId="session-1:claims"
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onClearExtraFormatting={clearClaims}
        onSelectAbstractDrawing={vi.fn()}
      />,
    );

    const claimsTools = screen.getByRole("group", { name: "权利要求书工具" });
    expect(
      screen.getByRole("button", { name: "填入说明书" }).closest(".reference-mark-panel__header"),
    ).not.toBeNull();
    expect(within(claimsTools).getAllByRole("button")[0]?.textContent).toBe("清除多余格式");
    expect(claimsTools.classList.contains("compact-tool-actions")).toBe(true);
    expect(
      within(claimsTools).getByRole("button", { name: "本地检查" }).querySelector("svg"),
    ).not.toBeNull();
    expect(within(claimsTools).getByRole("button", { name: "清除多余格式" }).className).toBe(
      "patent-book-tools__clear-extra-formatting",
    );

    rerender(
      <PatentBookTools
        session={session("description")}
        editorId="session-1:description"
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onClearExtraFormatting={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button")[0]?.textContent).toBe("清除多余格式");

    rerender(
      <PatentBookTools
        session={session("abstract")}
        editorId="session-1:abstract"
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onClearExtraFormatting={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button")[0]?.textContent).toBe("清除多余格式");
  });

  test("puts the unified problem check directly below clear formatting", async () => {
    const user = userEvent.setup();
    const onCheckProblems = vi.fn();
    render(
      <PatentBookTools
        session={session("claims")}
        editorId="session-1:claims"
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onClearExtraFormatting={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
        onCheckProblems={onCheckProblems}
      />,
    );

    const tools = screen.getByRole("group", { name: "权利要求书工具" });
    expect(within(tools).getAllByRole("button")[1]?.textContent).toBe("本地检查");
    expect(
      within(tools)
        .getAllByRole("button")
        .slice(2, 4)
        .map((button) => button.textContent),
    ).toEqual(["插入从权", "增补编号"]);
    expect(within(tools).queryByRole("region", { name: "本地检查结果" })).toBeNull();

    await user.click(within(tools).getByRole("button", { name: "本地检查" }));

    expect(onCheckProblems).toHaveBeenCalledOnce();
    expect(within(tools).queryByRole("region", { name: "本地检查结果" })).toBeNull();
  });

  test("routes the check button to the unified check entry", async () => {
    const user = userEvent.setup();
    const onCheckProblems = vi.fn();
    renderTools("abstract", 123, { onCheckProblems });

    await user.click(screen.getByRole("button", { name: "本地检查" }));

    expect(onCheckProblems).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "本地检查结果" })).toBeNull();
  });

  test("renders claim tools as a rail group outside the editor page", () => {
    renderTools("claims");

    expect(screen.getByRole("group", { name: "权利要求书工具" })).toBeDefined();
  });

  test("omits the retired missing-chapter action from description tools", () => {
    const { rerender } = renderTools("description");
    expect(screen.queryByRole("button", { name: "插入缺失章节" })).toBeNull();

    rerender(
      <PatentBookTools
        session={session("abstract")}
        editorId="session-1:abstract"
        abstractCharacterCount={123}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
      />,
    );
    expect(screen.getByText("摘要字数：123")).toBeDefined();
  });

  test("warns when the abstract exceeds 300 characters", () => {
    const { rerender } = renderTools("abstract", 300);

    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <PatentBookTools
        session={session("abstract")}
        editorId="session-1:abstract"
        abstractCharacterCount={301}
        onInsertDependentClaim={vi.fn()}
        onClearExtraFormatting={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "摘要超过 300 字，不符合《专利审查指南》第二部分第二章第 2.4 节第（4）项规定的摘要文字部分（包括标点符号）不得超过 300 个字的要求。",
    );
  });

  test("cites the invention abstract rule when warning about its character count", () => {
    const activeSession = session("abstract");
    activeSession.patent.patentType = "invention";
    render(
      <PatentBookTools
        session={activeSession}
        editorId="session-1:abstract"
        abstractCharacterCount={301}
        onInsertDependentClaim={vi.fn()}
        onClearExtraFormatting={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "摘要超过 300 字，不符合《专利审查指南》第一部分第一章第 4.5.1 节规定的摘要文字部分（包括标点符号）不得超过 300 个字的要求。",
    );
  });

  test("forwards abstract drawing selection outside the abstract text document", async () => {
    const user = userEvent.setup();
    const activeSession = session("abstract-drawing");
    const figure: PatentFigure = {
      figureId: "figure-1",
      assetId: "asset-1",
      widthMm: 80,
    };
    activeSession.patent.figures = [figure];
    const onSelectAbstractDrawing = vi.fn();
    render(
      <PatentBookTools
        session={activeSession}
        editorId={null}
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={onSelectAbstractDrawing}
      />,
    );

    await user.selectOptions(screen.getByLabelText("摘要附图"), figure.figureId);

    expect(onSelectAbstractDrawing).toHaveBeenCalledWith(figure.figureId);
  });

  test("shows a no-selection placeholder option for abstract drawing", () => {
    const activeSession = session("abstract-drawing");

    render(
      <PatentBookTools
        session={activeSession}
        editorId={null}
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "不选择" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "不选择摘要附图" })).toBeNull();
  });

  test("no longer shows the flowchart entry in description drawings", () => {
    render(
      <PatentBookTools
        session={session("description-drawings")}
        editorId={null}
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "流程图" })).toBeNull();
  });

  test("omits the copy-images hint from the drawings rail", () => {
    renderTools("description-drawings");
    expect(screen.queryByText(/复制多张图片/u)).toBeNull();
  });

  test("keeps formula and chemistry actions out of the drawings rail", () => {
    const onOpenFormulaDrawing = vi.fn();
    const onOpenChemistryDrawing = vi.fn();
    render(
      <PatentBookTools
        session={session("description-drawings")}
        editorId={null}
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
        onOpenFormulaDrawing={onOpenFormulaDrawing}
        onOpenChemistryDrawing={onOpenChemistryDrawing}
      />,
    );

    expect(screen.queryByRole("button", { name: "插入数学公式" })).toBeNull();
    expect(screen.queryByRole("button", { name: "插入物理公式" })).toBeNull();
    expect(screen.queryByRole("button", { name: "插入化学方程式" })).toBeNull();
    expect(screen.queryByRole("button", { name: "插入化学结构式" })).toBeNull();
    expect(screen.getByRole("button", { name: "导入图片" })).toBeDefined();
  });

  test("exposes the reference-mark collapse toggle only in the drawings rail", () => {
    const onToggleReferenceMarkCollapse = vi.fn();
    const { rerender } = renderTools("claims");
    expect(screen.queryByRole("button", { name: "附图标记" })).toBeNull();

    rerender(
      <PatentBookTools
        session={session("description-drawings")}
        editorId={null}
        abstractCharacterCount={0}
        onInsertDependentClaim={vi.fn()}
        onClearExtraFormatting={vi.fn()}
        onSelectAbstractDrawing={vi.fn()}
        referenceMarkCollapsed={false}
        onToggleReferenceMarkCollapse={onToggleReferenceMarkCollapse}
      />,
    );

    const toggle = screen.getByRole("button", { name: "折叠附图标记" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(onToggleReferenceMarkCollapse).toHaveBeenCalledOnce();
  });
});
