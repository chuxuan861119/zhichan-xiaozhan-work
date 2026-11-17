import {
  AssetReferenceRequestSchema,
  IPC_CHANNELS,
  PRELOAD_EVENT_CHANNELS,
  PRELOAD_INVOKE_CHANNELS,
} from "../shared/ipc/contract.js";
import {
  installOfflinePolicy,
  isAllowedDiagramNavigationUrl,
  isAllowedPrintNavigationUrl,
  isAllowedRendererUrl,
  isDevToolsEnabled,
  shouldCancelOutboundRequest,
  shouldEnforceOfflinePolicy,
} from "./security.js";

describe("renderer URL policy", () => {
  test("allows only local application files in packaged mode", () => {
    expect(isAllowedRendererUrl("file:///app/index.html", true)).toBe(true);
    expect(isAllowedRendererUrl("https://example.com", true)).toBe(false);
  });

  test("allows the local Vite development server on an available port", () => {
    expect(isAllowedRendererUrl("http://localhost:5173", false)).toBe(true);
    expect(isAllowedRendererUrl("http://localhost:5174", false)).toBe(true);
    expect(isAllowedRendererUrl("http://127.0.0.1:5174", false)).toBe(true);
    expect(isAllowedRendererUrl("http://evil.test", false)).toBe(false);
    expect(isAllowedRendererUrl("http://localhost:5174/editor", false)).toBe(false);
  });

  test("rejects credentials, fragments, and malformed URLs", () => {
    expect(isAllowedRendererUrl("http://user@localhost:5173", false)).toBe(false);
    expect(isAllowedRendererUrl("file:///app/index.html#script", true)).toBe(false);
    expect(isAllowedRendererUrl("not a URL", true)).toBe(false);
  });
});

describe("packaged offline policy", () => {
  test("test mode can only tighten the packaged offline boundary", () => {
    expect(shouldEnforceOfflinePolicy(false, undefined)).toBe(false);
    expect(shouldEnforceOfflinePolicy(false, "0")).toBe(false);
    expect(shouldEnforceOfflinePolicy(false, "1")).toBe(true);
    expect(shouldEnforceOfflinePolicy(true, undefined)).toBe(true);
    expect(shouldEnforceOfflinePolicy(true, "0")).toBe(true);
  });

  test.each(["openharmony", "ohos"])(
    "enforces installed offline policy on %s without a test flag",
    (platform) => {
      expect(shouldEnforceOfflinePolicy(false, "0", platform)).toBe(true);
    },
  );

  test.each([
    "http://example.test/a",
    "https://example.test/a",
    "ws://example.test/a",
    "wss://example.test/a",
  ])("cancels outbound attempt %s", (candidate) => {
    expect(shouldCancelOutboundRequest(candidate, true)).toBe(true);
  });

  test("does not mistake local application protocols for outbound requests", () => {
    expect(shouldCancelOutboundRequest("file:///app/index.html", true)).toBe(false);
    expect(
      shouldCancelOutboundRequest("patent-print://job/5d5c49f1-5f4c-4e70-9326-dd7e17d68a41", true),
    ).toBe(false);
    expect(shouldCancelOutboundRequest("https://example.test", false)).toBe(false);
  });

  test("permits only tokenized private print URLs in hidden print windows", () => {
    expect(
      isAllowedPrintNavigationUrl("patent-print://job/5d5c49f1-5f4c-4e70-9326-dd7e17d68a41"),
    ).toBe(true);
    expect(isAllowedPrintNavigationUrl("patent-print://job/../secret")).toBe(false);
    expect(isAllowedPrintNavigationUrl("patent-print://other/token")).toBe(false);
    expect(isAllowedPrintNavigationUrl("file:///app/index.html")).toBe(false);
  });

  test("permits only the isolated local diagram editor origin", () => {
    expect(isAllowedDiagramNavigationUrl("patent-diagram://editor/index.html")).toBe(true);
    expect(isAllowedDiagramNavigationUrl("patent-diagram://editor/index.html?remote=1")).toBe(
      false,
    );
    expect(isAllowedDiagramNavigationUrl("patent-diagram://evil/index.html")).toBe(false);
    expect(isAllowedDiagramNavigationUrl("https://app.diagrams.net/?embed=1")).toBe(false);
  });

  test("keeps DevTools closed unless the explicit development flag is exactly enabled", () => {
    expect(isDevToolsEnabled(undefined)).toBe(false);
    expect(isDevToolsEnabled("true")).toBe(false);
    expect(isDevToolsEnabled("1")).toBe(true);
  });

  test("installs a packaged session hook that cancels every outbound protocol", () => {
    let requestFilter: { urls: string[] } | undefined;
    let requestHandler:
      | ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void)
      | undefined;
    let permissionDecision: boolean | undefined;
    let permissionHandler:
      | ((_contents: object, permission: string, callback: (decision: boolean) => void) => void)
      | undefined;
    const target = {
      setPermissionRequestHandler: vi.fn((handler) => {
        permissionHandler = handler;
      }),
      webRequest: {
        onBeforeRequest: vi.fn((filter, handler) => {
          requestFilter = filter;
          requestHandler = handler;
        }),
      },
    };

    installOfflinePolicy(target as never, true);
    permissionHandler?.({}, "camera", (decision: boolean) => {
      permissionDecision = decision;
    });

    expect(requestFilter?.urls).toEqual(["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"]);
    expect(permissionDecision).toBe(false);
    for (const url of ["http://x.test", "https://x.test", "ws://x.test", "wss://x.test"]) {
      let cancelled = false;
      requestHandler?.({ url }, (response) => {
        cancelled = response.cancel;
      });
      expect(cancelled).toBe(true);
    }
  });
});

describe("IPC allow-list", () => {
  test("contains every new preload invoke channel exactly once", () => {
    const declaredChannels = Object.values(IPC_CHANNELS);
    const declaredSet = new Set(declaredChannels);
    const preloadChannels = [...PRELOAD_INVOKE_CHANNELS];
    const expectedNewInvokeChannels = [
      "library:list",
      "library:create",
      "library:open",
      "library:rename",
      "library:apply-edit",
      "library:flush",
      "library:trash",
      "library:restore",
      "library:permanent-delete",
      "library:purge",
      "library:import-patdoc",
      "library:export-patdoc",
      "library:emergency-export-patdoc",
      "library:legacy-drafts",
      "application:close-result",
      "application:force-close",
      "data-transfer:inspect-library",
      "data-transfer:select-export-destination",
      "data-transfer:export-package",
      "data-transfer:select-import-package",
      "data-transfer:prepare-import",
      "data-transfer:commit-import",
      "data-transfer:cancel",
      "text-polish:start",
      "text-polish:cancel",
    ] as const;

    expect(declaredSet.size).toBe(declaredChannels.length);
    expect(new Set(preloadChannels).size).toBe(preloadChannels.length);
    for (const channel of preloadChannels) {
      expect(declaredSet.has(channel)).toBe(true);
    }
    for (const channel of expectedNewInvokeChannels) {
      expect(preloadChannels.filter((candidate) => candidate === channel)).toHaveLength(1);
    }
    expect(declaredSet.has("application:prepare-close")).toBe(true);
    expect(preloadChannels).not.toContain("application:prepare-close");
    expect(PRELOAD_EVENT_CHANNELS).toEqual([
      "usage-statistics:changed",
      "automation:event",
      "application:background-save",
      "application:tray-settings",
      "open-path",
      "application:prepare-close",
      "application:window-layout-changed",
      "ai-correction:event",
      "text-polish:event",
      "text-polish:conversation-event",
      "menu:command",
      "data-transfer:progress",
      "drawings:import-progress",
    ]);
    expect(preloadChannels).not.toContain("data-transfer:progress");
    expect(preloadChannels).not.toContain("application:background-save");
    expect(preloadChannels).not.toContain("application:tray-settings");
    expect(preloadChannels).not.toContain("autosave-settings");
  });

  test("rejects path-like asset identifiers", () => {
    expect(
      AssetReferenceRequestSchema.safeParse({ sessionId: "session-1", assetId: "../secret" })
        .success,
    ).toBe(false);
    expect(
      AssetReferenceRequestSchema.safeParse({
        sessionId: "session-1",
        assetId: "00000000-0000-4000-8000-000000000042",
      }).success,
    ).toBe(true);
  });
});
