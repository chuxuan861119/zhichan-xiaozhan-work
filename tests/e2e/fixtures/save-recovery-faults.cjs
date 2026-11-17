const { readFile, writeFile } = require("node:fs/promises");
const { resolve, dirname } = require("node:path");

module.exports = async function prepareSaveRecoveryFaults() {
  const entry = resolve(process.env.PATENT_WORKBENCH_E2E_APP_ENTRY ?? "out/main/index.js");
  const source = await readFile(entry, "utf8");
  if (!source.includes("ipcMain.handle(")) throw Error("IPC registration not found");
  // Gate one real request before calling the unchanged production handler.
  const faults = `
const saveRecoveryFaults = { arm: false, blocked: false, release: null };
globalThis.__saveRecoveryFaults = saveRecoveryFaults;
dialog.showMessageBox = async (...args) => ({ response: args.at(-1)?.cancelId ?? 0, checkboxChecked: false });
const saveRecoveryOriginalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => saveRecoveryOriginalHandle(channel,
  channel !== "patents:apply-book-edit" ? handler : async (...args) => {
    if (saveRecoveryFaults.arm) {
      saveRecoveryFaults.arm = false;
      saveRecoveryFaults.blocked = true;
      await new Promise(resolve => { saveRecoveryFaults.release = resolve; });
      saveRecoveryFaults.blocked = false;
    }
    return handler(...args);
  });
`;
  const path = resolve(dirname(entry), `save-recovery-faults-${process.pid}.mjs`);
  await writeFile(path, faults + source, "utf8");
  return path;
};
