import { describe, expect, test, vi } from "vitest";

describe("Ketcher standalone runtime", () => {
  test("installs Ketcher's browser globals before runtime initialization", async () => {
    const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "global");
    expect(globalDescriptor?.configurable).toBe(true);
    expect(Reflect.deleteProperty(globalThis, "global")).toBe(true);

    try {
      vi.resetModules();
      const runtime = await import("./ketcher-editor");

      expect(Reflect.get(globalThis, "global")).toBe(globalThis);
      const installBrowserGlobals = Reflect.get(runtime, "installKetcherBrowserGlobals");
      expect(installBrowserGlobals).toBeTypeOf("function");

      const browserTarget = {};
      installBrowserGlobals(browserTarget);
      expect(Reflect.get(browserTarget, "global")).toBe(browserTarget);
      expect(Reflect.get(browserTarget, "process")).toMatchObject({ env: {} });
      expect(Reflect.get(browserTarget, "process").nextTick).toBeTypeOf("function");
    } finally {
      if (globalDescriptor) Object.defineProperty(globalThis, "global", globalDescriptor);
    }
  });

  test("exposes StandaloneStructServiceProvider", async () => {
    const canvas = document.createElement("canvas");
    const context = new Proxy(
      {
        canvas,
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      },
      { get: (target, property) => target[property as keyof typeof target] ?? (() => undefined) },
    );
    const getContext = HTMLCanvasElement.prototype.getContext;
    const WorkerConstructor = globalThis.Worker;
    HTMLCanvasElement.prototype.getContext = () => context as never;
    globalThis.Worker = class {} as never;
    try {
      const runtime = await import("ketcher-standalone");

      expect(runtime.StandaloneStructServiceProvider).toBeTypeOf("function");
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
      globalThis.Worker = WorkerConstructor;
    }
  });
});
