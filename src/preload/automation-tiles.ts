import { contextBridge, ipcRenderer } from "electron";
import { AUTOMATION_DRAWING_TILE_CHANNEL } from "../shared/automation/graphics.js";

// This preload has no document, filesystem, settings, or general IPC bridge.
contextBridge.exposeInMainWorld("automationTiles", {
  readTile: (id: string): Promise<Uint8Array> => {
    if (!/^tile-[0-9]{1,4}$/u.test(id)) return Promise.reject(new Error("Invalid drawing tile"));
    return ipcRenderer.invoke(AUTOMATION_DRAWING_TILE_CHANNEL, id);
  },
});
