import type { PatentApi } from "../../../../shared/ipc/contract";
import {
  type DesignEditorPreferences,
  DesignEditorPreferencesSchema,
} from "../../../../shared/settings/design-editor-preferences";
import type { KlecksFrameClient } from "./klecks-frame-client";

let writes: Promise<unknown> = Promise.resolve();
/** User settings only: never writes a patent, snapshot or editor project. */
export function bindKlecksPreferences(
  frame: KlecksFrameClient,
  settings: PatentApi["settings"] | undefined,
  callbacks: { ready: () => void; error: (message: string) => void },
): () => void {
  if (!settings) {
    callbacks.ready();
    return () => {};
  }
  let closed = false,
    loaded = false,
    initializing = false,
    ready = false,
    last = "",
    timer: ReturnType<typeof setTimeout> | undefined,
    pending: DesignEditorPreferences | undefined;
  let saved: DesignEditorPreferences | undefined;
  const report = () => callbacks.error("工具参数未能保存或恢复，当前图片和编辑内容不受影响。");
  const flush = () => {
    clearTimeout(timer);
    if (!pending) return;
    const value = pending;
    pending = undefined;
    writes = writes
      .catch(() => {})
      .then(async () => {
        const result = await settings.update({ designEditorPreferences: value });
        if (!result.ok) throw new Error(result.error.message);
      })
      .catch(() => {
        if (!closed) report();
      });
  };
  const receive = () => {
    if (frame.isActive && !frame.isActive()) return;
    const snapshot = frame.state.snapshot();
    if (!snapshot?.identity || !snapshot.preferences || closed) return;
    if (!ready) {
      if (!loaded || initializing || snapshot.pending || snapshot.locked) return;
      initializing = true;
      void (async () => {
        try {
          if (saved)
            await frame.tools.send(snapshot.identity!, { action: "preferences", value: saved });
          if (closed) return;
          last = JSON.stringify(frame.state.snapshot()?.preferences);
          ready = true;
          callbacks.ready();
        } catch {
          if (!closed) {
            report();
            callbacks.ready();
          }
        } finally {
          initializing = false;
        }
      })();
      return;
    }
    const value = DesignEditorPreferencesSchema.safeParse(snapshot.preferences);
    if (!value.success) return;
    const key = JSON.stringify(value.data);
    if (key === last) return;
    last = key;
    pending = value.data;
    clearTimeout(timer);
    timer = setTimeout(flush, 200);
  };
  const unsubscribe = frame.state.subscribe(receive);
  void settings
    .read()
    .then((result) => {
      if (closed) return;
      if (!result.ok) throw new Error(result.error.message);
      saved = result.value.designEditorPreferences;
      loaded = true;
      receive();
    })
    .catch(() => {
      if (!closed) {
        report();
        callbacks.ready();
      }
    });
  return () => {
    flush();
    closed = true;
    unsubscribe();
    clearTimeout(timer);
  };
}
