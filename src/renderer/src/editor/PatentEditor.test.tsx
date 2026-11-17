import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { AssetDescriptor } from "../../../shared/document/model";
import { EditorCommandBus } from "../app/command-bus";
import { createDocumentSession } from "../documents/document-reducer";
import { onApplicationError } from "../shared/error-dialog";
import { createPatentExtensions } from "./extensions";
import { canonicalToTiptap } from "./model-adapter";
import { PatentEditor } from "./PatentEditor";

describe("patent editor", () => {
  test("reports updates only for its own document session", async () => {
    const session = createDocumentSession("文档 1", "session-1");
    const onModelChange = vi.fn();
    const commandBus = new EditorCommandBus();
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((sessionId, editor) => {
      registeredEditor.current = editor;
      return register(sessionId, editor);
    });

    render(
      <PatentEditor session={session} commandBus={commandBus} onModelChange={onModelChange} />,
    );

    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) return;
    editor.commands.insertContent("专利内容");

    await waitFor(() => expect(onModelChange).toHaveBeenCalled());
    expect(onModelChange.mock.calls.every(([sessionId]) => sessionId === "session-1")).toBe(true);
  });

  test("keeps undo history independent for every open document", () => {
    const firstSession = createDocumentSession("文档 1", "session-1");
    const secondSession = createDocumentSession("文档 2", "session-2");
    const extensions = createPatentExtensions();
    const firstEditor = new Editor({
      extensions,
      content: canonicalToTiptap(firstSession.model),
    });
    const secondEditor = new Editor({
      extensions: createPatentExtensions(),
      content: canonicalToTiptap(secondSession.model),
    });
    const commandBus = new EditorCommandBus();
    commandBus.register("session-1", firstEditor);
    commandBus.register("session-2", secondEditor);

    firstEditor.commands.insertContent("第一份内容");
    secondEditor.commands.insertContent("第二份内容");
    expect(commandBus.execute("session-1", "undo")).toBe(true);

    expect(firstEditor.getText()).toBe("");
    expect(secondEditor.getText()).toBe("第二份内容");
    firstEditor.destroy();
    secondEditor.destroy();
  });

  test("adds an imported descriptor before inserting its figure reference", () => {
    const session = createDocumentSession("文档 1", "session-1");
    const editor = new Editor({
      extensions: createPatentExtensions("session-1"),
      content: canonicalToTiptap(session.model),
    });
    const descriptor: AssetDescriptor = {
      assetId: "00000000-0000-4000-8000-000000000021",
      kind: "image",
      originalName: "drawing.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 3,
      sha256: "A".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 3,
      previewSha256: "B".repeat(64),
    };
    const addAsset = vi.fn();
    const commandBus = new EditorCommandBus();
    commandBus.register("session-1", editor, addAsset);

    expect(commandBus.insertFigure("session-1", descriptor)).toBe(true);
    expect(addAsset).toHaveBeenCalledWith(descriptor);
    expect(editor.getJSON().content?.find((node) => node.type === "figure")).toMatchObject({
      type: "figure",
      attrs: {
        assetId: descriptor.assetId,
        widthMm: 80,
        alignment: "center",
        rotationDeg: 0,
      },
    });
    editor.destroy();
  });

  test("inserts a selected image batch without deleting selected text and undoes it once", () => {
    const session = createDocumentSession("文档 1", "session-image-batch");
    const editor = new Editor({
      extensions: createPatentExtensions("session-image-batch"),
      content: canonicalToTiptap(session.model),
    });
    editor.commands.insertContent("不得删除的专利文字");
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    const descriptors: AssetDescriptor[] = [
      {
        assetId: "00000000-0000-4000-8000-000000000022",
        kind: "image",
        originalName: "first.png",
        mediaType: "image/png",
        extension: "png",
        byteLength: 3,
        sha256: "A".repeat(64),
        widthPx: 120,
        heightPx: 80,
        previewByteLength: 3,
        previewSha256: "B".repeat(64),
      },
      {
        assetId: "00000000-0000-4000-8000-000000000023",
        kind: "image",
        originalName: "second.jpg",
        mediaType: "image/jpeg",
        extension: "jpg",
        byteLength: 4,
        sha256: "C".repeat(64),
        widthPx: 160,
        heightPx: 90,
        previewByteLength: 4,
        previewSha256: "D".repeat(64),
      },
    ];
    const addAsset = vi.fn();
    const commandBus = new EditorCommandBus();
    commandBus.register("session-image-batch", editor, addAsset);
    const insertFigures = (
      commandBus as EditorCommandBus & {
        insertFigures?(sessionId: string, assets: AssetDescriptor[]): boolean;
      }
    ).insertFigures?.bind(commandBus);

    expect(insertFigures).toBeTypeOf("function");
    if (!insertFigures) {
      editor.destroy();
      return;
    }
    expect(insertFigures("session-image-batch", descriptors)).toBe(true);
    expect(editor.getText()).toContain("不得删除的专利文字");
    expect(
      editor
        .getJSON()
        .content?.filter((node) => node.type === "figure")
        .map((node) => node.attrs?.assetId),
    ).toEqual(descriptors.map((descriptor) => descriptor.assetId));
    expect(addAsset.mock.calls.map(([descriptor]) => descriptor.assetId)).toEqual(
      descriptors.map((descriptor) => descriptor.assetId),
    );

    expect(commandBus.execute("session-image-batch", "undo")).toBe(true);
    expect(editor.getText()).toContain("不得删除的专利文字");
    expect(editor.getJSON().content?.some((node) => node.type === "figure")).toBe(false);
    editor.destroy();
  });

  test("imports dropped file bytes through the preload boundary", async () => {
    const session = createDocumentSession("文档 1", "session-drop");
    const descriptor: AssetDescriptor = {
      assetId: "00000000-0000-4000-8000-000000000031",
      kind: "image",
      originalName: "drop.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 3,
      sha256: "A".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 3,
      previewSha256: "B".repeat(64),
    };
    const importMany = vi.fn().mockResolvedValue({
      ok: true,
      value: [{ descriptor, preview: Uint8Array.from([1, 2, 3]) }],
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          importMany,
          getPreview: vi.fn().mockResolvedValue({
            ok: false,
            error: { code: "NOT_FOUND", message: "测试中不加载预览" },
          }),
        },
      },
    });
    const onModelChange = vi.fn();
    render(
      <PatentEditor
        session={session}
        commandBus={new EditorCommandBus()}
        onModelChange={onModelChange}
      />,
    );
    const file = new File([Uint8Array.from([1, 2, 3])], "drop.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
    });

    fireEvent.drop(screen.getByRole("textbox", { name: "编辑 文档 1" }), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(importMany).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        onModelChange.mock.calls.some(([, model]) =>
          model.content.some((node: { type: string }) => node.type === "figure"),
        ),
      ).toBe(true),
    );
    expect(importMany.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-drop",
      operationId: expect.any(String),
      images: [
        {
          originalName: "drop.png",
          declaredMediaType: "image/png",
          bytes: Uint8Array.from([1, 2, 3]),
        },
      ],
    });
  });

  test.each(["drop", "paste"] as const)(
    "reports a safe application error when a %s image import rejects",
    async (eventType) => {
      const session = createDocumentSession("文档 1", `session-${eventType}-failure`);
      const importMany = vi.fn().mockRejectedValue(new Error("C:\\Users\\secret\\raw stack"));
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: {
          assets: {
            importMany,
            getPreview: vi.fn(),
          },
        },
      });
      const errors: string[] = [];
      const unsubscribe = onApplicationError((error) =>
        errors.push(`${error.code}:${error.message}:${error.nextAction}`),
      );
      render(
        <PatentEditor
          session={session}
          commandBus={new EditorCommandBus()}
          onModelChange={vi.fn()}
        />,
      );
      const file = new File([Uint8Array.from([1, 2, 3])], "failure.png", {
        type: "image/png",
      });
      Object.defineProperty(file, "arrayBuffer", {
        value: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
      });
      const textbox = screen.getByRole("textbox", { name: "编辑 文档 1" });

      if (eventType === "drop") {
        fireEvent.drop(textbox, { dataTransfer: { files: [file] } });
      } else {
        fireEvent.paste(textbox, {
          clipboardData: { files: [file], getData: vi.fn().mockReturnValue("") },
        });
      }

      await waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toContain("INTERNAL:本地操作失败。:请重试");
      expect(errors[0]).not.toContain("secret");
      unsubscribe();
    },
  );

  test("shows a safe inline error when loading a figure preview rejects", async () => {
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          getPreview: vi.fn().mockRejectedValue(new Error("C:\\Users\\secret\\preview stack")),
        },
      },
    });
    const errors: string[] = [];
    const unsubscribe = onApplicationError((error) =>
      errors.push(`${error.code}:${error.message}:${error.nextAction}`),
    );
    const session = createDocumentSession("文档 1", "session-preview-failure");
    const commandBus = new EditorCommandBus();
    const descriptor: AssetDescriptor = {
      assetId: "00000000-0000-4000-8000-000000000051",
      kind: "image",
      originalName: "preview.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 3,
      sha256: "A".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 3,
      previewSha256: "B".repeat(64),
    };
    render(<PatentEditor session={session} commandBus={commandBus} onModelChange={vi.fn()} />);

    await waitFor(() => expect(commandBus.insertFigure(session.sessionId, descriptor)).toBe(true));
    expect(await screen.findByText("图片预览加载失败。")).toBeDefined();
    expect(screen.getByRole("button", { name: "重试加载图片预览" })).toBeDefined();
    expect(errors).toEqual([]);
    expect(document.body.textContent).not.toContain("secret");
    unsubscribe();
  });

  test("shows drawing-style controls when an inserted figure is clicked", async () => {
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          getPreview: vi.fn().mockResolvedValue({
            ok: false,
            error: { code: "NOT_FOUND", message: "测试中不加载预览" },
          }),
        },
      },
    });
    const session = createDocumentSession("文档 1", "session-select");
    const commandBus = new EditorCommandBus();
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((sessionId, editor, addAsset) => {
      registeredEditor.current = editor;
      return register(sessionId, editor, addAsset);
    });
    const descriptor: AssetDescriptor = {
      assetId: "00000000-0000-4000-8000-000000000041",
      kind: "image",
      originalName: "drawing.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 3,
      sha256: "A".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 3,
      previewSha256: "B".repeat(64),
    };
    const { container } = render(
      <PatentEditor session={session} commandBus={commandBus} onModelChange={vi.fn()} />,
    );
    await waitFor(() => expect(commandBus.insertFigure("session-select", descriptor)).toBe(true));
    const editor = registeredEditor.current;
    expect(editor).toBeDefined();
    if (!editor) return;
    await act(async () => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    expect(screen.queryByRole("button", { name: "从右下角缩放图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除图片" })).toBeNull();
    const figure = await waitFor(() => container.querySelector<HTMLElement>(".patent-figure"));
    expect(figure).not.toBeNull();
    if (!figure) return;

    fireEvent.click(figure);
    await waitFor(() =>
      expect(figure.parentElement?.classList.contains("ProseMirror-selectednode")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "删除图片" })).toBeDefined();
    expect(screen.getByRole("button", { name: "从右下角缩放图片" })).toBeDefined();

    await act(async () => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    expect(screen.queryByRole("button", { name: "删除图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "从右下角缩放图片" })).toBeNull();
  });

  test("inserts a table without rendering page-overlay table tools", async () => {
    const user = userEvent.setup();
    const session = createDocumentSession("文档 1", "session-structure");
    const commandBus = new EditorCommandBus();
    const onModelChange = vi.fn();
    const { container } = render(
      <PatentEditor session={session} commandBus={commandBus} onModelChange={onModelChange} />,
    );

    await waitFor(() =>
      expect(
        commandBus.insertTable("session-structure", {
          rows: 2,
          columns: 2,
          headerRowCount: 0,
          layoutMode: "fit-page",
        }),
      ).toBe(true),
    );
    expect(container.querySelectorAll("table tr")).toHaveLength(2);
    expect(container.querySelector(".table-tools")).toBeNull();

    await act(async () => {
      expect(commandBus.openFormulaEditor("session-structure")).toBe(true);
    });
    const formulaDialog = await screen.findByRole("dialog", { name: "插入数学公式" });
    const mathField = formulaDialog.querySelector<HTMLElement>("math-field") as HTMLElement & {
      value: string;
    };
    expect(mathField).not.toBeNull();
    if (!mathField) return;
    mathField.value = "x^2+y^2";
    fireEvent.input(mathField);
    const confirm = formulaDialog.querySelector<HTMLButtonElement>("button.primary-button");
    expect(confirm).not.toBeNull();
    if (!confirm) return;
    await user.click(confirm);

    await waitFor(() =>
      expect(container.querySelector("[data-type='inline-math']")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        onModelChange.mock.calls.some(([, model]) =>
          model.content.some((node: { type: string }) => node.type === "table"),
        ),
      ).toBe(true),
    );
  });

  test("opens find and replace controls with the standard shortcuts", async () => {
    const session = createDocumentSession("文档 1", "session-find");
    render(
      <PatentEditor
        session={session}
        commandBus={new EditorCommandBus()}
        onModelChange={vi.fn()}
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "编辑 文档 1" });

    fireEvent.keyDown(textbox, { key: "f", ctrlKey: true });
    expect(screen.getByRole("search", { name: "查找和替换" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "查找内容" })).toBeDefined();

    fireEvent.keyDown(textbox, { key: "h", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "替换为" })).toBeDefined();
  });
});
