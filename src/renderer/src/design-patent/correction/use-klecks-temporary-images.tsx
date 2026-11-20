import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CorrectionUnsavedDialog } from "./correction-unsaved-dialog";
import type { KlecksCaseDocuments } from "./klecks-case-documents";
import type { KlecksFrameClient } from "./klecks-frame-client";
import {
  TemporaryExportDialog,
  type TemporaryExportOptions,
  TemporaryFrameDialog,
} from "./klecks-temporary-dialogs";
import { exportKlecksTemporaryPsd, exportKlecksTemporaryRaster } from "./klecks-temporary-export";
import { TemporaryImageRevisions } from "./klecks-temporary-revisions";

type CloseChoice = "export" | "discard" | "cancel";
type Dialog =
  | {
      kind: "export";
      layered: boolean;
      batch?: boolean;
      name: string;
      size: { width: number; height: number };
      resolve(value: TemporaryExportOptions | null): void;
    }
  | { kind: "frame"; name: string; count: number; resolve(value: number | null): void }
  | { kind: "close"; count: number; resolve(value: CloseChoice): void };
const errorText = (error: unknown) =>
  typeof error === "object" && error && "message" in error
    ? String(error.message)
    : "图片处理失败，请重试。";

/** File imports and export decisions are memory-only; this hook has no patent writer. */
export function useKlecksTemporaryImages(
  controller: KlecksCaseDocuments | null,
  frame: KlecksFrameClient | null,
  ensureStarted: () => void,
) {
  const input = useRef<HTMLInputElement>(null);
  const revisions = useRef(new TemporaryImageRevisions());
  const [dialog, setDialog] = useState<Dialog | null>(null),
    dialogRef = useRef<Dialog | null>(null);
  const [message, setMessage] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const busyRef = useRef(false),
    alive = useRef(true),
    files = useRef<File[]>([]);
  const [batchActive, setBatchActive] = useState(false),
    [batchCancelRequested, setBatchCancelRequested] = useState(false);
  const batchCancel = useRef(false);
  const [queueVersion, queueChanged] = useState(0),
    [, redraw] = useState(0);
  const current = useRef({ controller, frame, ensureStarted });
  current.current = { controller, frame, ensureStarted };
  const operations = useRef({
    exportOne: async (_id: string): Promise<boolean> => false,
    closeAll: async (): Promise<boolean> => false,
  });
  const importRef = useRef<(files: readonly File[]) => void>(() => {});
  const present = useCallback((entry: Dialog) => {
    dialogRef.current = entry;
    setDialog(entry);
  }, []);
  const finish = (value: TemporaryExportOptions | number | CloseChoice | null) => {
    const entry = dialogRef.current;
    dialogRef.current = null;
    setDialog(null);
    if (entry?.kind === "export") entry.resolve(value as TemporaryExportOptions | null);
    if (entry?.kind === "frame") entry.resolve(value as number | null);
    if (entry?.kind === "close") entry.resolve(value as CloseChoice);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const entry = dialogRef.current;
      dialogRef.current = null;
      if (entry?.kind === "close") entry.resolve("cancel");
      else entry?.resolve(null);
      files.current = [];
    };
  }, []);
  useEffect(() => {
    if (!frame || !controller) return;
    return frame.state.subscribe((state) => {
      if (!state) return;
      const id = state.activeId;
      if (id && controller.isTemporary(id) && revisions.current.observe(id, state))
        redraw((value) => value + 1);
    });
  }, [controller, frame]);
  useEffect(
    () =>
      frame?.onFilesDropped?.(
        (dropped) =>
          importRef.current(
            dropped.map((item) => new File([Uint8Array.from(item.bytes).buffer], item.name)),
          ),
        (text) => setMessage(text),
      ),
    [frame],
  );
  useEffect(() => {
    if (!controller) return;
    return controller.bindTemporaryActions({
      save: (identity) => operations.current.exportOne(identity.viewId),
      close: () => operations.current.closeAll(),
    });
  }, [controller]);

  const importFiles = (incoming: readonly File[]) => {
    if (!incoming.length) return;
    const available =
      16 - (current.current.controller?.temporaryDocuments().length ?? 0) - files.current.length;
    if (incoming.length > available) {
      setMessage("最多同时打开16张临时图片，请先关闭部分图片。");
      return;
    }
    files.current.push(...incoming);
    current.current.ensureStarted();
    queueChanged((value) => value + 1);
  };
  importRef.current = importFiles;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Appending to the mutable import queue explicitly wakes the drain.
  useEffect(() => {
    if (!controller || !frame || busyRef.current || !files.current.length) return;
    const selectedController = controller;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    void (async () => {
      const errors: string[] = [];
      while (
        alive.current &&
        current.current.controller === selectedController &&
        files.current.length
      ) {
        const file = files.current.shift()!;
        try {
          const editing = frame.state.snapshot();
          if (editing?.pending || editing?.locked) throw new Error("请先完成当前图片操作再导入。");
          if (!file.size || file.size > 50 * 1024 ** 2) throw new Error("图片为空或超过50 MiB。");
          const api = window.patentApi.imageEditor;
          if (!api) throw new Error("当前实例尚未加载新的导入接口，请保存后重新启动实例。");
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53) {
            if (!api.decodePsd) throw new Error("当前实例尚未加载PSD接口，请保存后重新启动。");
            const project = await api.decodePsd({ bytes });
            if (!project.ok) throw project.error;
            if (!alive.current || current.current.controller !== selectedController) break;
            await selectedController.addTemporaryProject(file.name.slice(0, 200) || "image.psd", {
              metadata: project.value.metadata,
              psd: project.value.psd,
              backings: project.value.backings,
            });
            continue;
          }
          let decoded = await api.decodeRaster({ bytes });
          if (!decoded.ok) throw decoded.error;
          if (decoded.value.pageCount > 1) {
            const count = decoded.value.pageCount;
            const page = await new Promise<number | null>((resolve) =>
              present({ kind: "frame", name: file.name, count, resolve }),
            );
            if (page === null) continue;
            if (page !== 0) decoded = await api.decodeRaster({ bytes, page });
            if (!decoded.ok) throw decoded.error;
          }
          if (!alive.current || current.current.controller !== selectedController) break;
          await selectedController.addTemporaryRaster(file.name.slice(0, 200) || "image", {
            ...decoded.value,
            initialLayerKind: "regular",
          });
        } catch (error) {
          errors.push(`${file.name}：${errorText(error)}`);
        }
      }
      if (alive.current)
        setMessage(
          errors.length
            ? errors.join("；")
            : "已作为临时图片打开，不会自动保存到专利。请通过导出保留修改。",
        );
    })().finally(() => {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        queueChanged((value) => value + 1);
      }
    });
  }, [controller, frame, queueVersion, present]);

  const exportOne = async (id: string): Promise<boolean> => {
    if (busyRef.current) {
      setMessage("正在处理图片，请完成当前操作后重试。");
      return false;
    }
    const { controller: owner, frame: editor } = current.current;
    const api = window.patentApi.imageEditor;
    if (!owner || !editor || !api) {
      setMessage("当前实例尚未加载导出接口，请保存后重新启动实例。");
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (!(await owner.activate(id))) return false;
      const state = editor.state.snapshot(),
        identity = owner.identity(id);
      const name = owner.temporaryDocuments().find((item) => item.viewId === id)?.name ?? "image";
      if (!identity || !state?.size || state.pending || state.locked)
        throw new Error("请先完成当前编辑操作再导出。");
      const options = await new Promise<TemporaryExportOptions | null>((resolve) =>
        present({
          kind: "export",
          name,
          size: state.size!,
          layered: state.layers.length > 1,
          resolve,
        }),
      );
      if (!options || !alive.current || current.current.controller !== owner) return false;
      const revision = revisions.current.revision(id);
      const result =
        options.format === "psd"
          ? await exportKlecksTemporaryPsd(identity, name, editor.projects, api, options.density)
          : await exportKlecksTemporaryRaster(
              identity,
              name,
              { ...options, format: options.format },
              editor.projects,
              api,
            );
      if (!result) return false;
      revisions.current.exported(id, revision, options.format === "psd" ? "psd" : "raster");
      redraw((value) => value + 1);
      setMessage(
        `已导出：${result.outputPath}。${options.format === "psd" ? "PSD保留基础栅格图层，不包含操作历史和选区。" : "平面图片不保留图层。"}`,
      );
      return true;
    } catch (error) {
      if (alive.current) setMessage(errorText(error));
      return false;
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        queueChanged((value) => value + 1);
      }
    }
  };
  const decideClose = (count: number) =>
    new Promise<CloseChoice>((resolve) => present({ kind: "close", count, resolve }));
  const exportSet = async (ids: readonly string[]): Promise<boolean> => {
    if (busyRef.current || !ids.length) return false;
    const { controller: owner, frame: editor } = current.current,
      api = window.patentApi.imageEditor;
    if (!owner || !editor || !api?.beginBatch) {
      setMessage("当前实例尚未加载批量导出接口，请保存后重新启动。");
      return false;
    }
    const selected = owner.temporaryDocuments().filter((item) => ids.includes(item.viewId));
    if (!selected.length) return false;
    const originalId = editor.state.snapshot()?.activeId;
    busyRef.current = true;
    setBusy(true);
    setBatchActive(true);
    batchCancel.current = false;
    setBatchCancelRequested(false);
    let token: string | null = null,
      completed = 0,
      succeeded = false;
    const errors: string[] = [];
    try {
      if (!(await owner.activate(selected[0]!.viewId))) return false;
      const state = editor.state.snapshot();
      if (!state?.size || state.pending || state.locked)
        throw new Error("请先完成当前图片操作再导出。");
      const basis = { ...state.size };
      setMessage("选择批量导出格式和保存目录…");
      const options = await new Promise<TemporaryExportOptions | null>((resolve) =>
        present({
          kind: "export",
          batch: true,
          layered: selected.some((item) => revisions.current.isLayered(item.viewId)),
          name: `${selected.length} 张临时图片`,
          size: basis,
          resolve,
        }),
      );
      if (!options || batchCancel.current) return false;
      const begun = await api.beginBatch({
        items: selected.map((item) => ({
          id: item.viewId,
          name: item.name,
          format: options.format,
        })),
      });
      if (!begun.ok) throw begun.error;
      if (!begun.value) return false;
      const batchToken = begun.value.token;
      token = batchToken;
      for (const [index, item] of selected.entries()) {
        if (batchCancel.current || !alive.current || current.current.controller !== owner) break;
        setMessage(`正在导出 ${index + 1}/${selected.length}：${item.name}`);
        try {
          if (!(await owner.activate(item.viewId))) throw new Error("图片已关闭或编辑会话已改变。");
          const snapshot = editor.state.snapshot(),
            identity = owner.identity(item.viewId);
          if (!identity || !snapshot?.size || snapshot.pending || snapshot.locked)
            throw new Error("图片操作尚未完成。");
          const revision = revisions.current.revision(item.viewId);
          const result =
            options.format === "psd"
              ? await exportKlecksTemporaryPsd(
                  identity,
                  item.name,
                  editor.projects,
                  {
                    exportPsd: (request) =>
                      batchCancel.current
                        ? Promise.resolve({ ok: true, value: null })
                        : api.writeBatchPsd({
                            token: batchToken,
                            id: item.viewId,
                            project: request.project,
                            composite: request.composite,
                            density: request.density,
                          }),
                  },
                  options.density,
                )
              : await exportKlecksTemporaryRaster(
                  identity,
                  item.name,
                  {
                    ...options,
                    format: options.format,
                    width: Math.max(
                      1,
                      Math.round(
                        (snapshot.size.width * (options.width ?? basis.width)) / basis.width,
                      ),
                    ),
                    height: Math.max(
                      1,
                      Math.round(
                        (snapshot.size.height * (options.width ?? basis.width)) / basis.width,
                      ),
                    ),
                  },
                  editor.projects,
                  {
                    exportRaster: (request) =>
                      batchCancel.current
                        ? Promise.resolve({ ok: true, value: null })
                        : api.writeBatchRaster({
                            token: batchToken,
                            id: item.viewId,
                            bytes: request.bytes,
                            options: request.options,
                          }),
                  },
                );
          if (!result) break;
          completed++;
          revisions.current.exported(
            item.viewId,
            revision,
            options.format === "psd" ? "psd" : "raster",
          );
          redraw((value) => value + 1);
        } catch (error) {
          errors.push(`${item.name}：${errorText(error)}`);
        }
      }
      succeeded = completed === selected.length && !errors.length;
    } catch (error) {
      errors.push(errorText(error));
    } finally {
      if (token) {
        try {
          const ended = await api.finishBatch({ token });
          if (!ended.ok) errors.push(errorText(ended.error));
        } catch (error) {
          errors.push(errorText(error));
        }
      }
      if (originalId && alive.current && current.current.controller === owner)
        await owner.activate(originalId).catch(() => false);
      if (alive.current) {
        setMessage(
          `批量导出${batchCancel.current ? "已停止" : "结束"}：已完成 ${completed}/${selected.length} 张。${errors.length ? `未完成：${errors.join("；")}` : completed < selected.length ? "其余图片仍保留在编辑器中。" : "平面格式不保留图层。"}`,
        );
        setBusy(false);
        setBatchActive(false);
        queueChanged((value) => value + 1);
      }
      busyRef.current = false;
    }
    return succeeded && !errors.length;
  };
  const hasPendingTemporaryEdit = () => {
    const state = current.current.frame?.state.snapshot();
    if (
      state?.activeId &&
      current.current.controller?.isTemporary(state.activeId) &&
      (state.pending || state.locked)
    ) {
      setMessage("请先完成或取消当前图片操作，再关闭临时图片。");
      return true;
    }
    return false;
  };
  const closeOne = async (id: string) => {
    const owner = current.current.controller;
    if (!owner?.isTemporary(id) || busyRef.current) return;
    if (hasPendingTemporaryEdit()) return;
    if (revisions.current.needsExport(id)) {
      const choice = await decideClose(1);
      if (choice === "cancel") return;
      if (choice === "export" && (!(await exportOne(id)) || revisions.current.needsExport(id)))
        return;
    }
    try {
      await owner.removeTemporary(id);
      revisions.current.remove(id);
      redraw((value) => value + 1);
    } catch (error) {
      setMessage(errorText(error));
    }
  };
  const closeAll = async (): Promise<boolean> => {
    if (busyRef.current || files.current.length || dialogRef.current) {
      setMessage("请先完成或取消当前图片处理。");
      return false;
    }
    if (hasPendingTemporaryEdit()) return false;
    const owner = current.current.controller;
    const dirty =
      owner?.temporaryDocuments().filter((item) => revisions.current.needsExport(item.viewId)) ??
      [];
    if (!dirty.length) return true;
    const choice = await decideClose(dirty.length);
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    if (dirty.length > 1)
      return (
        (await exportSet(dirty.map((item) => item.viewId))) &&
        dirty.every((item) => !revisions.current.needsExport(item.viewId))
      );
    for (const item of dirty)
      if (!(await exportOne(item.viewId)) || revisions.current.needsExport(item.viewId))
        return false;
    return true;
  };
  operations.current = { exportOne, closeAll };
  return {
    busy,
    batchActive,
    batchCancelRequested,
    cancelBatch: () => {
      batchCancel.current = true;
      setBatchCancelRequested(true);
    },
    message,
    importFiles,
    exportOne,
    closeOne,
    chooseImport: () => input.current?.click(),
    exportAll: async () => {
      await exportSet(
        current.current.controller?.temporaryDocuments().map((item) => item.viewId) ?? [],
      );
    },
    dirty: (id: string) => revisions.current.needsExport(id),
    dialogs: (
      <>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".png,.jpg,.jpeg,.webp,.avif,.tif,.tiff,.bmp,.gif,.svg,.psd"
          onChange={(event) => {
            importFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        {dialog
          ? createPortal(
              dialog.kind === "export" ? (
                <TemporaryExportDialog
                  name={dialog.name}
                  size={dialog.size}
                  layered={dialog.layered}
                  batch={dialog.batch ?? false}
                  onFinish={finish}
                />
              ) : dialog.kind === "frame" ? (
                <TemporaryFrameDialog count={dialog.count} name={dialog.name} onFinish={finish} />
              ) : (
                <CorrectionUnsavedDialog
                  presentation={{
                    title: "临时图片尚未导出",
                    description: `${dialog.count} 张临时图片有尚未保留的修改。它们不会自动保存到专利；平面导出不会保留多图层。`,
                    stay: "取消",
                    discard: "放弃并关闭",
                    apply: "导出后关闭",
                  }}
                  onStay={() => finish("cancel")}
                  onDiscard={() => finish("discard")}
                  onApply={() => finish("export")}
                />
              ),
              document.body,
            )
          : null}
      </>
    ),
  };
}
