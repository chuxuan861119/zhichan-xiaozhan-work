import { randomUUID } from "node:crypto";

export const PRINT_DOCUMENT_SCHEME = "patent-print";
export const MAX_PRINT_HTML_BYTES = 256 * 1024 * 1024;

export type PrintDocumentLease = {
  url: string;
  dispose(): void;
};

type PrintDocumentStoreOptions = {
  createToken?: () => string;
  maxHtmlBytes?: number;
};

export class PrintDocumentStore {
  readonly #documents = new Map<string, string>();
  readonly #createToken: () => string;
  readonly #maxHtmlBytes: number;

  constructor(options: PrintDocumentStoreOptions = {}) {
    this.#createToken = options.createToken ?? randomUUID;
    this.#maxHtmlBytes = options.maxHtmlBytes ?? MAX_PRINT_HTML_BYTES;
  }

  publish(html: string): PrintDocumentLease {
    if (Buffer.byteLength(html, "utf8") > this.#maxHtmlBytes) {
      throw new Error("打印文档过大，无法安全加载。");
    }
    const token = this.#createToken();
    if (this.#documents.has(token)) throw new Error("打印文档标识冲突。");
    this.#documents.set(token, html);
    return {
      url: `${PRINT_DOCUMENT_SCHEME}://job/${token}`,
      dispose: () => {
        this.#documents.delete(token);
      },
    };
  }

  consume(candidate: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== `${PRINT_DOCUMENT_SCHEME}:` ||
      parsed.hostname !== "job" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const token = parsed.pathname.slice(1);
    if (!token || parsed.pathname !== `/${token}`) return null;
    const html = this.#documents.get(token);
    if (html === undefined) return null;
    this.#documents.delete(token);
    return html;
  }
}
