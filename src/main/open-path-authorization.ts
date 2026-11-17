import { normalizeDocumentPath } from "./documents/document-registry.js";

export class OpenPathAuthorization {
  readonly #counts = new Map<string, number>();

  authorize(path: string): void {
    const key = normalizeDocumentPath(path);
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  consume(path: string): boolean {
    const key = normalizeDocumentPath(path);
    const count = this.#counts.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.#counts.delete(key);
    else this.#counts.set(key, count - 1);
    return true;
  }

  revoke(path: string): void {
    this.consume(path);
  }
}
