import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
  USAGE_TERMS,
  type UsageChoice,
  type UsageState,
} from "../../../shared/usage-statistics/model";
import { SpatialCollapse } from "../shared/spatial-collapse";
import "./preference-pages.css";
import "./usage-statistics-settings.css";

type UsageContext = {
  state: UsageState | null;
  error: string;
  busy: boolean;
  choose(choice: UsageChoice): Promise<boolean>;
};
const Context = createContext<UsageContext | null>(null);
export function UsageStatisticsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UsageState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingChoices = useRef(0);
  const api = window.patentApi?.usageStatistics;
  useEffect(() => {
    let mounted = true;
    let revision = 0;
    if (!api) return;
    const apply = (next: UsageState) => {
      if (mounted) setState(next);
    };
    const unsubscribe = api.onChanged((next) => {
      revision++;
      apply(next);
    });
    const initialRevision = revision;
    void api
      .read()
      .then((result) => {
        if (!mounted || initialRevision !== revision) return;
        if (result.ok) apply(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (mounted) setError("无法读取统计选项，请在帮助 → 软件使用协议中重试。统计未开启。");
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api]);
  const choose = async (choice: UsageChoice) => {
    if (!api || (busy && choice.enabled)) return false;
    pendingChoices.current++;
    setBusy(true);
    setError("");
    try {
      const result = await api.choose(choice);
      if (!result.ok) {
        setError(result.error.message);
        return false;
      }
      setState(result.value);
      if (result.value.status === "error") {
        setError(result.value.message);
        return false;
      }
      return true;
    } catch {
      setError("统计选项未能保存，请重试。关闭操作已提交，但持久化结果尚未确认。");
      return false;
    } finally {
      pendingChoices.current--;
      setBusy(pendingChoices.current > 0);
    }
  };
  return <Context.Provider value={{ state, error, busy, choose }}>{children}</Context.Provider>;
}

const statusLabels = {
  pending: "待确认统计告知",
  disabled: "已关闭",
  unconfigured: "服务未开放",
  participating: "已参与",
  "clock-paused": "时间异常暂停",
  error: "统计已暂停",
};
const resultLabels = {
  attempted: "已尝试，接收结果尚未确认",
  received: "服务已确认接收",
  rejected: "服务拒绝，本份日报不再重试",
  unknown: "接收结果不明；仍在补发窗口的日报会退避重试",
};
export function UsageStatisticsSettings({ embedded = false }: { embedded?: boolean }) {
  const usage = useContext(Context);
  const state = usage?.state;
  const [notice, setNotice] = useState<"choice" | "terms" | "privacy" | null>(null);
  const title =
    notice === "privacy"
      ? "使用统计隐私说明"
      : notice === "terms"
        ? "用户协议：使用统计"
        : "使用统计告知";
  const decide = async (enabled: boolean) => {
    if (
      await usage?.choose({
        enabled,
        ...(enabled && state ? { noticeVersion: state.noticeVersion } : {}),
      })
    )
      setNotice(null);
  };
  return (
    <section
      className={
        embedded
          ? "usage-settings usage-settings--embedded"
          : "settings-page settings-preferences settings-compact usage-settings"
      }
      aria-label="使用统计设置"
    >
      {!embedded ? (
        <>
          <h4>帮助了解软件的大致使用情况</h4>
          <p>
            统计前台可见时长的区间次数和参与统计的活跃安装贡献。阅读也算使用，前台静置可能计入；这些数字不等同实际工作时长或精确人数。
          </p>
        </>
      ) : null}
      <label className="usage-setting-switch">
        <span>参与使用统计</span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={state?.enabled ?? false}
          checked={state?.enabled ?? false}
          disabled={!state || (!state.enabled && usage?.busy)}
          onChange={(event) => {
            if (!usage || !state) return;
            if (event.target.checked && (!state.accepted || !state.available)) setNotice("choice");
            else {
              setNotice(null);
              void usage.choose({ enabled: event.target.checked });
            }
          }}
        />
      </label>
      <p role="status">
        {state
          ? `${statusLabels[state.status]}：${state.message}`
          : "当前环境无法读取使用统计选项。"}
      </p>
      {state?.enabled && !state.accepted ? (
        <button type="button" disabled={usage?.busy} onClick={() => setNotice("choice")}>
          查看统计告知并选择
        </button>
      ) : null}
      {state?.status === "error" ? (
        <button
          type="button"
          disabled={usage?.busy}
          onClick={() => void usage?.choose({ enabled: false })}
        >
          重试保存关闭选项
        </button>
      ) : null}
      {state?.lastAttempt ? (
        <p>
          最近尝试上报的业务日期：{state.lastAttempt.day}；{resultLabels[state.lastAttempt.result]}
          。
        </p>
      ) : (
        <p>尚未尝试上报。</p>
      )}
      <p>
        关闭立即停止统计并丢弃未发送计数；已进入汇总的贡献无法按个人定位删除。您可在此查看完整告知并选择是否参与，已有关闭选择不会因查看或确认协议而自动恢复。
      </p>
      <div className="usage-policy-links">
        {embedded ? (
          <button type="button" disabled={!state} onClick={() => setNotice("terms")}>
            查看完整统计告知
          </button>
        ) : (
          <>
            <button type="button" disabled={!state} onClick={() => setNotice("terms")}>
              用户协议：使用统计
            </button>
            <button type="button" disabled={!state} onClick={() => setNotice("privacy")}>
              使用统计隐私说明
            </button>
          </>
        )}
      </div>
      <SpatialCollapse open={notice !== null}>
        <section className="usage-policy" aria-label={title}>
          <h4>{title}</h4>
          <h3>明确选择，确认后才运行</h3>
          {USAGE_TERMS.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <h3>接收与保存</h3>
          {state?.available ? (
            <>
              <p>
                运营主体：{state.disclosure.operator}；联系：{state.disclosure.contact}。
              </p>
              <p>
                接收方：{state.disclosure.recipient}；存储地域：{state.disclosure.region}。
                汇总数据保留 {state.disclosure.retentionMonths} 个月。
              </p>
              <p>{state.disclosure.securityLogNotice}</p>
            </>
          ) : (
            <p>
              统计服务尚未开放，目前不计时、不上报。运营主体、接收方、地域及安全日志说明完整公布后，您才能确认参与。
            </p>
          )}
          <p>
            本机仅保存选择、告知版本、当前日计数、7天待补发日报、最多32个已结算日期及最近尝试结果；关闭统计会清除未发送计数。告知范围更新后重新确认前不运行。
          </p>
          <div className="usage-policy-links">
            {notice === "choice" ? (
              <>
                <button type="button" onClick={() => void decide(false)}>
                  关闭统计
                </button>
                <button
                  type="button"
                  disabled={usage?.busy || !state?.available || state.status === "error"}
                  onClick={() => void decide(true)}
                >
                  同意并参与统计
                </button>
              </>
            ) : null}
            <button type="button" onClick={() => setNotice(null)}>
              收起说明
            </button>
          </div>
        </section>
      </SpatialCollapse>
      {usage?.error ? <p role="alert">{usage.error}</p> : null}
    </section>
  );
}
