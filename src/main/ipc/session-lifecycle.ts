import { AppOperationError } from "../app-operation-error.js";

function sessionError(code: "CANCELLED" | "INVALID_INPUT"): AppOperationError {
  return new AppOperationError({ code, message: "normalized" });
}

export class SessionLifecycle {
  readonly #activeDocumentIds = new Map<string, string>();
  readonly #retiredSessionIds = new Set<string>();

  get hasActiveSessions(): boolean {
    return this.#activeDocumentIds.size > 0;
  }

  activate(sessionId: string, documentId: string): void {
    if (this.#retiredSessionIds.has(sessionId)) throw sessionError("CANCELLED");
    const activeDocumentId = this.#activeDocumentIds.get(sessionId);
    if (activeDocumentId && activeDocumentId !== documentId) throw sessionError("INVALID_INPUT");
    this.#activeDocumentIds.set(sessionId, documentId);
  }

  requireActive(sessionId: string, documentId?: string): string {
    const activeDocumentId = this.#activeDocumentIds.get(sessionId);
    if (!activeDocumentId || this.#retiredSessionIds.has(sessionId)) {
      throw sessionError("CANCELLED");
    }
    if (documentId !== undefined && activeDocumentId !== documentId) {
      throw sessionError("INVALID_INPUT");
    }
    return activeDocumentId;
  }

  retire(sessionId: string): string | undefined {
    const documentId = this.#activeDocumentIds.get(sessionId);
    if (!documentId) return undefined;
    this.#activeDocumentIds.delete(sessionId);
    this.#retiredSessionIds.add(sessionId);
    return documentId;
  }
}
