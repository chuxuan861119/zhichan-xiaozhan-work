import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";

export function normalizeDocumentPath(path: string): string {
  if (process.platform === "win32" || /^[a-z]:[\\/]|^\\\\/iu.test(path)) {
    return win32
      .normalize(path.trim().replaceAll("/", "\\"))
      .replace(/\\+$/u, "")
      .toLocaleLowerCase("en-US");
  }
  // Resolve existing aliases (including APFS case aliases); preserve the spelling
  // of a new save target on case-sensitive volumes and literal POSIX backslashes.
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(normalizeDocumentPath(parent), basename(absolute));
  }
}

export type DocumentPathReservation = {
  commit(): void;
  rollback(): void;
};

export class DocumentRegistry {
  readonly #sessionsByPath = new Map<string, string>();
  readonly #pathsBySession = new Map<string, string>();
  readonly #sessionEpochs = new Map<string, number>();

  register(sessionId: string, path: string): void {
    this.reserve(sessionId, path).commit();
  }

  reserve(sessionId: string, path: string): DocumentPathReservation {
    const normalized = normalizeDocumentPath(path);
    const existingSession = this.#sessionsByPath.get(normalized);
    if (existingSession && existingSession !== sessionId) {
      throw new Error("该文档已打开。");
    }
    const previousPath = this.#pathsBySession.get(sessionId);
    const epoch = this.#sessionEpochs.get(sessionId) ?? 0;
    this.#sessionsByPath.set(normalized, sessionId);
    let active = true;
    return {
      commit: () => {
        if (!active) return;
        if ((this.#sessionEpochs.get(sessionId) ?? 0) !== epoch) {
          active = false;
          if (this.#sessionsByPath.get(normalized) === sessionId) {
            this.#sessionsByPath.delete(normalized);
          }
          throw new Error("文档会话已释放。");
        }
        active = false;
        if (previousPath && previousPath !== normalized) {
          this.#sessionsByPath.delete(previousPath);
        }
        this.#pathsBySession.set(sessionId, normalized);
      },
      rollback: () => {
        if (!active) return;
        active = false;
        if (normalized !== previousPath && this.#sessionsByPath.get(normalized) === sessionId) {
          this.#sessionsByPath.delete(normalized);
        }
      },
    };
  }

  findSessionByPath(path: string): string | undefined {
    return this.#sessionsByPath.get(normalizeDocumentPath(path));
  }

  getPath(sessionId: string): string | undefined {
    return this.#pathsBySession.get(sessionId);
  }

  release(sessionId: string): void {
    for (const [path, owner] of this.#sessionsByPath) {
      if (owner === sessionId) this.#sessionsByPath.delete(path);
    }
    this.#pathsBySession.delete(sessionId);
    this.#sessionEpochs.set(sessionId, (this.#sessionEpochs.get(sessionId) ?? 0) + 1);
  }
}
