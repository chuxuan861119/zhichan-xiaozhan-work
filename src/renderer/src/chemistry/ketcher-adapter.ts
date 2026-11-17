import type { Ketcher } from "ketcher-core";
import { MAX_KET_SOURCE_BYTES } from "../../../shared/document/model";
import { StructureTimeoutError, withStructureTimeout } from "./structure-timeout";

const textEncoder = new TextEncoder();

export const EMPTY_STRUCTURE = "EMPTY_STRUCTURE";
export type ChemicalEditorMode = "molecule" | "macromolecule";

export type KetcherAdapterErrorCode =
  | typeof EMPTY_STRUCTURE
  | "KET_TOO_LARGE"
  | "KETCHER_DISPOSED"
  | "KETCHER_LOAD_FAILED"
  | "KETCHER_TIMEOUT"
  | "KETCHER_READ_FAILED";

export type KetcherAdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: KetcherAdapterErrorCode } };

export type KetcherPublicApi = Pick<
  Ketcher,
  | "setMolecule"
  | "getKet"
  | "generateImage"
  | "switchToMacromoleculesMode"
  | "switchToMoleculesMode"
> & {
  structService: Pick<Ketcher["structService"], "destroy">;
};

export type KetcherDraft = { ket: string; svg: string; editorMode: ChemicalEditorMode };

function failure<T>(code: KetcherAdapterErrorCode): KetcherAdapterResult<T> {
  return { ok: false, error: { code } };
}

function ketByteLength(ket: string): number {
  return textEncoder.encode(ket).byteLength;
}

function isEmptyKet(ket: string): boolean {
  if (!ket.trim()) return true;
  try {
    const parsed: unknown = JSON.parse(ket);
    if (typeof parsed !== "object" || parsed === null || !("root" in parsed)) return false;
    const root = parsed.root;
    return (
      typeof root === "object" &&
      root !== null &&
      "nodes" in root &&
      Array.isArray(root.nodes) &&
      root.nodes.length === 0
    );
  } catch {
    return false;
  }
}

export function createKetcherAdapter(ketcher: KetcherPublicApi) {
  let disposed = false;
  let editorMode: ChemicalEditorMode = "molecule";

  return {
    setMode(mode: ChemicalEditorMode): KetcherAdapterResult<void> {
      if (disposed) return failure("KETCHER_DISPOSED");
      try {
        if (mode === "macromolecule") ketcher.switchToMacromoleculesMode();
        else ketcher.switchToMoleculesMode();
        editorMode = mode;
        return { ok: true, value: undefined };
      } catch {
        return failure("KETCHER_LOAD_FAILED");
      }
    },

    async loadKet(
      ket: string,
      mode: ChemicalEditorMode = "molecule",
    ): Promise<KetcherAdapterResult<void>> {
      if (disposed) return failure("KETCHER_DISPOSED");
      if (isEmptyKet(ket)) return failure(EMPTY_STRUCTURE);
      if (ketByteLength(ket) > MAX_KET_SOURCE_BYTES) return failure("KET_TOO_LARGE");
      try {
        const modeResult = this.setMode(mode);
        if (!modeResult.ok) return modeResult;
        await withStructureTimeout(ketcher.setMolecule(ket));
        if (disposed) return failure("KETCHER_DISPOSED");
        return { ok: true, value: undefined };
      } catch (error) {
        return failure(
          disposed
            ? "KETCHER_DISPOSED"
            : error instanceof StructureTimeoutError
              ? "KETCHER_TIMEOUT"
              : "KETCHER_LOAD_FAILED",
        );
      }
    },

    async readDraft(): Promise<KetcherAdapterResult<KetcherDraft>> {
      if (disposed) return failure("KETCHER_DISPOSED");
      try {
        const ket = await withStructureTimeout(ketcher.getKet());
        if (disposed) return failure("KETCHER_DISPOSED");
        if (isEmptyKet(ket)) return failure(EMPTY_STRUCTURE);
        if (ketByteLength(ket) > MAX_KET_SOURCE_BYTES) return failure("KET_TOO_LARGE");
        const image = await withStructureTimeout(
          ketcher.generateImage(ket, { outputFormat: "svg" }),
        );
        if (disposed) return failure("KETCHER_DISPOSED");
        const svg = await withStructureTimeout(image.text());
        if (disposed) return failure("KETCHER_DISPOSED");
        if (!svg.trim()) return failure("KETCHER_READ_FAILED");
        return { ok: true, value: { ket, svg, editorMode } };
      } catch (error) {
        return failure(
          disposed
            ? "KETCHER_DISPOSED"
            : error instanceof StructureTimeoutError
              ? "KETCHER_TIMEOUT"
              : "KETCHER_READ_FAILED",
        );
      }
    },

    async readContent(): Promise<KetcherAdapterResult<{ ket: string; hasContent: boolean }>> {
      if (disposed) return failure("KETCHER_DISPOSED");
      try {
        const ket = await withStructureTimeout(ketcher.getKet());
        if (disposed) return failure("KETCHER_DISPOSED");
        if (ketByteLength(ket) > MAX_KET_SOURCE_BYTES) return failure("KET_TOO_LARGE");
        return { ok: true, value: { ket, hasContent: !isEmptyKet(ket) } };
      } catch (error) {
        return failure(
          disposed
            ? "KETCHER_DISPOSED"
            : error instanceof StructureTimeoutError
              ? "KETCHER_TIMEOUT"
              : "KETCHER_READ_FAILED",
        );
      }
    },

    dispose(options: { destroyService?: boolean } = {}): void {
      if (disposed) return;
      disposed = true;
      if (options.destroyService !== false) ketcher.structService.destroy?.();
    },
  };
}

export type KetcherAdapter = ReturnType<typeof createKetcherAdapter>;
