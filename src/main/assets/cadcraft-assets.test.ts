import { prepareCadAssets } from "./cadcraft-assets.js";
import type { runCadCodec } from "./cadcraft-runtime.js";

test.each([
  ["dwg", 50],
  ["dxf", 100],
] as const)("rejects new %s imports above %s MiB before parsing", async (format, limitMiB) => {
  let called = false;
  const run: typeof runCadCodec = async () => {
    called = true;
    throw new Error("Parser must not start");
  };
  await expect(
    prepareCadAssets(
      "runtime",
      {
        sessionId: "test",
        operationId: crypto.randomUUID(),
        originalName: `large.${format}`,
        format,
        bytes: new Uint8Array(limitMiB * 1024 * 1024 + 1),
      },
      undefined,
      run,
    ),
  ).rejects.toMatchObject({
    code: "CAD_IMPORT_TOO_LARGE",
    message: expect.stringContaining(`${format.toUpperCase()} ${limitMiB} MiB`),
  });
  expect(called).toBe(false);
});

test.each([
  ["dwg", 50, false],
  ["dxf", 100, false],
  ["dxf", 60, true],
] as const)("allows %s at %s MiB (existing=%s)", async (format, sizeMiB, existing) => {
  const bytes = new Uint8Array(sizeMiB * 1024 * 1024);
  const run: typeof runCadCodec = async (_root, operation) =>
    new TextEncoder().encode(
      operation === "dxf-to-scene"
        ? JSON.stringify({ entityCount: 0, svgFrame: { origin: [0, 10], width: 10, height: 10 } })
        : '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );
  const result = await prepareCadAssets(
    "runtime",
    {
      sessionId: "test",
      operationId: crypto.randomUUID(),
      originalName: `drawing.${format}`,
      format,
      bytes,
      ...(existing
        ? { frame: { mapping: { originX: 0, originY: 10, scale: 1 }, width: 10, height: 10 } }
        : {}),
    },
    undefined,
    run,
  );
  expect(result.assets[0]?.original).toBe(bytes);
});

test("blank CAD uses engineering units and can grow beyond a 100-unit line", async () => {
  let count = 0;
  const run: typeof runCadCodec = async (_root, operation) => {
    if (operation === "dxf-to-scene")
      return new TextEncoder().encode(
        JSON.stringify({
          entityCount: count,
          svgFrame: count
            ? { origin: [-2, 2], width: 104, height: 4.000000001 }
            : { origin: [0, 1], width: 1.04, height: 1.04 },
        }),
      );
    return new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path d="M0 0L10 10" stroke="black"/></svg>',
    );
  };
  const request = {
    sessionId: "test",
    operationId: crypto.randomUUID(),
    originalName: "new.dxf",
    format: "dxf" as const,
    bytes: new Uint8Array([1]),
  };
  const blank = await prepareCadAssets("runtime", request, undefined, run);
  expect(blank.cad.mapping.scale).toBe(2);
  count = 1;
  const edited = await prepareCadAssets(
    "runtime",
    { ...request, frame: { mapping: blank.cad.mapping, width: blank.width, height: blank.height } },
    undefined,
    run,
  );
  expect(edited.width).toBe(2004);
  expect(edited.cad.mapping.originX).toBe(-2);
  expect(edited.height).toBeLessThan(2100);
});

test("CAD checkpoint uses fixed frame and retains original DWG separately", async () => {
  const bytes = Uint8Array.from([65, 67, 49, 48]);
  const dxf = new TextEncoder().encode("DXF");
  const calls: { operation: string; args?: string[] }[] = [];
  const run: typeof runCadCodec = async (_root, operation, _bytes, options) => {
    calls.push({ operation, ...(options?.args ? { args: options.args } : {}) });
    if (operation === "dwg-to-dxf") return dxf;
    if (operation === "dxf-to-scene")
      return new TextEncoder().encode(
        JSON.stringify({ svgFrame: { origin: [-10, 200], width: 480, height: 200 } }),
      );
    return new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="640" viewBox="0 0 500 200"><rect width="100%" height="100%" fill="white"/><path d="M0 0L200 200" stroke="black"/></svg>',
    );
  };
  const frame = { mapping: { originX: -20, originY: 300, scale: 2 }, width: 1000, height: 600 };
  const result = await prepareCadAssets(
    "runtime",
    {
      sessionId: "test",
      operationId: crypto.randomUUID(),
      format: "dwg",
      originalName: "原图.dwg",
      bytes,
      frame,
    },
    undefined,
    run,
  );
  expect(result.assets).toHaveLength(3);
  expect(result.assets[0]!.original).toBe(bytes);
  expect(result.assets[1]!.original).toBe(dxf);
  expect(result.cad.mapping).toEqual(frame.mapping);
  expect(result.cad.assetId).toBe(result.assets[1]!.descriptor.assetId);
  expect(calls.at(-1)).toEqual({
    operation: "dxf-to-svg",
    args: ["--patent-preview", "--frame", "-20", "300", "500", "300"],
  });
  expect(result.assets[2]!.descriptor.widthPx).toBe(1000);
});

test("preserved checkpoints do not expand either origin or dimensions when geometry leaves the frame", async () => {
  const frame = { mapping: { originX: 0, originY: 100, scale: 2 }, width: 200, height: 200 };
  let svgArgs: string[] | undefined;
  const run: typeof runCadCodec = async (_root, operation, _bytes, options) => {
    if (operation === "dxf-to-scene")
      throw new Error("Fixed-frame save must not build an unused scene");
    svgArgs = options?.args;
    return new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M-50 -200L450 400" stroke="black"/></svg>',
    );
  };
  const native = new Uint8Array([1, 2, 3]);
  const result = await prepareCadAssets(
    "runtime",
    {
      sessionId: "test",
      operationId: crypto.randomUUID(),
      originalName: "existing.dxf",
      format: "dxf",
      bytes: native,
      frame,
      preserveFrame: true,
    },
    undefined,
    run,
  );
  expect(result.cad.mapping).toEqual(frame.mapping);
  expect([result.width, result.height]).toEqual([200, 200]);
  expect(svgArgs).toEqual(["--patent-preview", "--frame", "0", "100", "100", "100"]);
  expect(result.assets[0]!.original).toBe(native);
  expect(new TextDecoder().decode(result.assets.at(-1)!.original)).toContain("M-50 -200L450 400");
});

test("fixed-frame saves still reject invalid drawing data from the native parser", async () => {
  const failure = new Error("Invalid DXF");
  const run: typeof runCadCodec = async () => {
    throw failure;
  };
  await expect(
    prepareCadAssets(
      "runtime",
      {
        sessionId: "test",
        operationId: crypto.randomUUID(),
        originalName: "invalid.dxf",
        format: "dxf",
        bytes: new Uint8Array([1]),
        preserveFrame: true,
        frame: { mapping: { originX: 0, originY: 100, scale: 2 }, width: 200, height: 200 },
      },
      undefined,
      run,
    ),
  ).rejects.toBe(failure);
});
