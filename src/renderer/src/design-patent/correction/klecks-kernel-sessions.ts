import type { KlecksPortIdentity } from "./klecks-command-port";
import type { KlecksDocumentIdentity } from "./klecks-document-port";
import type { KlecksFrameClient } from "./klecks-frame-client";
import type { KlecksEditorState } from "./klecks-state-port";

type Session = {
  prefix: string;
  documents: Map<string, KlecksDocumentIdentity>;
  state: KlecksEditorState | null;
  states: Map<string, KlecksEditorState>;
  listeners: Set<(state: KlecksEditorState | null) => void>;
  releases: Set<() => void>;
  closed: boolean;
  lockToken?: string;
};

/** Logical case clients multiplex a single authenticated kernel. No case sees another's IDs. */
export class KlecksKernelSessions {
  private sessions = new Map<string, Session>();
  private selected: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private unsubscribe: () => void;
  private interaction = 0;
  private trackInteraction = () => {
    this.interaction++;
  };
  constructor(
    private kernel: KlecksFrameClient,
    private kernelId: string,
    private changed = () => {},
  ) {
    this.unsubscribe = kernel.state.subscribe((state) => this.receive(state));
    document.addEventListener("pointerdown", this.trackInteraction, true);
    document.addEventListener("keydown", this.trackInteraction, true);
  }
  get selectedId() {
    return this.selected;
  }
  get displayingId() {
    const id = this.kernel.state.snapshot()?.activeId;
    return (
      [...this.sessions].find(([, session]) =>
        [...session.documents.values()].some((doc) => doc.viewId === id),
      )?.[0] ?? null
    );
  }
  select(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.closed) throw new Error("案件编辑会话已关闭。");
    const current = this.kernel.state.snapshot();
    if (this.displayingId !== id && current?.pending)
      throw new Error("请先返回原案件完成或取消当前工具操作，再切换编辑案件。原编辑内容仍保留。");
    this.selected = id;
    this.changed();
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.catch(() => {}).then(operation);
    this.tail = work.catch(() => {});
    return work;
  }
  private collection(replaceId?: string, replace?: Map<string, KlecksDocumentIdentity>) {
    return [...this.sessions].flatMap(([id, session]) => [
      ...(id === replaceId && replace ? replace : session.documents).values(),
    ]);
  }
  private receive(state: KlecksEditorState | null) {
    if (!state) return;
    for (const [id, session] of this.sessions) {
      const localId = [...session.documents].find(([, doc]) => doc.viewId === state.activeId)?.[0];
      if (!localId) continue;
      const next = structuredClone(state);
      next.ids = [...session.documents.keys()];
      next.activeId = localId;
      next.identity = state.identity ? { ...state.identity, sessionId: id, viewId: localId } : null;
      session.state = next;
      session.states.set(localId, next);
      for (const listener of session.listeners) listener(structuredClone(next));
    }
    this.changed();
  }
  attach(id: string): KlecksFrameClient {
    if (this.sessions.has(id)) throw new Error("案件编辑会话重复打开。");
    const session: Session = {
      prefix: crypto.randomUUID(),
      documents: new Map(),
      state: null,
      states: new Map(),
      listeners: new Set(),
      releases: new Set(),
      closed: false,
    };
    this.sessions.set(id, session);
    const identity = (target: KlecksPortIdentity, active = false): KlecksPortIdentity => {
      const doc = session.documents.get(target.viewId);
      if (
        session.closed ||
        target.sessionId !== id ||
        !doc ||
        doc.generation !== target.generation ||
        (active && this.selected !== id)
      )
        throw new Error("图片编辑目标已切换，请在当前案件重试。");
      return { sessionId: this.kernelId, ...doc };
    };
    const activeCall = <T>(
      target: KlecksPortIdentity,
      call: (target: KlecksPortIdentity) => Promise<T>,
    ) => this.queue(() => call(identity(target, true)));
    const backgroundCall = <T>(
      target: KlecksPortIdentity,
      call: (target: KlecksPortIdentity) => Promise<T>,
    ) => this.queue(() => call(identity(target)));
    const remember = (release?: () => void) => {
      if (!release) return () => {};
      session.releases.add(release);
      return () => {
        session.releases.delete(release);
        release();
      };
    };
    const frozen = new Map<number, number | undefined>();
    const client: KlecksFrameClient = {
      isActive: () => !session.closed && this.selected === id,
      state: {
        snapshot: () => (session.state ? structuredClone(session.state) : null),
        forDocument: (viewId) => structuredClone(session.states.get(viewId) ?? null),
        subscribe: (listener) => {
          session.listeners.add(listener);
          listener(client.state.snapshot());
          return () => {
            session.listeners.delete(listener);
          };
        },
        close: () => {
          session.listeners.clear();
        },
      },
      documents: {
        sync: (sessionId, documents, lockToken) =>
          this.queue(async () => {
            if (session.closed || sessionId !== id) throw new Error("案件会话不匹配。");
            const next = new Map(
              documents.map((doc) => [
                doc.viewId,
                {
                  viewId:
                    session.documents.get(doc.viewId)?.generation === doc.generation
                      ? session.documents.get(doc.viewId)!.viewId
                      : `${session.prefix}:${crypto.randomUUID()}`,
                  generation: doc.generation,
                },
              ]),
            );
            if (this.collection(id, next).length > 500)
              throw new Error(
                "共享编辑器最多同时保留500张图片，请先保存并关闭部分案件。现有图片和编辑内容未变更。",
              );
            const accepted = await this.kernel.documents.sync(
              this.kernelId,
              this.collection(id, next),
              lockToken ? `${session.prefix}:${lockToken}` : undefined,
            );
            if (accepted) {
              session.documents = next;
              for (const [key, state] of session.states)
                if (!next.has(key) || state.identity?.generation !== next.get(key)?.generation)
                  session.states.delete(key);
              if (session.state) {
                session.state.ids = [...next.keys()];
                if (
                  session.state.activeId &&
                  (!next.has(session.state.activeId) ||
                    session.state.identity?.generation !==
                      next.get(session.state.activeId)?.generation)
                )
                  session.state = null;
              }
              this.receive(this.kernel.state.snapshot());
            }
            return accepted;
          }),
        activate: (target, options) =>
          this.queue(async () => {
            const value = identity(target);
            if (options?.signal?.aborted) return false;
            if (this.selected === id) return this.kernel.documents.activate(value, options);
            // Background temporary-file export only selects logical metadata, never the visible canvas.
            const saved = session.states.get(target.viewId);
            if (!saved || saved.identity?.generation !== target.generation) return false;
            session.state = structuredClone(saved);
            for (const listener of session.listeners) listener(structuredClone(session.state));
            return true;
          }),
        openRaster: (target, name, source, options) =>
          activeCall(target, (value) =>
            this.kernel.documents.openRaster(value, name, source, options),
          ),
        openProject: (target, project, applied, options) =>
          activeCall(target, (value) =>
            this.kernel.documents.openProject(value, project, applied, options),
          ),
        interactionLock: (sessionId, token, locked) =>
          this.queue(async () => {
            if (sessionId !== id) throw new Error("案件会话不匹配。");
            if (session.closed && !locked) return true;
            if (session.closed) throw new Error("案件编辑会话已关闭。");
            const scoped = `${session.prefix}:${token}`;
            const accepted = await this.kernel.documents.interactionLock(
              this.kernelId,
              scoped,
              locked,
            );
            if (accepted) {
              if (locked) session.lockToken = scoped;
              else delete session.lockToken;
            }
            return accepted;
          }),
        close: () => {},
      },
      tools: {
        send: (target, command) => {
          const interaction = this.interaction;
          return activeCall(target, (value) => {
            if (
              command.action === "focus" &&
              (interaction !== this.interaction ||
                document.activeElement?.closest(
                  'summary,input,select,textarea,[role="dialog"],[role="menu"]',
                ))
            )
              return Promise.resolve();
            return this.kernel.tools.send(value, command);
          });
        },
        close: () => {},
      },
      send: (target, action) => activeCall(target, (value) => this.kernel.send(value, action)),
      projects: {
        freeze: (target) =>
          backgroundCall(target, async (value) => {
            const revision =
              session.state?.identity?.viewId === target.viewId
                ? session.state.checkpointRevision
                : undefined;
            const result = await this.kernel.projects.freeze(value);
            frozen.set(result.ticket, revision);
            return result;
          }),
        confirmSaved: (target, ticket) =>
          backgroundCall(target, async (value) => {
            const accepted = await this.kernel.projects.confirmSaved(value, ticket);
            // Background acknowledgements do not publish the inactive document from the kernel.
            if (
              accepted &&
              this.displayingId !== id &&
              session.state?.identity?.viewId === target.viewId &&
              session.state.checkpointRevision === frozen.get(ticket)
            ) {
              session.state.dirty = false;
              session.states.set(target.viewId, session.state);
              for (const listener of session.listeners) listener(structuredClone(session.state));
            }
            frozen.delete(ticket);
            return accepted;
          }),
        confirmApplied: (target, ticket) =>
          backgroundCall(target, async (value) => {
            const accepted = (await this.kernel.projects.confirmApplied?.(value, ticket)) ?? false;
            if (
              accepted &&
              this.displayingId !== id &&
              session.state?.identity?.viewId === target.viewId &&
              session.state.checkpointRevision === frozen.get(ticket)
            ) {
              session.state.dirty = false;
              session.state.unapplied = false;
              session.states.set(target.viewId, session.state);
              for (const listener of session.listeners) listener(structuredClone(session.state));
            }
            frozen.delete(ticket);
            return accepted;
          }),
        discard: (target, ticket) =>
          backgroundCall(target, async (value) => {
            const accepted = await this.kernel.projects.discard(value, ticket);
            frozen.delete(ticket);
            return accepted;
          }),
        close: () => {},
      },
      onFilesDropped: (listener, error) =>
        remember(
          this.kernel.onFilesDropped?.(
            (files) => {
              if (this.selected === id) listener(files);
            },
            (message) => {
              if (this.selected === id) error(message);
            },
          ),
        ),
      onSaveRequested: (listener) =>
        remember(
          this.kernel.onSaveRequested?.((target) => {
            const viewId = [...session.documents].find(
              ([, doc]) => doc.viewId === target.viewId,
            )?.[0];
            if (this.selected === id && viewId) listener({ ...target, sessionId: id, viewId });
          }),
        ),
      onClipboardRequested: (_sessionId, listener) =>
        remember(
          this.kernel.onClipboardRequested?.(this.kernelId, (action, target) => {
            const viewId = [...session.documents].find(
              ([, doc]) => doc.viewId === target.viewId,
            )?.[0];
            if (this.selected === id && viewId)
              listener(action, { ...target, sessionId: id, viewId });
          }),
        ),
      close: () => {
        session.listeners.clear();
      },
    };
    if (this.kernel.clipboard) {
      const clipboard = this.kernel.clipboard;
      client.clipboard = {
        copy: (target, revision, cut, merged) =>
          activeCall(target, (value) => clipboard.copy(value, revision, cut, merged)),
        paste: (target, revision, image) =>
          activeCall(target, (value) => clipboard.paste(value, revision, image)),
        pasteInternal: (target, revision, inPlace) =>
          activeCall(target, (value) => clipboard.pasteInternal(value, revision, inPlace)),
        close: () => {},
      };
    }
    return client;
  }
  /** Serialize scratch work without opening, editing or replacing any user document. */
  withScratch<T>(
    run: (
      frame: KlecksFrameClient,
      sessionId: string,
      sync: (docs: KlecksDocumentIdentity[]) => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.queue(async () => {
      const original = this.kernel.state.snapshot();
      if (original?.pending || original?.locked || original?.navigationActive)
        throw new Error("请先完成当前修图操作，再统一尺寸。");
      const retained = this.collection();
      if (retained.length >= 500)
        throw new Error("编辑器已达到图片数量上限，请先关闭其他图片案件。");
      const restoreOriginal = async () => {
        if (!(await this.kernel.documents.sync(this.kernelId, retained)))
          throw new Error("临时图片集合未能恢复，本次未提交。");
        if (original?.identity && !(await this.kernel.documents.activate(original.identity)))
          throw new Error("未能恢复原活动图片，本次未提交。");
      };
      try {
        return await run(this.kernel, this.kernelId, (docs) =>
          this.kernel.documents.sync(this.kernelId, [...retained, ...docs]),
        );
      } finally {
        await restoreOriginal();
      }
    });
  }
  async detach(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.closed) return;
    await this.queue(async () => {
      if (session.lockToken) {
        await this.kernel.documents.interactionLock(this.kernelId, session.lockToken, false);
        delete session.lockToken;
      }
      await this.kernel.documents.sync(this.kernelId, this.collection(id, new Map()));
      session.closed = true;
      for (const release of session.releases) release();
      session.releases.clear();
      session.listeners.clear();
      this.sessions.delete(id);
      if (this.selected === id) this.selected = null;
      this.changed();
    });
  }
  dispose() {
    this.unsubscribe();
    document.removeEventListener("pointerdown", this.trackInteraction, true);
    document.removeEventListener("keydown", this.trackInteraction, true);
  }
}
