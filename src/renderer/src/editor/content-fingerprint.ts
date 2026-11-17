import type { JSONContent } from "@tiptap/core";

class SerializedDocumentParts {
  constructor(readonly blocks: readonly string[]) {}
}

export class ContentFingerprint {
  private serializedValue = "";
  private readonly parts: readonly string[] | undefined;
  private normalized: string | undefined;

  constructor(content: unknown) {
    if (content instanceof SerializedDocumentParts) this.parts = content.blocks;
    else this.serializedValue = JSON.stringify(content);
  }

  get serialized(): string {
    if (this.parts && !this.serializedValue)
      this.serializedValue = `{"type":"doc","content":[${this.parts.join(",")}]}`;
    return this.serializedValue;
  }

  sameSerialized(other: ContentFingerprint): boolean {
    if (this === other) return true;
    const otherParts = other.parts;
    if (this.parts && otherParts)
      return (
        this.parts.length === otherParts.length &&
        this.parts.every((block, index) => block === otherParts[index])
      );
    return this.serialized === other.serialized;
  }

  matches(other: ContentFingerprint): boolean {
    return this.sameSerialized(other) || this.canonical() === other.canonical();
  }

  private canonical(): string {
    // Local edits and cloned echoes have identical JSON field order. Normalize
    // only external/differently ordered objects, retaining exact (not hashed)
    // comparison for external edits and undo.
    this.normalized ??= JSON.stringify(JSON.parse(this.serialized), (_key, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, (value as Record<string, unknown>)[key]]),
      );
    });
    return this.normalized;
  }
}

/** Only for private immutable editor JSON. Public/mutable values use the constructor. */
export function createEditorContentFingerprint() {
  const blocks = new WeakMap<JSONContent, string>();
  return (content: JSONContent): ContentFingerprint => {
    const keys = Object.keys(content);
    if (
      content.type !== "doc" ||
      keys.length !== 2 ||
      keys[0] !== "type" ||
      keys[1] !== "content" ||
      !Array.isArray(content.content)
    )
      return new ContentFingerprint(content);
    return new ContentFingerprint(
      new SerializedDocumentParts(
        content.content.map((block) => {
          let serialized = blocks.get(block);
          if (serialized === undefined) {
            serialized = JSON.stringify(block);
            blocks.set(block, serialized);
          }
          return serialized;
        }),
      ),
    );
  };
}

// Immutable renderer snapshots carry local echo provenance outside patent data.
// Only the editor and its unchanged deep-clone path may populate this map.
const documentEchoes = new WeakMap<object, ContentFingerprint>();

export function rememberDocumentEcho(document: unknown, fingerprint: ContentFingerprint): void {
  if (document && typeof document === "object") documentEchoes.set(document, fingerprint);
}

export function documentEcho(document: unknown): ContentFingerprint | undefined {
  return document && typeof document === "object" ? documentEchoes.get(document) : undefined;
}

export function inheritDocumentEcho(original: unknown, clone: unknown): void {
  const fingerprint = documentEcho(original);
  if (fingerprint) rememberDocumentEcho(clone, fingerprint);
}
