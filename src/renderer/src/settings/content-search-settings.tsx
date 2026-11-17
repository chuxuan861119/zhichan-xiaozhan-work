import { useEffect, useState } from "react";
import type {
  ContentSearchRequest,
  ContentSearchState,
} from "../../../shared/library/content-search";
import { confirmAppAction } from "../shared/app-dialog";
import { SpatialPresence } from "../shared/spatial-presence";

export function ContentSearchSettings({ active = true }: { active?: boolean }) {
  const [state, setState] = useState<ContentSearchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = async () => {
      try {
        const result = await window.patentApi.contentSearch?.request({ action: "status" });
        if (cancelled) return;
        if (result?.ok) {
          setState(result.value);
          setError("");
        } else setError("索引暂不可用，文档编辑和名称搜索不受影响。");
      } catch {
        if (!cancelled) setError("无法读取索引状态，请稍后重试。");
      }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);
  async function run(request: ContentSearchRequest) {
    setBusy(true);
    try {
      const result = await window.patentApi.contentSearch?.request(request);
      if (result?.ok) {
        setState(result.value);
        setError("");
      } else setError("操作未完成，请稍后重试。");
    } catch {
      setError("操作未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="settings-page settings-preferences settings-compact settings-content-search"
      aria-label="内容搜索设置"
    >
      <div className="preference-group">
        <h4>后台索引</h4>
        <div className="preference-card">
          <label className="preference-row">
            <input
              type="checkbox"
              aria-label="后台建立内容索引"
              checked={state?.enabled ?? false}
              disabled={!state || busy}
              onChange={(e) => void run({ action: "configure", enabled: e.target.checked })}
            />
            <span className="preference-copy">
              后台建立内容索引
              <small>空闲时更新五书文字；编辑与保存优先</small>
            </span>
          </label>
          <div className="preference-row settings-content-search__status">
            <span className="preference-copy">
              索引状态
              <small>关闭后仍可搜索已有索引，结果可能不是最新。</small>
            </span>
            <span role="status">
              {state?.running
                ? `${state.paused ? "等待空闲" : "正在索引"} ${state.completed} / ${state.total}`
                : state?.indexPhase === "failed"
                  ? "索引失败"
                  : state?.indexPhase === "partial"
                    ? "索引部分完成"
                    : state?.indexPhase === "cancelled"
                      ? "已停止索引"
                      : state?.updatedAt
                        ? `最近完成：${new Date(state.updatedAt).toLocaleString("zh-CN")}`
                        : "尚未建立索引"}
              {state?.error ? " · 部分内容未能更新，请重试" : ""}
              {state?.pendingCount ? ` · ${state.pendingCount} 项待更新` : ""}
            </span>
          </div>
        </div>
      </div>
      {state?.running ? (
        <progress aria-label="索引进度" max={Math.max(1, state.total)} value={state.completed} />
      ) : null}
      <div className="content-search-settings-actions">
        <button
          type="button"
          className="primary-button"
          disabled={!state || busy || (state.running && state.manual === true)}
          onClick={async () => {
            if (
              await confirmAppAction(
                "将立即更新内容搜索索引，可能暂时增加电脑负载。建议在暂不编辑文档时执行，已有文档不会被修改。确认现在空闲并开始索引？",
              )
            )
              await run({ action: "start" });
          }}
        >
          立即索引
        </button>
        {state?.running ? (
          <button type="button" disabled={busy} onClick={() => void run({ action: "stop" })}>
            停止
          </button>
        ) : null}
      </div>
      <p className="settings-content-search__note">
        仅在本机处理五书中的文字，不识别图片中的文字。索引不随备份或数据迁移导出。
      </p>
      {<SpatialPresence>{error ? <p role="alert">{error}</p> : null}</SpatialPresence>}
    </section>
  );
}
