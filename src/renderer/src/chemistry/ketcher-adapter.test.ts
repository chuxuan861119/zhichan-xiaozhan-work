import { describe, expect, test, vi } from "vitest";
import { MAX_KET_SOURCE_BYTES } from "../../../shared/document/model";
import { createKetcherAdapter, EMPTY_STRUCTURE, type KetcherPublicApi } from "./ketcher-adapter";

const benzeneKet = '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule"}}';

function createKetcher(overrides: Partial<KetcherPublicApi> = {}): KetcherPublicApi {
  return {
    setMolecule: vi.fn().mockResolvedValue(undefined),
    getKet: vi.fn().mockResolvedValue(benzeneKet),
    generateImage: vi.fn().mockResolvedValue({ text: vi.fn().mockResolvedValue("<svg />") }),
    switchToMacromoleculesMode: vi.fn(),
    switchToMoleculesMode: vi.fn(),
    structService: { destroy: vi.fn() },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Ketcher adapter", () => {
  test.each(["load", "ket", "image", "blob"])(
    "bounds a stalled %s operation and ignores late results",
    async (stage) => {
      vi.useFakeTimers();
      try {
        const stalled = deferred<never>();
        const ketcher = createKetcher({
          ...(stage === "load" ? { setMolecule: vi.fn().mockReturnValue(stalled.promise) } : {}),
          ...(stage === "ket" ? { getKet: vi.fn().mockReturnValue(stalled.promise) } : {}),
          ...(stage === "image" ? { generateImage: vi.fn().mockReturnValue(stalled.promise) } : {}),
          ...(stage === "blob"
            ? { generateImage: vi.fn().mockResolvedValue({ text: () => stalled.promise }) }
            : {}),
        });
        const adapter = createKetcherAdapter(ketcher);
        const operation = stage === "load" ? adapter.loadKet(benzeneKet) : adapter.readDraft();
        let result: unknown;
        void operation.then((value) => {
          result = value;
        });
        await vi.advanceTimersByTimeAsync(30_001);
        expect(result).toEqual({ ok: false, error: { code: "KETCHER_TIMEOUT" } });
        stalled.resolve(benzeneKet as never);
        await Promise.resolve();
        expect(result).toEqual({ ok: false, error: { code: "KETCHER_TIMEOUT" } });
        expect(ketcher.structService.destroy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  test("restores a non-empty KET through Ketcher's public setMolecule API", async () => {
    const ketcher = createKetcher();
    const adapter = createKetcherAdapter(ketcher);

    await expect(adapter.loadKet(benzeneKet)).resolves.toEqual({ ok: true });
    expect(ketcher.setMolecule).toHaveBeenCalledWith(benzeneKet);
  });

  test("switches between molecule and macromolecule modes through Ketcher's public APIs", () => {
    const ketcher = createKetcher();
    const adapter = createKetcherAdapter(ketcher);

    expect(adapter.setMode("macromolecule")).toEqual({ ok: true, value: undefined });
    expect(adapter.setMode("molecule")).toEqual({ ok: true, value: undefined });
    expect(ketcher.switchToMacromoleculesMode).toHaveBeenCalledOnce();
    expect(ketcher.switchToMoleculesMode).toHaveBeenCalledOnce();
  });

  test("reads Ketcher's canonical KET and SVG through public APIs", async () => {
    const ketcher = createKetcher();
    const adapter = createKetcherAdapter(ketcher);

    await expect(adapter.readDraft()).resolves.toEqual({
      ok: true,
      value: { ket: benzeneKet, svg: "<svg />", editorMode: "molecule" },
    });
    expect(ketcher.generateImage).toHaveBeenCalledWith(benzeneKet, { outputFormat: "svg" });
  });

  test("reports a blank Ketcher canvas with the stable EMPTY_STRUCTURE code", async () => {
    const ketcher = createKetcher({ getKet: vi.fn().mockResolvedValue('{"root":{"nodes":[]}}') });
    const adapter = createKetcherAdapter(ketcher);

    await expect(adapter.readDraft()).resolves.toEqual({
      ok: false,
      error: { code: EMPTY_STRUCTURE },
    });
    expect(ketcher.generateImage).not.toHaveBeenCalled();
  });

  test("rejects empty and oversized KET input with stable validation codes", async () => {
    const adapter = createKetcherAdapter(createKetcher());

    await expect(adapter.loadKet(" \n")).resolves.toEqual({
      ok: false,
      error: { code: EMPTY_STRUCTURE },
    });
    await expect(adapter.loadKet("x".repeat(MAX_KET_SOURCE_BYTES + 1))).resolves.toEqual({
      ok: false,
      error: { code: "KET_TOO_LARGE" },
    });
  });

  test("maps a Ketcher exception to a stable load error code", async () => {
    const adapter = createKetcherAdapter(
      createKetcher({ setMolecule: vi.fn().mockRejectedValue(new Error("bad KET")) }),
    );

    await expect(adapter.loadKet(benzeneKet)).resolves.toEqual({
      ok: false,
      error: { code: "KETCHER_LOAD_FAILED" },
    });
  });

  test.each([
    ["getKet", createKetcher({ getKet: vi.fn().mockRejectedValue(new Error("get failed")) })],
    [
      "generateImage",
      createKetcher({ generateImage: vi.fn().mockRejectedValue(new Error("image failed")) }),
    ],
    [
      "Blob.text",
      createKetcher({
        generateImage: vi
          .fn()
          .mockResolvedValue({ text: vi.fn().mockRejectedValue(new Error("text failed")) }),
      }),
    ],
  ])("maps a %s failure to KETCHER_READ_FAILED", async (_operation, ketcher) => {
    const adapter = createKetcherAdapter(ketcher);

    await expect(adapter.readDraft()).resolves.toEqual({
      ok: false,
      error: { code: "KETCHER_READ_FAILED" },
    });
  });

  test("returns KETCHER_DISPOSED when loadKet finishes after disposal", async () => {
    const pending = deferred<void>();
    const adapter = createKetcherAdapter(
      createKetcher({ setMolecule: vi.fn().mockReturnValue(pending.promise) }),
    );
    const result = adapter.loadKet(benzeneKet);

    adapter.dispose();
    pending.resolve(undefined);

    await expect(result).resolves.toEqual({ ok: false, error: { code: "KETCHER_DISPOSED" } });
  });

  test("returns KETCHER_DISPOSED after getKet resolves on a disposed adapter", async () => {
    const getKet = deferred<string>();
    const adapter = createKetcherAdapter(
      createKetcher({ getKet: vi.fn().mockReturnValue(getKet.promise) }),
    );
    const result = adapter.readDraft();

    adapter.dispose();
    getKet.resolve(benzeneKet);

    await expect(result).resolves.toEqual({ ok: false, error: { code: "KETCHER_DISPOSED" } });
  });

  test("returns KETCHER_DISPOSED after generateImage resolves on a disposed adapter", async () => {
    const generateImage = deferred<{ text(): Promise<string> }>();
    const adapter = createKetcherAdapter(
      createKetcher({ generateImage: vi.fn().mockReturnValue(generateImage.promise) }),
    );
    const result = adapter.readDraft();

    await Promise.resolve();
    adapter.dispose();
    generateImage.resolve({ text: () => Promise.resolve("<svg />") });

    await expect(result).resolves.toEqual({ ok: false, error: { code: "KETCHER_DISPOSED" } });
  });

  test("returns KETCHER_DISPOSED after Blob.text resolves on a disposed adapter", async () => {
    const imageText = deferred<string>();
    const adapter = createKetcherAdapter(
      createKetcher({
        generateImage: vi.fn().mockResolvedValue({ text: () => imageText.promise }),
      }),
    );
    const result = adapter.readDraft();

    await Promise.resolve();
    adapter.dispose();
    imageText.resolve("<svg />");

    await expect(result).resolves.toEqual({ ok: false, error: { code: "KETCHER_DISPOSED" } });
  });

  test("releases the standalone structure service when disposed", () => {
    const ketcher = createKetcher();
    const adapter = createKetcherAdapter(ketcher);

    adapter.dispose();

    expect(ketcher.structService.destroy).toHaveBeenCalledOnce();
  });
});
