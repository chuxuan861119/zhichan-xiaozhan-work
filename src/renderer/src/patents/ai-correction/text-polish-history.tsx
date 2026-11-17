import { Pencil, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import type { TextPolishWorkspace } from "../../../../shared/ai-correction/text-polish-contract";
import { confirmAppAction, promptAppText } from "../../shared/app-dialog";

export type HistoryAction = "rename" | "delete" | "stop";
const labels = {
  running: "思考中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  idle: "待继续",
};

export function TextPolishHistory({
  items,
  busy,
  currentId,
  onOpen,
  onManage,
  onRecover,
}: {
  items: TextPolishWorkspace["history"];
  busy: boolean;
  currentId?: string | null;
  onOpen(id: string): Promise<void>;
  onManage?(action: HistoryAction, id: string, title?: string): Promise<void>;
  onRecover?(id: string): Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(20);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtered = items
    .filter((item) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const run = async (work: () => Promise<void>) => {
    if (pending || busy) return;
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作失败，请重试。");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <p>原文、回复与草稿保存在本机；思考过程仅在本次打开期间保留。新对话不会删除历史。</p>
      <input
        type="search"
        aria-label="搜索历史对话"
        placeholder="搜索对话名称"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCount(20);
        }}
      />
      {error ? (
        <p role="alert" className="ai-form-error">
          {error}
        </p>
      ) : null}
      {filtered.length === 0 ? <p>{items.length ? "没有匹配的对话" : "暂无历史对话"}</p> : null}
      {filtered.slice(0, count).map((item) => (
        <div key={item.conversationId} className="polish-history-row">
          <button
            type="button"
            className="polish-history__item"
            aria-label={`打开${item.title}`}
            aria-current={item.conversationId === currentId ? "true" : undefined}
            disabled={busy || pending || Boolean(item.error)}
            onClick={() => void run(() => onOpen(item.conversationId))}
          >
            <strong>{item.title}</strong>
            <span>{item.error ?? labels[item.status ?? "idle"]}</span>
            {item.updatedAt ? <time>{new Date(item.updatedAt).toLocaleString()}</time> : null}
          </button>
          {item.error && onRecover ? (
            <button
              type="button"
              disabled={busy || pending}
              onClick={() => void run(() => onRecover(item.conversationId))}
            >
              保留异常文件并隔离此对话
            </button>
          ) : null}
          {!item.error && onManage ? (
            <div className="polish-history-actions">
              {item.status === "running" ? (
                <button
                  type="button"
                  className="polish-icon-action"
                  title="停止思考"
                  aria-label={`停止${item.title}`}
                  disabled={busy || pending}
                  onClick={() => void run(() => onManage("stop", item.conversationId))}
                >
                  <Square size={15} />
                </button>
              ) : null}
              <button
                type="button"
                className="polish-icon-action"
                title="重命名"
                aria-label={`重命名${item.title}`}
                disabled={busy || pending || item.status === "running"}
                onClick={() =>
                  void run(async () => {
                    const title = await promptAppText("对话名称（最多 80 字符）", item.title);
                    if (title === null) return;
                    if (!title.trim() || title.trim().length > 80)
                      throw new Error("名称需要 1 至 80 字符。");
                    await onManage("rename", item.conversationId, title.trim());
                  })
                }
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                className="polish-icon-action"
                title="删除对话"
                aria-label={`删除${item.title}`}
                disabled={busy || pending || item.status === "running"}
                onClick={() =>
                  void run(async () => {
                    if (
                      await confirmAppAction(
                        `删除“${item.title}”的本机会话及草稿？此操作不可撤销，不会修改专利正文；已有备份不受影响。`,
                      )
                    )
                      await onManage("delete", item.conversationId);
                  })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {filtered.length > count ? (
        <button type="button" onClick={() => setCount((value) => value + 20)}>
          显示更多（剩余 {filtered.length - count}）
        </button>
      ) : null}
    </>
  );
}
