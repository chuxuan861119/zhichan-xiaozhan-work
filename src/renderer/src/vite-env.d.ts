import type { PatentApi } from "../../shared/ipc/contract";

declare global {
  interface Window {
    patentApi: PatentApi;
  }
}
