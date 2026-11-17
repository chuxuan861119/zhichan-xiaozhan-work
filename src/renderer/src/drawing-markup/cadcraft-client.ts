import { isMacPlatform } from "../../../shared/platform";

/** Immutable in-memory checkpoint; materialized to DXF only by the save worker. */
export type CadCheckpoint = {
  source: Uint8Array;
  sourceId?: string;
  edits: { command: string; params: object; paste?: Uint8Array }[];
};
export type CadScene = {
  appearance?: import("./cad-appearance-panel").CadAppearance;
  linetypes?: string[];
  /** Preview-only delta; absent entities/primitives remain in the base scene. */
  partial?: boolean;
  removedHandles?: string[];
  acceptedPointIndices?: number[];
  gapPoints?: [number, number][];
  rejectedPointIndices?: number[];
  revision: number;
  entityCount: number;
  selection: string[];
  bounds: { min: [number, number]; max: [number, number] } | null;
  svgFrame: { origin: [number, number]; width: number; height: number };
  entities: {
    handle: string;
    type: string;
    appearance?: import("./cad-appearance-panel").CadAppearance;
    gear?: { kind: "external" | "internal" | "rack"; teeth: number; hole: boolean; size: number };
    gearMate?: string;
    gearMates?: string[];
    chain?: import("./cad-chain-geometry").ChainSpec;
    spring?: { kind?: "compression" | "extension"; turns: number; wire: number; length: number; width: number; at: [number,number]; end: [number,number]; rotation: number };
    layer: string;
    locked?: boolean;
    visible?: boolean;
    grips?: [number, number][];
    text?: string;
    plainText?: string;
    textOrigin?: [number, number];
    width?: number;
    height?: number;
    radius?: number;
    rotation?: number;
    lineweight?: number;
    geometry?: {
      type: string;
      a?: { x: number; y: number };
      b?: { x: number; y: number };
      center?: { x: number; y: number };
      radius?: number;
      start?: number;
      end?: number;
      closed?: boolean;
      vertices?: { p?: { x: number; y: number }; bulge: number }[];
    };
    common?: { extrusion?: { x: number; y: number; z: number } };
  }[];
  groups?: { name: string; selectable: boolean; members: string[] }[];
  primitives: {
    handle: string;
    kind: string;
    points: [number, number][];
    color: [number, number, number];
    aci7: boolean;
    lineweight: number;
  }[];
};

/** Dedicated worker keeps CAD parsing/geometry away from editor keystrokes. */
export class CadcraftClient {
  private worker = new Worker(new URL("./cadcraft-worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private pasteInput: {bytes:Uint8Array;id:number;ready:boolean}|undefined;
  private closed = false;
  private macReplies: (() => void)[] = [];
  private macReplyTimer: ReturnType<typeof setTimeout> | undefined;
  get isClosed() {
    return this.closed;
  }
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    this.worker.onmessage = (event) => {
      const result = event.data;
      if (!this.pending.has(result.id)) return;
      const deliver = () => {
        const waiter = this.pending.get(result.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(result.id);
        if (result.ok) waiter.resolve(result.value);
        else waiter.reject(new Error(result.error.replace(/^CAD_GEAR_MESH_REJECTED:/, "")));
      };
      // On Mac, separate structured-clone decoding from a dense scene's UI
      // work. Preserve reply order, including later small replies and errors.
      if (isMacPlatform() && (this.macReplyTimer !== undefined ||
          result.ok && result.value?.scene?.primitives?.length >= 5000)) {
        this.macReplies.push(deliver);
        this.scheduleMacReply();
      } else deliver();
    };
    this.worker.onerror = () => this.close("CAD 编辑组件加载失败，请重试。");
  }
  private scheduleMacReply() {
    if (this.macReplyTimer !== undefined) return;
    this.macReplyTimer = setTimeout(() => {
      this.macReplyTimer = undefined;
      this.macReplies.shift()?.();
      if (this.macReplies.length) this.scheduleMacReply();
    }, 0);
  }
  request<T>(
    method:
      | "load"
      | "restore"
      | "checkout"
      | "remember"
      | "execute"
      | "edit"
      | "editPaste"
      | "materialize"
      | "query"
      | "scene"
      | "commands"
      | "pick"
      | "export"
      | "compose"
      | "synchronize"
      | "renderLabelFree"
      | "labelGlyph"
      | "paste",
    ...args: unknown[]
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CAD 编辑会话已关闭。"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      let pasteInput:typeof this.pasteInput;
      if(method==="editPaste"&&args[0] instanceof Uint8Array) {
        const bytes=args[0];
        pasteInput=this.pasteInput?.bytes===bytes ? this.pasteInput : {bytes,id,ready:false};
        this.pasteInput=pasteInput;
        args[0]={id:pasteInput.id,...(!pasteInput.ready?{bytes}:{})};
      }
      const timer = setTimeout(
        () => this.close("CAD 操作超时，已停止处理，已保存内容不受影响。"),
        120_000,
      );
      this.pending.set(id, { resolve: (value) => {if(pasteInput)pasteInput.ready=true;resolve(value as T);}, reject:(error)=>{if(this.pasteInput===pasteInput)this.pasteInput=undefined;reject(error);}, timer });
      this.worker.postMessage({ id, method, args });
    });
  }
  close(message = "CAD 编辑会话已关闭。") {
    this.closed = true;
    this.pasteInput=undefined;
    clearTimeout(this.macReplyTimer);
    this.macReplyTimer = undefined;
    this.macReplies = [];
    this.worker.terminate();
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    this.pending.clear();
  }
}

/** Composition requests reload their checkpoint; never reuse a terminated worker. */
export function ensureCadcraftClient(client: CadcraftClient | null): CadcraftClient {
  return client && !client.isClosed ? client : new CadcraftClient();
}
