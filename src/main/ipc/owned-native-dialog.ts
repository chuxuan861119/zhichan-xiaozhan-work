import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";

export type OwnedDialogEvent = Pick<IpcMainInvokeEvent, "sender">;

export type OwnedDialogApi = {
  showOpenDialog(
    browserWindow: BrowserWindow,
    options: Electron.OpenDialogOptions,
  ): Promise<Electron.OpenDialogReturnValue>;
  showSaveDialog(
    browserWindow: BrowserWindow,
    options: Electron.SaveDialogOptions,
  ): Promise<Electron.SaveDialogReturnValue>;
};

function resolveOwnerWindow(event: OwnedDialogEvent): BrowserWindow {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) {
    throw new Error("Native dialog owner window is unavailable");
  }
  return ownerWindow;
}

export async function showOwnedOpenDialog(
  event: OwnedDialogEvent,
  options: Electron.OpenDialogOptions,
  selectedDialog: OwnedDialogApi = dialog,
): Promise<Electron.OpenDialogReturnValue> {
  return selectedDialog.showOpenDialog(resolveOwnerWindow(event), options);
}

export async function showOwnedSaveDialog(
  event: OwnedDialogEvent,
  options: Electron.SaveDialogOptions,
  selectedDialog: OwnedDialogApi = dialog,
): Promise<Electron.SaveDialogReturnValue> {
  return selectedDialog.showSaveDialog(resolveOwnerWindow(event), options);
}
