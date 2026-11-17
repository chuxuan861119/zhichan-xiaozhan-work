import { tmpdir } from "node:os";
import { join } from "node:path";

const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => unknown | Promise<unknown>
  >();
  return {
    handlers,
    getPrintersAsync: vi.fn(),
    clipboardReadText: vi.fn(),
    clipboardWriteText: vi.fn(),
    callArkTSFunction: vi.fn(),
    paste: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(
      async (): Promise<{ canceled: boolean; filePath: string | undefined }> => ({
        canceled: true,
        filePath: undefined,
      }),
    ),
    writeShortcutLink: vi.fn(() => true),
  };
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const testDataDirectory = join(tmpdir(), "patent-workbench-printing-ipc-test");

vi.mock("electron", () => ({
  app: { getPath: () => testDataDirectory },
  systemPreferences: { callArkTSFunction: electron.callArkTSFunction },
  BrowserWindow: class {},
  dialog: {
    showOpenDialog: electron.showOpenDialog,
    showSaveDialog: electron.showSaveDialog,
  },
  ipcMain: {
    removeHandler: (channel: string) => electron.handlers.delete(channel),
    handle: (
      channel: string,
      handler: (event: unknown, input?: unknown) => unknown | Promise<unknown>,
    ) => electron.handlers.set(channel, handler),
  },
  nativeImage: {
    createFromBitmap: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
  },
  clipboard: {
    readText: electron.clipboardReadText,
    writeText: electron.clipboardWriteText,
  },
  shell: {
    openExternal: electron.openExternal,
    writeShortcutLink: electron.writeShortcutLink,
  },
}));

import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import { registerIpcHandlers } from "./register-ipc.js";

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

async function invoke(channel: string, input?: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  expect(handler, `missing IPC handler: ${channel}`).toBeTypeOf("function");
  return handler?.(
    {
      sender: {
        getPrintersAsync: electron.getPrintersAsync,
        paste: electron.paste,
        isDestroyed: () => false,
      },
    },
    input,
  );
}

afterEach(() => {
  electron.handlers.clear();
  electron.getPrintersAsync.mockReset();
  electron.clipboardReadText.mockReset();
  electron.clipboardWriteText.mockReset();
  electron.callArkTSFunction.mockReset();
  electron.paste.mockReset();
  electron.openExternal.mockReset().mockResolvedValue(undefined);
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

test.each(["openharmony", "ohos"])("%s rejects Agent CLI activation", async (platform) => {
  setPlatform(platform);
  registerIpcHandlers();
  await expect(invoke(IPC_CHANNELS.automationControl, { action: "enable" })).resolves.toMatchObject(
    {
      ok: false,
      error: { code: "INVALID_INPUT", message: "鸿蒙版暂未开放 Agent CLI。" },
    },
  );
});

test("Harmony clipboard denial leaves the clipboard unread and a fresh permission request can recover", async () => {
  setPlatform("openharmony");
  electron.callArkTSFunction.mockImplementation((_name, _type, args: unknown[]) => {
    (args[1] as (code: number) => void)(1);
  });
  electron.clipboardReadText.mockReturnValue("synthetic test text");
  registerIpcHandlers();
  await expect(invoke(IPC_CHANNELS.clipboardReadText)).resolves.toMatchObject({
    ok: false,
    error: { code: "CLIPBOARD_PERMISSION_DENIED" },
  });
  expect(electron.clipboardReadText).not.toHaveBeenCalled();
  await expect(invoke(IPC_CHANNELS.clipboardPaste)).resolves.toMatchObject({
    ok: false,
    error: { code: "CLIPBOARD_PERMISSION_DENIED" },
  });
  expect(electron.paste).not.toHaveBeenCalled();
  electron.callArkTSFunction.mockImplementation((_name, _type, args: unknown[]) => {
    (args[1] as (code: number) => void)(0);
  });
  await expect(invoke(IPC_CHANNELS.clipboardReadText)).resolves.toEqual({
    ok: true,
    value: "synthetic test text",
  });
  await expect(invoke(IPC_CHANNELS.clipboardPaste)).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(electron.paste).toHaveBeenCalledOnce();
  expect(electron.callArkTSFunction).toHaveBeenCalledTimes(4);
});

test("lists only sanitized printer descriptors from the invoking web contents", async () => {
  electron.getPrintersAsync.mockResolvedValue([
    {
      name: "z-printer",
      displayName: "Zebra",
      description: "Office queue",
      options: { rawDriverField: "hidden" },
    },
    {
      name: "",
      displayName: "Missing name",
      description: "ignored",
      options: { rawDriverField: "hidden" },
    },
  ]);
  registerIpcHandlers();

  await expect(invoke(IPC_CHANNELS.exportsListPrinters)).resolves.toEqual({
    ok: true,
    value: [
      {
        deviceName: "z-printer",
        displayName: "Zebra",
        description: "Office queue",
        duplex: "unknown",
        color: "unknown",
        paperSize: "unknown",
      },
    ],
  });
});

test("exposes only bounded text access to Electron's native clipboard", async () => {
  electron.clipboardReadText.mockReturnValue("clipboard molfile");
  registerIpcHandlers();

  await expect(invoke(IPC_CHANNELS.clipboardReadText)).resolves.toEqual({
    ok: true,
    value: "clipboard molfile",
  });
  await expect(invoke(IPC_CHANNELS.clipboardWriteText, "copied molfile")).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(electron.clipboardWriteText).toHaveBeenCalledWith("copied molfile");
  await expect(
    invoke(IPC_CHANNELS.clipboardWriteText, " ".repeat(2 * 1024 * 1024 + 1)),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});

test("opens the fixed Windows printer settings page without accepting a renderer URI", async () => {
  setPlatform("win32");
  registerIpcHandlers();

  await expect(
    invoke(IPC_CHANNELS.exportsOpenPrinterSettings, "ms-settings:network"),
  ).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(electron.openExternal).toHaveBeenCalledWith("ms-settings:printers");
});

test("rasterizes a validated chemical preview without accepting paths or URLs", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-0000000000f1";
  await invoke(IPC_CHANNELS.documentsActivate, {
    sessionId,
    documentId: "00000000-0000-4000-8000-000000000001",
  });

  await expect(
    invoke(IPC_CHANNELS.chemistryRasterizePreview, {
      sessionId,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><circle cx="1" cy="1" r="1"/></svg>',
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      descriptor: { kind: "chemical-preview", widthPx: 8, heightPx: 8 },
      preview: expect.any(Uint8Array),
    },
  });
  await expect(
    invoke(IPC_CHANNELS.chemistryRasterizePreview, {
      sessionId,
      svg: "<svg/>",
      path: "C:\\unsafe.svg",
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  await expect(
    invoke(IPC_CHANNELS.chemistryRasterizePreview, {
      sessionId,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script/></svg>',
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "UNSAFE_KETCHER_SVG" } });
  await expect(
    invoke(IPC_CHANNELS.chemistryRasterizePreview, { sessionId, svg: "<svg/>" }),
  ).resolves.toMatchObject({ ok: false, error: { code: "CHEMICAL_PREVIEW_FAILED" } });
  await expect(
    invoke(IPC_CHANNELS.chemistryRasterizePreview, { sessionId, svg: "<svg><path></svg>" }),
  ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_KETCHER_SVG" } });
  await expect(
    invoke(IPC_CHANNELS.chemistryRasterizePreview, {
      sessionId,
      svg: " ".repeat(5 * 1024 * 1024 + 1),
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "CHEMICAL_PREVIEW_TOO_LARGE" } });
  await expect(
    invoke(IPC_CHANNELS.chemistryRasterizePreview, {
      sessionId: "00000000-0000-4000-8000-0000000000f2",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
});

test("returns a controlled failure for printer settings outside Windows", async () => {
  setPlatform("linux");
  registerIpcHandlers();

  await expect(invoke(IPC_CHANNELS.exportsOpenPrinterSettings)).resolves.toMatchObject({
    ok: false,
    error: { code: "INTERNAL" },
  });
  expect(electron.openExternal).not.toHaveBeenCalled();
});

test("reads editable structure sources only in an active resource session and supports legacy images", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-0000000000f1";
  const otherSessionId = "00000000-0000-4000-8000-0000000000f2";
  for (const id of [sessionId, otherSessionId]) {
    await invoke(IPC_CHANNELS.documentsActivate, {
      sessionId: id,
      documentId: "00000000-0000-4000-8000-000000000001",
    });
  }
  const source = {
    ketSource:
      '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule","atoms":[{"label":"No"}]}}',
    editorMode: "molecule",
  };
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0H20"/></svg>';
  const rendered = (await invoke(IPC_CHANNELS.chemistryRasterizePreview, {
    sessionId,
    svg,
    source,
  })) as { ok: true; value: { descriptor: { assetId: string } } };
  expect(rendered.ok).toBe(true);
  const assetId = rendered.value.descriptor.assetId;
  await expect(
    invoke(IPC_CHANNELS.chemistryReadStructureSource, { sessionId, assetId }),
  ).resolves.toEqual({ ok: true, value: source });
  await expect(
    invoke(IPC_CHANNELS.chemistryReadStructureSource, { sessionId: otherSessionId, assetId }),
  ).resolves.toMatchObject({ ok: false, error: { code: "CORRUPT_FILE" } });
  const legacy = (await invoke(IPC_CHANNELS.chemistryRasterizePreview, {
    sessionId,
    svg,
  })) as typeof rendered;
  await expect(
    invoke(IPC_CHANNELS.chemistryReadStructureSource, {
      sessionId,
      assetId: legacy.value.descriptor.assetId,
    }),
  ).resolves.toEqual({ ok: true, value: null });
  await expect(
    invoke(IPC_CHANNELS.chemistryReadStructureSource, {
      sessionId,
      assetId,
      path: "/private/file",
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  await invoke(IPC_CHANNELS.documentsRelease, sessionId);
  await expect(
    invoke(IPC_CHANNELS.chemistryReadStructureSource, { sessionId, assetId }),
  ).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
});
