import { protocol } from "electron";
import { PRINT_DOCUMENT_SCHEME, PrintDocumentStore } from "./print-document-store.js";

const PRINT_CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

export const printDocumentStore = new PrintDocumentStore();

export function registerPrintProtocolScheme(
  register = (schemes: Electron.CustomScheme[]) => protocol.registerSchemesAsPrivileged(schemes),
): void {
  register([
    {
      scheme: PRINT_DOCUMENT_SCHEME,
      privileges: { standard: true, secure: true },
    },
  ]);
}

export function installPrintProtocol(): void {
  protocol.handle(PRINT_DOCUMENT_SCHEME, (request) => {
    const html = printDocumentStore.consume(request.url);
    if (html === null) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": PRINT_CSP,
      },
    });
  });
}
