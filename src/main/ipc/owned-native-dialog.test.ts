import { BrowserWindow } from "electron";
import { showOwnedOpenDialog, showOwnedSaveDialog } from "./owned-native-dialog.js";

const electron = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
}));

describe("owned native dialogs", () => {
  const sender = {};
  const ownerWindow = {} as BrowserWindow;

  beforeEach(() => {
    electron.fromWebContents.mockReset();
    electron.fromWebContents.mockReturnValue(ownerWindow);
  });

  it("opens a file chooser as a modal child of the invoking window", async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    const options: Electron.OpenDialogOptions = { properties: ["openFile"] };

    await showOwnedOpenDialog({ sender } as never, options, {
      showOpenDialog,
      showSaveDialog: vi.fn(),
    });

    expect(BrowserWindow.fromWebContents).toHaveBeenCalledWith(sender);
    expect(showOpenDialog).toHaveBeenCalledWith(ownerWindow, options);
  });

  it("opens a save chooser as a modal child of the invoking window", async () => {
    const showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: "" }));
    const options = { defaultPath: "draft.patdoc" };

    await showOwnedSaveDialog({ sender } as never, options, {
      showOpenDialog: vi.fn(),
      showSaveDialog,
    });

    expect(showSaveDialog).toHaveBeenCalledWith(ownerWindow, options);
  });

  it("fails before opening when the invoking window cannot be resolved", async () => {
    electron.fromWebContents.mockReturnValue(null);
    const showOpenDialog = vi.fn();

    await expect(
      showOwnedOpenDialog(
        { sender } as never,
        {},
        {
          showOpenDialog,
          showSaveDialog: vi.fn(),
        },
      ),
    ).rejects.toThrow("Native dialog owner window is unavailable");
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});
