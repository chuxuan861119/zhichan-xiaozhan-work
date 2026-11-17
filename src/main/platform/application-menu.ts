import { BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { APPLICATION_NAME } from "../../shared/branding.js";
import type { MenuCommand } from "../../shared/ipc/contract.js";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";

export function macApplicationMenu(): MenuItemConstructorOptions[] {
  const command = (
    label: string,
    value: MenuCommand,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: (_item, window) => {
      if (!(window instanceof BrowserWindow)) return;
      const contents = window.webContents;
      // Embedded editors own their frame's selection and clipboard commands.
      if (contents.focusedFrame && contents.focusedFrame !== contents.mainFrame) {
        if (value === "cut" || value === "copy" || value === "paste") {
          contents[value]();
          return;
        }
        if (value === "select-all") {
          contents.selectAll();
          return;
        }
      }
      contents.send(IPC_CHANNELS.menuCommand, value);
    },
  });
  return [
    {
      label: APPLICATION_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        command("设置…", "open-settings", "Command+,"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "文件",
      submenu: [
        command("新建专利", "new-document", "Command+N"),
        command("导入 PATDOC…", "open-document", "Command+O"),
        { type: "separator" },
        command("保存", "save-document", "Command+S"),
        command("导出 PATDOC…", "save-document-as"),
        command("导出 DOCX…", "export-docx"),
        command("导出 PDF…", "export-pdf"),
        { type: "separator" },
        command("打印…", "print", "Command+P"),
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        {
          label: "撤销",
          accelerator: "Command+Z",
          click: (_item, window) => {
            if (window instanceof BrowserWindow)
              window.webContents.send(IPC_CHANNELS.menuCommand, "undo");
          },
        },
        {
          label: "重做",
          accelerator: "Command+Shift+Z",
          click: (_item, window) => {
            if (window instanceof BrowserWindow)
              window.webContents.send(IPC_CHANNELS.menuCommand, "redo");
          },
        },
        { type: "separator" },
        command("剪切", "cut", "Command+X"),
        command("复制", "copy", "Command+C"),
        command("粘贴", "paste", "Command+V"),
        command("全选", "select-all", "Command+A"),
      ],
    },
    {
      label: "查看",
      submenu: [{ role: "togglefullscreen", label: "切换全屏", accelerator: "Control+Command+F" }],
    },
    { role: "windowMenu", label: "窗口" },
  ];
}
