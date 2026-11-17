import { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import { macApplicationMenu } from "./application-menu.js";

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = {
      mainFrame: {},
      focusedFrame: null as object | null,
      send: vi.fn(),
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
    };
  },
}));

function invoke(label: string, window: BrowserWindow) {
  const submenu = macApplicationMenu().find((menu) => menu.label === "编辑")?.submenu;
  if (!Array.isArray(submenu)) throw new Error("Missing edit submenu");
  const item = submenu.find((candidate) => candidate.label === label);
  item?.click?.({} as Electron.MenuItem, window, {} as Electron.KeyboardEvent);
}

test("top-level custom editors receive native menu commands", () => {
  const window = new BrowserWindow();
  invoke("全选", window);
  expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.menuCommand, "select-all");
});

test("Mac Settings uses the standard accelerator and application command", () => {
  const submenu = macApplicationMenu()[0]?.submenu;
  if (!Array.isArray(submenu)) throw new Error("Missing app submenu");
  const item = submenu.find((candidate) => candidate.label === "设置…");
  expect(item?.accelerator).toBe("Command+,");
  const window = new BrowserWindow();
  item?.click?.({} as Electron.MenuItem, window, {} as Electron.KeyboardEvent);
  expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.menuCommand, "open-settings");
});

test.each([
  ["剪切", "cut"],
  ["复制", "copy"],
  ["粘贴", "paste"],
  ["全选", "selectAll"],
] as const)("focused embedded editors retain native %s routing", (label, action) => {
  const window = new BrowserWindow();
  Object.defineProperty(window.webContents, "focusedFrame", { value: {} });
  invoke(label, window);
  expect(window.webContents[action]).toHaveBeenCalledTimes(1);
  expect(window.webContents.send).not.toHaveBeenCalled();
});
