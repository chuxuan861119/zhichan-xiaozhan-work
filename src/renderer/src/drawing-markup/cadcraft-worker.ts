import init, { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import { type CadExportScene, compileCadExport, executeCadExportCommand } from "../../../shared/drawing-markup/cad-export";
import { synchronizeCad } from "../../../shared/drawing-markup/cad-unified";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { type CadEditContext, editCadTransaction } from "./cad-edit-transaction";
import type { CadCheckpoint } from "./cadcraft-client";
import { CadJournal } from "./cad-journal";
import { CadIncrementalComposition, type CadDraftData } from "./cad-incremental-composition";
import { drawingEditEqual } from "../../../shared/drawing-markup/performance";
import { cadLabelFreeSvg } from "./cad-label-preview";

const ready = Promise.all([
  init({
    module_or_path: new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url)
      .href,
  }),
  fetch(
    new URL("../../../shared/document/fonts/SourceHanSerifCN-Regular.otf", import.meta.url),
  ).then(async (response) => {
    if (!response.ok) throw new Error("CAD 中文字体未能加载。");
    return new Uint8Array(await response.arrayBuffer());
  }),
]);
let session: CadcraftSession | undefined;
let checkpoint: CadCheckpoint | undefined;
const checkpoints = new Map<string, CadCheckpoint>();
let composition: CadIncrementalComposition | undefined;
let materializer: CadJournal | undefined;
let materializedBytes: Uint8Array | undefined;
let pasteInput: {id:number;bytes:Uint8Array}|undefined;
function remember(key: unknown) {
  if (typeof key !== "string" || !checkpoint || !session) return;
  checkpoints.delete(key);
  checkpoints.set(key, checkpoint);
  const forgotten: string[] = [];
  let bytes = [...checkpoints.values()].reduce((n, p) => n + p.source.byteLength, 0);
  while (checkpoints.size > 1 && (checkpoints.size > 8 || bytes > 32 * 1024 * 1024)) {
    const id = checkpoints.keys().next().value!;
    bytes -= checkpoints.get(id)!.source.byteLength;
    checkpoints.delete(id);
    forgotten.push(id);
  }
  session.execute("bridge.remember", JSON.stringify({ key, forget: forgotten }));
}
let queue = Promise.resolve();
self.onmessage = (event) => {
  const request = event.data as {
    id: number;
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
      | "paste";
    args: unknown[];
  };
  queue = queue.then(async () => {
    try {
      const [, font] = await ready;
      if (!session) {
        session = new CadcraftSession();
        session.register_font("Source Han Serif CN", font);
      }
      let value: unknown;
      switch (request.method) {
        case "load":
        case "restore": {
          const data = request.args[0] as CadDraftData;
          const next = data instanceof Uint8Array ? { source: data, sourceId: typeof request.args[1] === "string" ? request.args[1] : crypto.randomUUID(), edits: [] } : data;
          const journal = new CadJournal(session);
          if (checkpoint) journal.adopt(checkpoint);
          try { journal.load(next); } catch (error) { checkpoint = undefined; throw error; }
          checkpoint = next;
          remember(request.args[1]);
          // With a retained scene, do not tessellate again during history restore.
          value = request.method === "load" ? JSON.parse(session.scene()) : null;
          break;
        }
        case "remember":
          // Newer commands may already have run while React published this revision.
          // Never cache their model under an older checkpoint identity.
          if (checkpoint && drawingEditEqual(checkpoint, request.args[1])) remember(request.args[0]);
          value = null;
          break;
        case "checkout": {
          const key = request.args[0] as string;
          const retained = checkpoints.get(key);
          const restored =
            retained &&
            JSON.parse(session.execute("bridge.checkout", JSON.stringify({ key }))).restored;
          if (restored) checkpoint = retained;
          value = restored ? { restored: true, checkpoint: retained } : { restored: false };
          break;
        }
        case "execute": {
          const result = JSON.parse(
            session.execute(request.args[0] as string, JSON.stringify(request.args[1])),
          );
          value = { result, scene: JSON.parse(session.scene()), bytes: session.export_dxf() };
          checkpoint = { source: (value as { bytes: Uint8Array }).bytes, edits: [] };
          break;
        }
        case "edit":
        case "editPaste": {
          if (!checkpoint) throw new Error("CAD 编辑快照尚未加载。");
          const paste = request.method === "editPaste";
          const command = paste ? "bridge.paste" : (request.args[0] as string);
          const params = request.args[1] as object;
          let pasteBytes:Uint8Array|undefined;
          if(paste) {
            const input=request.args[0] as Uint8Array|{id:number;bytes?:Uint8Array};
            if(input instanceof Uint8Array) pasteBytes=input;
            else {
              if(input.bytes)pasteInput={id:input.id,bytes:input.bytes};
              if(pasteInput?.id!==input.id)throw new Error("粘贴快照已失效，请重新复制后重试。");
              pasteBytes=pasteInput.bytes;
            }
          }
          const edited = editCadTransaction(
            session,
            command,
            params,
            request.args[2] as CadEditContext | undefined,
            pasteBytes,
          );
          if (edited.rejected) {
            value = edited;
            break;
          }
          checkpoint = {
            ...checkpoint,
            source: checkpoint.source,
            edits: [
              ...checkpoint.edits,
              { command, params, ...(pasteBytes ? { paste:pasteBytes } : {}) },
            ],
          };
          value = { ...edited, checkpoint };
          break;
        }
        case "materialize": {
          // Replay only accepted commands in an isolated worker. Saving/retry never
          // runs geometry or DXF serialization on the interactive editor worker.
          const frozen = request.args[0] as CadCheckpoint;
          materializer ??= new CadJournal(session);
          const changed = materializer.load(frozen);
          if (changed || !materializedBytes) {
            materializedBytes = undefined;
            materializedBytes = session.export_dxf();
          }
          value = materializedBytes;
          break;
        }
        case "scene":
          value = JSON.parse(session.scene());
          break;
        case "paste": {
          const result = JSON.parse(
            session.paste_dxf(request.args[0] as Uint8Array, JSON.stringify(request.args[1])),
          );
          value = { result, scene: JSON.parse(session.scene()), bytes: session.export_dxf() };
          checkpoint = { source: (value as { bytes: Uint8Array }).bytes, edits: [] };
          break;
        }
        case "query": {
          const command = request.args[0] as string;
          if (
            ![
              "layer",
              "properties",
              "select",
              "bridge.select_polygon",
              "bridge.preview_spline",
              "bridge.preview_draw",
              "bridge.preview_modify",
              "drawing.inspect",
              "hatch.patterns",
              "bridge.hatch_swatches",
            ].includes(command)
          )
            throw new Error("不支持此查询。");
          // Catalog lookup is read-only here; do not expose its load/clear variants as queries.
          const params = (command === "hatch.patterns" ? {} : request.args[1]) as {
            handles?: string[];
          };
          if (command === "properties" && params.handles)
            session.execute("select", JSON.stringify({ handles: params.handles }));
          const queryParams =
            command === "bridge.preview_modify" ? { ...params, compact: true } : params;
          value = JSON.parse(session.execute(command, JSON.stringify(queryParams)));
          break;
        }
        case "commands":
          value = JSON.parse(session.commands());
          break;
        case "pick":
          value = request.args[3] === "trim" ? JSON.parse(session.execute("bridge.pick_trim", JSON.stringify({
            point: [request.args[0], request.args[1]], aperture: request.args[2],
          }))) : session.pick(
            request.args[0] as number,
            request.args[1] as number,
            request.args[2] as number,
          );
          break;
        case "export":
          value = session.export_dxf();
          break;
        case "renderLabelFree": {
          const isolated = new CadcraftSession();
          try {
            isolated.register_font("Source Han Serif CN", font);
            value = cadLabelFreeSvg(
              isolated,
              request.args[0] as DrawingProject,
              request.args[1] as Uint8Array,
              request.args[2] as string[],
              request.args[3] as string[] | undefined,
            );
          } finally { isolated.free(); }
          break;
        }
        case "labelGlyph": {
          const [text, height] = request.args as [string, number];
          if (!text || text.length > 100 || !Number.isFinite(height) || height <= 0)
            throw new Error("无效的标号文字或字号。");
          const isolated = new CadcraftSession();
          try {
            isolated.register_font("Source Han Serif CN", font);
            isolated.execute("bridge.prepare_export", "{}");
            isolated.execute("text", JSON.stringify({ at: [0, 0], text, height, justify: "MC" }));
            value = JSON.parse(isolated.scene());
          } finally { isolated.free(); }
          break;
        }
        case "synchronize": {
          composition ??= new CadIncrementalComposition(session);
          value = composition.synchronize(request.args[0] as DrawingProject,
            new Map(request.args[1] as [string, CadDraftData][]),
            request.args[2] as DrawingProject | undefined, Boolean(request.args[3]));
          break;
        }
        case "compose": {
          const project = request.args[0] as DrawingProject;
          const sources = new Map(request.args[1] as [string, Uint8Array][]);
          const isolated = new CadcraftSession();
          try {
            isolated.register_font("Source Han Serif CN", font);
            if (project.cad?.unified) {
              const blank = new CadcraftSession();
              try {
                value = synchronizeCad(
                  isolated,
                  blank.export_dxf(),
                  project,
                  sources,
                  request.args[2] as DrawingProject | undefined,
                );
              } finally {
                blank.free();
              }
              break;
            }
            const scenes = new Map<string, CadExportScene>();
            for (const [id, bytes] of sources) {
              isolated.load_dxf(bytes);
              scenes.set(id, JSON.parse(isolated.scene()));
            }
            const plan = compileCadExport(project, scenes);
            if (plan.sourceCadAssetId) isolated.load_dxf(sources.get(plan.sourceCadAssetId)!);
            else {
              const blank = new CadcraftSession();
              try {
                isolated.load_dxf(blank.export_dxf());
              } finally {
                blank.free();
              }
            }
            for (const command of plan.commands)
              executeCadExportCommand(isolated,command);
            value = { bytes: isolated.export_dxf(), warnings: plan.warnings };
          } finally {
            isolated.free();
          }
          break;
        }
      }
      self.postMessage({ id: request.id, ok: true, value });
    } catch (error) {
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
