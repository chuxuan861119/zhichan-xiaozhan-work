import {
  DrawioFrameMessageSchema,
  DrawioHostMessageSchema,
  isDrawioFrameMessage,
  isDrawioHostMessage,
} from "./bridge.js";
import { FLOWCHART_MAX_SOURCE_XML_BYTES } from "./limits.js";

const envelope = {
  sessionId: "session-1",
  projectId: "project-1",
  projectRevision: 2,
  requestId: "request-1",
};

describe("draw.io frame protocol schemas", () => {
  test("accepts the allowed host commands and rejects unknown fields", () => {
    expect(
      DrawioHostMessageSchema.safeParse({ ...envelope, type: "load", source: "<mxfile />" })
        .success,
    ).toBe(true);
    expect(
      DrawioHostMessageSchema.safeParse({ ...envelope, type: "dispose", unexpected: true }).success,
    ).toBe(false);
    for (const format of ["xml", "webp"]) {
      expect(
        DrawioHostMessageSchema.safeParse({
          ...envelope,
          type: "request-export",
          format,
          selectionOnly: false,
        }).success,
      ).toBe(false);
    }
  });

  test("accepts frame save and export responses only with the matching envelope", () => {
    expect(
      DrawioFrameMessageSchema.safeParse({ ...envelope, type: "autosave", source: "<mxfile />" })
        .success,
    ).toBe(true);
    expect(
      DrawioFrameMessageSchema.safeParse({
        ...envelope,
        type: "export-result",
        format: "svg",
        data: "<svg />",
      }).success,
    ).toBe(true);
    for (const action of [
      "project-create",
      "project-import",
      "project-rename",
      "project-duplicate",
      "project-delete",
    ]) {
      expect(
        DrawioFrameMessageSchema.safeParse({
          ...envelope,
          type: "toolbar-action",
          action,
          actionId: "toolbar-action-1",
        }).success,
      ).toBe(true);
    }
    expect(
      DrawioFrameMessageSchema.safeParse({ ...envelope, type: "changed", projectRevision: -1 })
        .success,
    ).toBe(false);
  });

  test("accepts bounded selected cell identifiers", () => {
    expect(
      DrawioFrameMessageSchema.parse({
        ...envelope,
        type: "selection-changed",
        selectionCount: 2,
        selectedCellIds: ["cell-1", "cell-2"],
      }),
    ).toMatchObject({ selectedCellIds: ["cell-1", "cell-2"] });
  });

  test("accepts exact toolbar state and fixed toolbar actions", () => {
    const toolbarState = {
      ...envelope,
      type: "toolbar-state",
      projectName: "新建流程图",
      activePageName: "第1页",
      saveStatus: "saved",
      dirty: false,
      saveBusy: false,
      exportBusy: false,
      canUndo: true,
      canRedo: false,
    };

    expect(DrawioHostMessageSchema.safeParse(toolbarState).success).toBe(true);
    expect(DrawioHostMessageSchema.safeParse({ ...toolbarState, extra: true }).success).toBe(false);
    expect(
      DrawioHostMessageSchema.safeParse({ ...toolbarState, projectName: "项目".repeat(257) })
        .success,
    ).toBe(false);
    expect(
      DrawioFrameMessageSchema.safeParse({
        ...envelope,
        type: "toolbar-action",
        action: "toggle-project-menu",
        actionId: "toolbar-action-2",
      }).success,
    ).toBe(true);
    expect(
      DrawioFrameMessageSchema.safeParse({
        ...envelope,
        type: "toolbar-action",
        action: "save",
      }).success,
    ).toBe(false);
    expect(
      DrawioHostMessageSchema.safeParse({
        ...envelope,
        type: "toolbar-action-ack",
        actionId: "toolbar-action-2",
      }).success,
    ).toBe(true);
    expect(
      DrawioFrameMessageSchema.safeParse({
        ...envelope,
        type: "toolbar-action",
        action: "return-to-list",
        actionId: "toolbar-action-3",
      }).success,
    ).toBe(false);
    expect(
      DrawioFrameMessageSchema.safeParse({
        ...envelope,
        type: "toolbar-action",
        action: "project-create",
        actionId: "toolbar-action-4",
        script: "alert(1)",
      }).success,
    ).toBe(false);
    expect(
      DrawioFrameMessageSchema.safeParse({
        ...envelope,
        type: "history-state",
        canUndo: true,
        canRedo: false,
      }).success,
    ).toBe(true);
    expect(
      DrawioFrameMessageSchema.safeParse({
        ...envelope,
        type: "toolbar-action",
        action: "help",
        actionId: "toolbar-action-5",
      }).success,
    ).toBe(false);
  });

  test("accepts only fixed editor modes", () => {
    for (const mode of ["flowchart", "circuit"] as const) {
      expect(
        DrawioHostMessageSchema.safeParse({
          ...envelope,
          type: "set-editor-mode",
          mode,
        }).success,
      ).toBe(true);
      expect(
        DrawioFrameMessageSchema.safeParse({
          ...envelope,
          type: "editor-mode-changed",
          mode,
        }).success,
      ).toBe(true);
    }
    expect(
      DrawioHostMessageSchema.safeParse({
        ...envelope,
        type: "set-editor-mode",
        mode: "electrical-url",
      }).success,
    ).toBe(false);
    expect(
      DrawioFrameMessageSchema.safeParse({
        ...envelope,
        type: "editor-mode-changed",
        mode: "circuit",
        url: "https://example.test/library",
      }).success,
    ).toBe(false);
  });

  test("type guards never trust malformed unknown values", () => {
    expect(isDrawioHostMessage({ ...envelope, type: "request-save" })).toBe(true);
    expect(isDrawioHostMessage({ ...envelope, type: "request-save", finishEditing: false })).toBe(
      true,
    );
    expect(isDrawioHostMessage({ ...envelope, type: "request-save", finishEditing: "false" })).toBe(
      false,
    );
    expect(isDrawioHostMessage({ ...envelope, type: "undo" })).toBe(true);
    expect(isDrawioHostMessage({ ...envelope, type: "redo" })).toBe(true);
    expect(isDrawioFrameMessage({ ...envelope, type: "ready" })).toBe(true);
    expect(isDrawioFrameMessage({ type: "ready" })).toBe(false);
  });

  test("measures source text in UTF-8 bytes instead of JavaScript code units", () => {
    const tooLargeChineseSource = "汉".repeat(Math.floor(FLOWCHART_MAX_SOURCE_XML_BYTES / 3) + 1);
    expect(
      DrawioHostMessageSchema.safeParse({
        ...envelope,
        type: "load",
        source: tooLargeChineseSource,
      }).success,
    ).toBe(false);
  });
});
