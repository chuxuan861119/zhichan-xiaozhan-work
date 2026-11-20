import { packKlecksHistory, unpackKlecksHistory } from "./klecks-history-binary";

export type KlecksSessionStore = {
  put(id: string, value: unknown): Promise<void>;
  get(id: string): Promise<unknown>;
  remove(id: string): Promise<void>;
};

/** Runtime-only history storage. A failed transaction never removes the in-memory copy. */
export class KlecksSessionCache {
  private hot = new Map<string, { value: unknown; bytes: number }>();
  private cold = new Set<string>();
  private sizes = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private store: KlecksSessionStore,
    private limit = { entries: 2, bytes: 128 * 1024 ** 2 },
  ) {}
  get hotCount() {
    return this.hot.size;
  }
  get hotBytes() {
    return [...this.hot.values()].reduce((sum, item) => sum + item.bytes, 0);
  }
  bytes(id: string) {
    return this.sizes.get(id) ?? 0;
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.catch(() => {}).then(operation);
    this.tail = work.catch(() => {});
    return work;
  }
  put(id: string, value: unknown, bytes: number) {
    return this.queue(async () => {
      this.sizes.set(id, bytes);
      this.hot.delete(id);
      this.hot.set(id, { value, bytes });
      while (this.hot.size > this.limit.entries || this.hotBytes > this.limit.bytes) {
        const [key, item] = this.hot.entries().next().value!;
        await this.store.put(key, item.value);
        this.cold.add(key);
        // A replacement may have arrived during the transaction.
        if (this.hot.get(key) === item) this.hot.delete(key);
      }
    });
  }
  get(id: string): Promise<unknown> {
    return this.queue(async () => {
      const item = this.hot.get(id);
      if (item) {
        this.hot.delete(id);
        this.hot.set(id, item);
        return item.value;
      }
      return this.cold.has(id) ? this.store.get(id) : undefined;
    });
  }
  remove(id: string) {
    return this.queue(async () => {
      // Do not let a late deletion delete a replacement written under the same ID.
      if (this.cold.has(id)) await this.store.remove(id);
      this.hot.delete(id);
      this.cold.delete(id);
      this.sizes.delete(id);
    });
  }
}

/** Unique database belongs solely to this iframe lifetime; no patent backup records are created. */
export function createKlecksSessionStore(): KlecksSessionStore & { close(): void } {
  const name = `design-editor-session-${crypto.randomUUID()}`;
  // Never persist the key: crash residue cannot expose the library's decrypted image material.
  const key = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  void key.catch(() => {});
  const ready = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("histories");
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开编辑会话缓存。"));
    request.onsuccess = () => resolve(request.result);
  });
  void ready.catch(() => {});
  const transact = async (
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ) => {
    const db = await ready;
    return new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction("histories", mode),
        request = operation(transaction.objectStore("histories"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error("编辑会话缓存写入失败，原编辑内容已保留。"));
    });
  };
  return {
    put: async (id, value) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
        await key,
        packKlecksHistory(value),
      );
      await transact("readwrite", (store) => store.put({ iv, cipher }, id));
    },
    get: async (id) => {
      const encrypted = (await transact("readonly", (store) => store.get(id))) as
        | { iv: Uint8Array<ArrayBuffer>; cipher: ArrayBuffer }
        | undefined;
      if (!encrypted) return undefined;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: encrypted.iv, additionalData: new TextEncoder().encode(id) },
        await key,
        encrypted.cipher,
      );
      return unpackKlecksHistory(new Uint8Array(plain));
    },
    remove: async (id) => {
      await transact("readwrite", (store) => store.delete(id));
    },
    close: () => {
      void ready
        .then((db) => {
          db.close();
          indexedDB.deleteDatabase(name);
        })
        .catch(() => {});
    },
  };
}
