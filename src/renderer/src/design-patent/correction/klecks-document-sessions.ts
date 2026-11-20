export type KlecksSessionToken = Readonly<{
  owner: symbol;
  id: string;
  generation: number;
  revision: number;
  contentId: string;
}>;

type Session<T> = {
  generation: number;
  revision: number;
  contentId: string;
  savedContentId: string;
  savedRevision: number;
  state: T | null;
};

/** Holds opaque engine states; this does not serialize Klecks or persist assets. */
export class KlecksDocumentSessions<T> {
  private readonly owner = Symbol("KlecksDocumentSessions");
  private readonly documents = new Map<string, Session<T>>();
  private order: string[] = [];
  private generation = 0;
  private active: string | null = null;

  get activeId(): string | null {
    return this.active;
  }

  get ids(): readonly string[] {
    return [...this.order];
  }

  /** Call only after the host's pending-operation/deletion guards succeed. */
  sync(ids: readonly string[], target?: string): void {
    if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
      throw new Error("图片文档标识必须非空且唯一。");
    }
    const previousIndex = this.active ? this.order.indexOf(this.active) : 0;
    const added = ids.filter((id) => !this.documents.has(id));
    const retained = new Set(ids);
    for (const id of this.order) {
      if (!retained.has(id)) this.documents.delete(id);
    }
    for (const id of added) {
      this.documents.set(id, {
        generation: ++this.generation,
        revision: 0,
        contentId: "initial",
        savedContentId: "initial",
        savedRevision: 0,
        state: null,
      });
    }
    this.order = [...ids];
    this.active =
      (target && retained.has(target) ? target : null) ??
      added[0] ??
      (this.active && retained.has(this.active) ? this.active : null) ??
      ids[Math.min(Math.max(previousIndex, 0), ids.length - 1)] ??
      null;
  }

  activate(id: string): void {
    this.require(id);
    this.active = id;
  }

  get(id: string): Readonly<{ state: T | null; dirty: boolean }> | null {
    const session = this.documents.get(id);
    return session
      ? { state: session.state, dirty: session.contentId !== session.savedContentId }
      : null;
  }

  /** State ownership transfers to the manager; caller must not mutate it afterward. */
  update(id: string, state: T, contentId?: string): void {
    const session = this.require(id);
    session.revision++;
    session.state = state;
    session.contentId = contentId ?? `edit:${session.generation}:${session.revision}`;
  }

  token(id: string): KlecksSessionToken {
    const session = this.require(id);
    return Object.freeze({
      owner: this.owner,
      id,
      generation: session.generation,
      revision: session.revision,
      contentId: session.contentId,
    });
  }

  /** Invoke only after host persistence has atomically committed this token's snapshot. */
  saved(token: KlecksSessionToken): boolean {
    const session = this.documents.get(token.id);
    if (
      token.owner !== this.owner ||
      !session ||
      session.generation !== token.generation ||
      token.revision < session.savedRevision
    ) {
      return false;
    }
    session.savedRevision = token.revision;
    session.savedContentId = token.contentId;
    return true;
  }

  private require(id: string): Session<T> {
    const session = this.documents.get(id);
    if (!session) throw new Error("图片文档已不存在。");
    return session;
  }
}
