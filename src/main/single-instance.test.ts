import { findFirstPatdocArgument, sendPatdocOpenCommand } from "./single-instance.js";

test("selects only the first case-insensitive patdoc command-line argument", () => {
  expect(
    findFirstPatdocArgument([
      "C:\\Program Files\\知产小栈专利工作台\\知产小栈专利工作台.exe",
      "C:\\notes\\ignored.docx",
      "C:\\patents\\first.PATDOC",
      "C:\\patents\\second.patdoc",
    ]),
  ).toBe("C:\\patents\\first.PATDOC");
  expect(findFirstPatdocArgument(["app.exe", "C:\\patents\\fake.patdoc.exe"])).toBeNull();
});

test("restores and focuses the existing window before one fixed open-path command", () => {
  const send = vi.fn();
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: { send },
  };

  expect(sendPatdocOpenCommand(window, "C:\\patents\\draft.patdoc")).toBe(true);
  expect(window.restore).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith("open-path", "C:\\patents\\draft.patdoc");
});

test("rejects non-patdoc paths and destroyed windows", () => {
  const send = vi.fn();
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: { send },
  };

  expect(sendPatdocOpenCommand(window, "C:\\patents\\draft.docx")).toBe(false);
  window.isDestroyed.mockReturnValue(true);
  expect(sendPatdocOpenCommand(window, "C:\\patents\\draft.patdoc")).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
