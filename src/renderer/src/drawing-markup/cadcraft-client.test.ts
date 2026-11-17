import { afterEach, expect, test, vi } from "vitest";
import { CadcraftClient, ensureCadcraftClient } from "./cadcraft-client";

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  terminate = vi.fn();
  postMessage(message: { id: number }) {
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, value: "ready" } }));
  }
  constructor() {
    TestWorker.instances.push(this);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  TestWorker.instances = [];
});

test("native mesh rejection keeps the session usable and exposes only the user-facing reason", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const client = new CadcraftClient();
  try {
    const pending = client.request("query", "bridge.preview_modify", {});
    TestWorker.instances[0]?.onmessage?.({
      data: { id: 1, ok: false, error: "CAD_GEAR_MESH_REJECTED:对象已锁定" },
    });
    await expect(pending).rejects.toThrow(/^对象已锁定$/);
    expect(client.isClosed).toBe(false);
    await expect(client.request("commands")).resolves.toBe("ready");
  } finally {
    client.close();
  }
});

test("repeated paste sends its frozen bytes once per healthy target worker",async()=>{
  vi.stubGlobal("Worker",TestWorker);const client=new CadcraftClient();
  const worker=TestWorker.instances[0]!;
  const send=vi.spyOn(worker,"postMessage");const bytes=new Uint8Array([1,2,3]);
  try {
    await client.request("editPaste",bytes,{});await client.request("editPaste",bytes,{});
    const first=(send.mock.calls[0]![0] as unknown as {args:unknown[]}).args[0];
    const second=(send.mock.calls[1]![0] as unknown as {args:unknown[]}).args[0];
    expect(first).toMatchObject({bytes});
    expect(second).toEqual({id:(first as {id:number}).id});
    await client.request("editPaste",new Uint8Array([4]),{});
    expect((send.mock.calls[2]![0] as unknown as {args:unknown[]}).args[0]).toMatchObject({bytes:new Uint8Array([4])});
  }finally{client.close();}
});

test("recreates a failed composition session before retry, and retains a healthy session", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const first = new CadcraftClient();
  TestWorker.instances[0]?.onerror?.();
  await expect(first.request("commands")).rejects.toThrow("已关闭");
  const recovered = ensureCadcraftClient(first);
  expect(recovered).not.toBe(first);
  await expect(recovered.request("commands")).resolves.toBe("ready");
  expect(ensureCadcraftClient(recovered)).toBe(recovered);
  recovered.close();
});

test("rejects all outstanding requests when a worker fails without leaving request timers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", TestWorker);
  try {
    const client = new CadcraftClient();
    const first = client.request("scene");
    const second = client.request("commands");
    const assertions = Promise.all([
      expect(first).rejects.toThrow("加载失败"),
      expect(second).rejects.toThrow("加载失败"),
    ]);
    TestWorker.instances[0]?.onerror?.();
    await assertions;
    expect(client.isClosed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

class ManualWorker extends TestWorker {
  override postMessage(_message: { id: number }) {}
}

test.each(["MacIntel", "Win32"])("dense replies preserve order on %s", async platform => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ManualWorker);
  vi.stubGlobal("documentFontPlatform", platform);
  const client = new CadcraftClient();
  try {
    const order: number[] = [];
    const first = client.request("edit", "move").then(() => order.push(1));
    const second = client.request("pick").then(() => order.push(2));
    const worker = TestWorker.instances[0]!;
    worker.onmessage?.({data:{id:1,ok:true,value:{scene:{primitives:Array(5000)}}}});
    worker.onmessage?.({data:{id:2,ok:true,value:"handle"}});
    await Promise.resolve();
    expect(order).toEqual(platform === "MacIntel" ? [] : [1,2]);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first,second]);
    expect(order).toEqual([1,2]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {client.close();vi.useRealTimers();}
});

test("closing during a deferred Mac reply rejects it and removes all timers",async()=>{
  vi.useFakeTimers();vi.stubGlobal("Worker",ManualWorker);vi.stubGlobal("documentFontPlatform","MacIntel");
  const client=new CadcraftClient();
  try {
    const result=client.request("edit","move");
    const rejected=expect(result).rejects.toThrow("已关闭");
    TestWorker.instances[0]?.onmessage?.({data:{id:1,ok:true,value:{scene:{primitives:Array(5000)}}}});
    client.close();await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {client.close();vi.useRealTimers();}
});
