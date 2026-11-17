import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorCommandBus } from "../../app/command-bus";
import { FigureRailPanel } from "./figure-rail-panel";

test("rotates a rectangular image without changing its physical size", () => {
  const updateAttributes = vi.fn();
  const commandBus = {
    getFigureSelection: () => ({
      kind: "figure",
      nodeType: "figure",
      position: 4,
      assetId: "00000000-0000-4000-8000-000000000101",
      widthMm: 80,
      alignment: "center",
      rotationDeg: 0,
    }),
    subscribeFigureSelection: () => () => undefined,
    getEditor: () => ({
      state: { doc: { nodeAt: () => ({ attrs: { sourceAspectRatio: 1.6 } }) } },
      commands: { updateAttributes, setNodeSelection: vi.fn() },
    }),
  } as unknown as EditorCommandBus;
  render(
    <FigureRailPanel
      editorId="test"
      sessionId="test"
      commandBus={commandBus}
      onOperationFeedback={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "向右旋转90°" }));
  expect(updateAttributes).toHaveBeenCalledWith("figure", { rotationDeg: 90, widthMm: 50 });
});

test("uses the patent session rather than the editor id for image file operations", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000099";
  const assetId = "00000000-0000-4000-8000-000000000101";
  const copyImages = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const saveImage = vi.fn().mockResolvedValue({ ok: true, value: null });
  const onOperationFeedback = vi.fn();
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { assets: { copyImages, saveImage } },
  });
  const commandBus = {
    getFigureSelection: () => ({
      kind: "figure" as const,
      nodeType: "figure" as const,
      position: 4,
      assetId,
      widthMm: 80,
      alignment: "center" as const,
      rotationDeg: 90 as const,
    }),
    subscribeFigureSelection: () => () => undefined,
    getEditor: () => undefined,
  } as unknown as EditorCommandBus;

  render(
    <FigureRailPanel
      editorId="patent-editor:claims"
      sessionId={sessionId}
      commandBus={commandBus}
      onOperationFeedback={onOperationFeedback}
    />,
  );

  expect(screen.getByRole("region", { name: "图片设置" }).className).toContain(
    "function-rail-transient-panel",
  );

  fireEvent.click(screen.getByRole("button", { name: "复制图片" }));
  await waitFor(() => expect(copyImages).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "另存为图片" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "另存为图片" }));
  await waitFor(() => expect(saveImage).toHaveBeenCalledOnce());
  expect(copyImages).toHaveBeenCalledWith({
    sessionId,
    images: [
      {
        assetId,
        rotationDeg: 90,
        layout: "block",
        widthMm: 80,
        alignment: "center",
        label: "专利图片",
      },
    ],
  });
  expect(saveImage).toHaveBeenCalledWith({
    sessionId,
    image: { assetId, rotationDeg: 90, label: "专利图片" },
  });
  expect(onOperationFeedback).toHaveBeenCalledWith({
    tone: "success",
    title: "复制成功",
    message: "图片已复制到剪贴板。",
  });
});

test("reports a rejected image copy instead of leaving the button unresponsive", async () => {
  const onOperationFeedback = vi.fn();
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        copyImages: vi.fn().mockRejectedValue(new Error("clipboard unavailable")),
        saveImage: vi.fn(),
      },
    },
  });
  const commandBus = {
    getFigureSelection: () => ({
      kind: "figure" as const,
      nodeType: "figure" as const,
      position: 4,
      assetId: "00000000-0000-4000-8000-000000000101",
      widthMm: 80,
      alignment: "center" as const,
      rotationDeg: 0 as const,
    }),
    subscribeFigureSelection: () => () => undefined,
    getEditor: () => undefined,
  } as unknown as EditorCommandBus;

  render(
    <FigureRailPanel
      editorId="patent-editor:claims"
      sessionId="00000000-0000-4000-8000-000000000099"
      commandBus={commandBus}
      onOperationFeedback={onOperationFeedback}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "复制图片" }));

  await waitFor(() =>
    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "error",
      title: "复制失败",
      message: "无法写入剪贴板，请重试。",
    }),
  );
});

test("reports a rejected image save and prevents duplicate file operations while pending", async () => {
  let rejectSave: ((reason: Error) => void) | undefined;
  const saveImage = vi.fn(
    () =>
      new Promise((_, reject) => {
        rejectSave = reject;
      }),
  );
  const onOperationFeedback = vi.fn();
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        copyImages: vi.fn(),
        saveImage,
      },
    },
  });
  const commandBus = {
    getFigureSelection: () => ({
      kind: "figure" as const,
      nodeType: "figure" as const,
      position: 4,
      assetId: "00000000-0000-4000-8000-000000000101",
      widthMm: 80,
      alignment: "center" as const,
      rotationDeg: 0 as const,
    }),
    subscribeFigureSelection: () => () => undefined,
    getEditor: () => undefined,
  } as unknown as EditorCommandBus;

  render(
    <FigureRailPanel
      editorId="patent-editor:claims"
      sessionId="00000000-0000-4000-8000-000000000099"
      commandBus={commandBus}
      onOperationFeedback={onOperationFeedback}
    />,
  );
  const saveButton = screen.getByRole("button", { name: "另存为图片" });
  const copyButton = screen.getByRole("button", { name: "复制图片" });
  fireEvent.click(saveButton);

  expect(saveButton.hasAttribute("disabled")).toBe(true);
  expect(copyButton.hasAttribute("disabled")).toBe(true);
  fireEvent.click(saveButton);
  expect(saveImage).toHaveBeenCalledOnce();
  rejectSave?.(new Error("dialog unavailable"));

  await waitFor(() =>
    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "error",
      title: "另存失败",
      message: "无法保存图片，请重试。",
    }),
  );
  expect(saveButton.hasAttribute("disabled")).toBe(false);
});

test("reselects the image after rotating it", () => {
  const updateAttributes = vi.fn();
  const setNodeSelection = vi.fn();
  const commandBus = {
    getFigureSelection: () => ({
      kind: "figure" as const,
      nodeType: "figure" as const,
      position: 4,
      assetId: "00000000-0000-4000-8000-000000000101",
      widthMm: 80,
      alignment: "center" as const,
      rotationDeg: 0 as const,
    }),
    subscribeFigureSelection: () => () => undefined,
    getEditor: () => ({ commands: { updateAttributes, setNodeSelection } }),
  } as unknown as EditorCommandBus;

  render(
    <FigureRailPanel
      editorId="patent-editor:claims"
      sessionId="00000000-0000-4000-8000-000000000099"
      commandBus={commandBus}
      onOperationFeedback={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "向右旋转90°" }));

  expect(updateAttributes).toHaveBeenCalledWith("figure", { rotationDeg: 90, widthMm: 80 });
  expect(setNodeSelection).toHaveBeenCalledWith(4);
});
