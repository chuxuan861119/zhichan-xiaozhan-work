import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CorrectionUnsavedDialog } from "./correction-unsaved-dialog";

type Choice = "save" | "discard" | "cancel";
type Entry = {
  id: number;
  count: number;
  recoveryCount: number;
  purpose: "close" | "export";
  resolve(choice: Choice): void;
  cleanup(): void;
};
export function useKlecksClosePrompt() {
  const pending = useRef<Entry[]>([]),
    serial = useRef(0),
    alive = useRef(true);
  const [, update] = useState(0);
  const refresh = useCallback(() => {
    if (alive.current) update((value) => value + 1);
  }, []);
  const finish = useCallback(
    (entry: Entry, choice: Choice) => {
      if (!pending.current.includes(entry)) return;
      pending.current = pending.current.filter((item) => item !== entry);
      entry.cleanup();
      entry.resolve(choice);
      refresh();
    },
    [refresh],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const entry of pending.current) {
        entry.cleanup();
        entry.resolve("cancel");
      }
      pending.current = [];
    };
  }, []);
  const request = useCallback(
    (
      count: number,
      signal: AbortSignal,
      purpose: "close" | "export" = "close",
      recoveryCount = 0,
    ): Promise<Choice> => {
      if (!alive.current || signal.aborted) return Promise.resolve("cancel");
      return new Promise((resolve) => {
        const entry: Entry = {
          id: ++serial.current,
          count,
          recoveryCount,
          purpose,
          resolve,
          cleanup: () => signal.removeEventListener("abort", abort),
        };
        const abort = () => finish(entry, "cancel");
        signal.addEventListener("abort", abort, { once: true });
        pending.current.push(entry);
        refresh();
      });
    },
    [finish, refresh],
  );
  const entry = pending.current[0];
  return {
    request,
    dialog: entry
      ? createPortal(
          <CorrectionUnsavedDialog
            key={entry.id}
            presentation={
              entry.purpose === "export"
                ? {
                    title: "选择导出图片版本",
                    description: `${entry.count} 张图片有尚未应用的编辑。${entry.recoveryCount ? `其中 ${entry.recoveryCount} 张有自动恢复草稿，应用新版前需要处理恢复提示。` : ""}也可以使用上次已应用图片（没有应用版本的使用原图），恢复草稿和图层工程会保留。`,
                    stay: "取消导出",
                    discard: "使用上次已应用图片",
                    apply: "应用最新编辑后导出",
                  }
                : {
                    title: "未保存的图片编辑",
                    description: `${entry.count} 张图片有未保存编辑。保存不等于应用到视图；放弃将返回上次保存版本。`,
                    stay: "取消",
                    discard: "放弃未保存修改",
                    apply: "保存编辑并关闭",
                  }
            }
            onStay={() => finish(entry, "cancel")}
            onDiscard={() => finish(entry, "discard")}
            onApply={() => finish(entry, "save")}
          />,
          document.body,
        )
      : null,
  };
}
