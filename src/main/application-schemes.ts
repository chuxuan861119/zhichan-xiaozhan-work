import { protocol } from "electron";
import { registerAppProtocolScheme } from "./app-protocol.js";
import { registerPrintProtocolScheme } from "./exports/print-protocol.js";
import { registerDrawioProtocolScheme } from "./flowcharts/drawio-protocol.js";
import { registerIpcDataScheme } from "./ipc-data-center/ipc-data-protocol.js";

export function registerApplicationSchemes(): void {
  const schemes: Electron.CustomScheme[] = [];
  const collect = (items: Electron.CustomScheme[]) => {
    schemes.push(...items);
  };
  registerPrintProtocolScheme(collect);
  registerAppProtocolScheme(collect);
  registerDrawioProtocolScheme(collect);
  registerIpcDataScheme(collect);
  protocol.registerSchemesAsPrivileged(schemes);
}
