import { useCallback, useEffect, useRef, useState } from "react";
import { AUTOMATION_GLOBAL_DOMAINS } from "../../../shared/automation/global";
import {
  AGENT_CLI_POLICY_TITLE,
  AGENT_CLI_POLICY_VERSION,
} from "../../../shared/automation/policy";
import { AUTOMATION_CREATE_BATCH } from "../../../shared/automation/protocol";
import { AgentCliPolicyDialog } from "./agent-cli-policy-dialog";
import { CreatePermissionSwitch } from "./authorization-scope-editor";
import "./automation-authorization-dialog.css";
import type {
  AutomationScope,
  AutomationUiRequest,
  AutomationUiState,
} from "../../../shared/automation/protocol";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { PATENT_BOOK_LABELS, type PatentBookKind } from "../../../shared/patent/model";
import { MotionPresence } from "../app/motion-presence";
import { confirmAppAction } from "../shared/app-dialog";
import { listAuthorizationPatents } from "./automation-patent-list";
import "./preference-pages.css";
import "./automation-settings.css";

export function ScopeEditor({
  scope,
  patents,
  onChange,
  compact = false,
}: {
  scope: AutomationScope;
  patents: LibraryPatentSummary[];
  onChange(scope: AutomationScope): void;
  compact?: boolean;
}) {
  const activePatents = patents.filter((patent) => !patent.deletedAt);
  const globalCount = Object.keys(scope.global ?? {}).length;
  const globalEditor = (
    <fieldset className="agent-scope-editor__global">
      {!compact ? <legend>全局设置授权</legend> : null}
      <p>影响全局设置或其他文档，请按任务需要单独授权。</p>
      {Object.entries(AUTOMATION_GLOBAL_DOMAINS).map(([domain, label]) => (
        <label key={domain} className="preference-row">
          <span>{label}</span>
          <select
            aria-label={`全局权限 ${label}`}
            value={scope.global?.[domain as keyof typeof AUTOMATION_GLOBAL_DOMAINS] ?? "none"}
            onChange={(event) => {
              const global = { ...scope.global };
              const key = domain as keyof typeof AUTOMATION_GLOBAL_DOMAINS;
              if (event.target.value === "none") delete global[key];
              else global[key] = event.target.value as "read" | "full";
              onChange({ ...scope, global });
            }}
          >
            <option value="none">无权限</option>
            <option value="read">只读</option>
            <option value="full">完整权限</option>
          </select>
        </label>
      ))}
    </fieldset>
  );
  const creationEditor = (
    <CreatePermissionSwitch
      enabled={scope.createLimit > 0}
      onChange={(enabled) =>
        onChange({ ...scope, createLimit: enabled ? AUTOMATION_CREATE_BATCH : 0 })
      }
    />
  );
  return (
    <div className={`agent-scope-editor${compact ? " agent-scope-editor--compact" : ""}`}>
      {compact ? (
        creationEditor
      ) : (
        <p>选择可操作或参考的专利。完整权限内连续执行，其他专利不可访问。</p>
      )}
      {compact && activePatents.length > 0 ? <h3>已有专利</h3> : null}
      <div className="agent-scope-editor__patents">
        {activePatents.map((patent) => (
          <label key={patent.patentId} className="preference-row">
            <span>{patent.name ?? "未命名专利"}</span>
            <select
              aria-label={`权限 ${patent.name ?? patent.patentId}`}
              value={scope.patents[patent.patentId] ?? "none"}
              onChange={(event) => {
                const selected = { ...scope.patents };
                if (event.target.value === "none") delete selected[patent.patentId];
                else selected[patent.patentId] = event.target.value as "read" | "full";
                onChange({ ...scope, patents: selected });
              }}
            >
              <option value="none">无权限</option>
              <option value="read">只读参考</option>
              <option value="full">完整权限</option>
            </select>
          </label>
        ))}
      </div>
      {!compact ? creationEditor : null}
      <p>
        {compact
          ? "未授权专利不可访问；新建专利自动获得完整权限。"
          : "本任务新建的专利自动获得完整权限。修改前保存恢复点，整书改写和恢复历史无需再次批准。"}
      </p>
      <p>完整权限可使用已配置的 AI 服务发送专利内容，受软件联网开关控制。</p>
      {compact ? (
        <details className="agent-scope-editor__advanced">
          <summary>
            全局设置授权<span>{globalCount ? `已授权 ${globalCount} 项` : "未授权"}</span>
          </summary>
          {globalEditor}
        </details>
      ) : (
        globalEditor
      )}
    </div>
  );
}
function readable(value: unknown): string {
  if (value === null || value === undefined) return "（无）";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(readable).join("\n");
  const node = value as Record<string, unknown>;
  if (typeof node.text === "string") return node.text;
  if (node.content) return readable(node.content);
  return JSON.stringify(value, null, 2);
}
function riskReason(reason: string): string {
  if (reason === "deletes-nonempty-block") return "将删除有内容的段落或块";
  if (reason === "destructive-structured-content") return "可能移除表格、公式、样式等结构信息";
  if (reason.startsWith("replaces-entire-original-body:")) {
    const kind = reason.split(":")[1] as PatentBookKind;
    return `将替换${PATENT_BOOK_LABELS[kind] ?? kind}的全部原正文`;
  }
  if (reason === "restores-book") return "将恢复整书内容";
  return reason;
}
function ChangeDiff({ diff }: { diff: unknown }) {
  const sections: Array<{ path: string; before: unknown; after: unknown }> = [];
  function walk(value: unknown, path: string) {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if ("before" in record && "after" in record) {
      const label =
        typeof record.bookKind === "string"
          ? (PATENT_BOOK_LABELS[record.bookKind as PatentBookKind] ?? record.bookKind)
          : path;
      sections.push({ path: label, before: record.before, after: record.after });
      return;
    }
    for (const [key, child] of Object.entries(record))
      walk(child, `${path}${path ? " / " : ""}${key}`);
  }
  walk(diff, "");
  const label = (path: string) =>
    ({ "metadata / name": "专利名称", "metadata / customer": "客户", figures: "附图" })[path] ??
    path;
  return (
    <div>
      {sections.map((part) => (
        <div key={part.path}>
          <h5>{label(part.path)}</h5>
          {Array.isArray(part.before) && Array.isArray(part.after) ? (
            <p>
              块 / 条目数量：{part.before.length} → {part.after.length}
            </p>
          ) : null}
          <p>修改前</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{readable(part.before)}</pre>
          <p>修改后</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{readable(part.after)}</pre>
        </div>
      ))}
      <details>
        <summary>完整结构、样式及节点详情</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {JSON.stringify(diff, null, 2)}
        </pre>
      </details>
    </div>
  );
}
export function AutomationSettings({ active = true }: { active?: boolean }) {
  const [state, setState] = useState<AutomationUiState | null>(null);
  const [patents, setPatents] = useState<LibraryPatentSummary[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AutomationScope>>({});
  const [editingGrant, setEditingGrant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [guideMessage, setGuideMessage] = useState("");
  const [accessInstructions, setAccessInstructions] = useState("");
  const [copying, setCopying] = useState(false);
  const [policyOpen, setPolicyOpen] = useState<"view" | "enable" | null>(null);
  const mounted = useRef(false);
  const refreshVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const [result, patentResult] = await Promise.all([
        window.patentApi.automation?.control({ action: "status" }),
        listAuthorizationPatents().catch(() => null),
      ]);
      if (!mounted.current || version !== refreshVersion.current) return;
      if (result?.ok) {
        setState(result.value as AutomationUiState);
        setError("");
      } else setError("无法读取 Agent CLI 状态，请稍后重试。");
      if (patentResult) setPatents(patentResult);
      else setError("无法读取专利授权范围，请稍后重试。");
    } catch {
      if (mounted.current && version === refreshVersion.current)
        setError("无法读取 Agent CLI 状态，请稍后重试。");
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const unsubscribe = window.patentApi.automation?.onEvent((event) => {
      if (event.type === "stateChanged") void refresh();
    });
    return () => {
      refreshVersion.current += 1;
      unsubscribe?.();
    };
  }, [active, refresh]);
  async function run(request: AutomationUiRequest) {
    setBusy(true);
    try {
      const result = await window.patentApi.automation?.control(request);
      if (!result?.ok) {
        await refresh();
        setError("操作未完成，请检查授权范围和文档状态后重试。");
        return false;
      } else {
        setError("");
        await refresh();
        if (request.action === "updateGrant") setEditingGrant(null);
        return true;
      }
    } catch {
      setError("操作未完成，请稍后重试。");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function update(pairId: string, scope: AutomationScope) {
    setDrafts((current) => ({ ...current, [pairId]: scope }));
  }
  const name = (id: string) => patents.find((patent) => patent.patentId === id)?.name ?? id;
  async function copyAccessInstructions() {
    setCopying(true);
    setGuideMessage("");
    try {
      const instructions = await window.patentApi.automation?.control({
        action: "accessInstructions",
      });
      if (!mounted.current) return;
      if (!instructions?.ok || typeof instructions.value !== "string") {
        setGuideMessage("无法生成接入指令，请确认 Agent CLI 已开启且本机 CLI 已构建或安装。");
        return;
      }
      setAccessInstructions(instructions.value);
      const result = await window.patentApi.clipboard?.writeText(instructions.value);
      if (mounted.current)
        setGuideMessage(
          result?.ok
            ? "接入指令已复制，连同任务要求一次发给 Agent 即可。"
            : "复制失败，可展开接入指令后手动复制。",
        );
    } catch {
      if (mounted.current) setGuideMessage("复制未完成，请重试；已有接入指令可展开后手动复制。");
    } finally {
      if (mounted.current) setCopying(false);
    }
  }
  const scopeSummary = (scope: AutomationScope) => (
    <div className="agent-scope-summary">
      <dl>
        <div>
          <dt>全局授权</dt>
          <dd>
            {Object.entries(scope.global ?? {})
              .map(
                ([key, level]) =>
                  `${AUTOMATION_GLOBAL_DOMAINS[key as keyof typeof AUTOMATION_GLOBAL_DOMAINS]}（${level === "full" ? "完整" : "只读"}）`,
              )
              .join("、") || "无"}
          </dd>
        </div>
        <div>
          <dt>完整权限</dt>
          <dd>
            {Object.entries(scope.patents)
              .filter(([, level]) => level === "full")
              .map(([id]) => name(id))
              .join("、") || "无"}
          </dd>
        </div>
        <div>
          <dt>只读参考</dt>
          <dd>
            {Object.entries(scope.patents)
              .filter(([, level]) => level === "read")
              .map(([id]) => name(id))
              .join("、") || "无"}
          </dd>
        </div>
        <div>
          <dt>每次新建额度</dt>
          <dd>{scope.createLimit}</dd>
        </div>
      </dl>
      <details>
        <summary>目录与授权详情</summary>
        <p>材料目录：{scope.workspace.importDirectory ?? "自动分配"}</p>
        <p>成果目录：{scope.workspace.exportDirectory ?? "自动分配"}</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {JSON.stringify(scope, null, 2)}
        </pre>
      </details>
    </div>
  );
  return (
    <section
      className="settings-page settings-preferences settings-compact agent-cli-page"
      aria-label="Agent CLI 设置"
    >
      <div className="preference-group">
        <div className="agent-section-heading">
          <h4>本机接入</h4>
          <span className="agent-status-badge" data-enabled={state?.enabled ?? false}>
            {!state ? "正在读取" : state.enabled ? "已开启" : "未开启"}
          </span>
        </div>
        <div className="preference-card">
          <label className="preference-row">
            <input
              type="checkbox"
              aria-label="启用 Agent CLI"
              checked={state?.enabled ?? false}
              disabled={!state || busy || policyOpen !== null}
              onChange={(event) => {
                if (event.target.checked) setPolicyOpen("enable");
                else void run({ action: "setEnabled", enabled: false });
              }}
            />
            <span className="preference-copy">
              启用 Agent CLI
              <small>允许本机 AI Agent 通过命令行连接，操作你的‘知产小栈Work’。</small>
            </span>
          </label>
          <div className="agent-connection-footer">
            <p>
              {!state
                ? "正在读取接入状态…"
                : state.enabled
                  ? "连接时弹出授权窗口，退出软件后授权失效。"
                  : "开启后，Agent 才能向本软件发起连接。"}
            </p>
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              刷新状态
            </button>
          </div>
          <div className="agent-policy-link-row">
            <button type="button" onClick={() => setPolicyOpen("view")}>
              {AGENT_CLI_POLICY_TITLE}
            </button>
            <p>默认关闭，开启前需阅读并同意；第三方 Agent 可能将获准材料发送至外部服务。</p>
          </div>
          {state?.instance ? (
            <details className="agent-instance-details">
              <summary>实例信息 · 版本 {state.instance.version}</summary>
              <p>实例编号：{state.instance.instanceId}</p>
              <p>文档库编号：{state.instance.libraryId}</p>
            </details>
          ) : null}
        </div>
        {error ? (
          <p className="agent-feedback agent-feedback--error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="preference-group">
        <h4>如何使用</h4>
        <div className="preference-card agent-guide">
          <div className="agent-guide-entry">
            <div>
              <strong>把接入指令和任务要求一起发给 Agent</strong>
            </div>
            <button
              type="button"
              className="agent-primary"
              disabled={!state?.enabled || copying}
              onClick={() => void copyAccessInstructions()}
            >
              {copying ? "正在复制…" : "复制 Agent 接入指令"}
            </button>
          </div>
          <details className="agent-usage-guide">
            <summary>使用说明</summary>
            <ol>
              <li>
                <div>
                  <strong>开启入口，准备 Agent</strong>
                  <p>打开上方开关，使用能在本机执行命令的 AI Agent。</p>
                </div>
              </li>
              <li>
                <div>
                  <strong>复制接入指令，一次发给 Agent</strong>
                  <p>Agent 会读取完整手册，连接当前正在运行的软件实例。</p>
                </div>
              </li>
              <li>
                <div>
                  <strong>确认授权，等待任务完成</strong>
                  <p>在授权弹窗选择专利完整权限或只读参考；全局管理需单独授权。</p>
                </div>
              </li>
            </ol>
            <p className="agent-guide-note">
              同一授权范围内可连续工作。新建专利自动获得完整权限，其他未授权专利不可访问。
            </p>
          </details>
          {accessInstructions ? (
            <details className="agent-entry-help">
              <summary>查看完整接入指令</summary>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {accessInstructions}
              </pre>
            </details>
          ) : null}
        </div>
        {guideMessage ? (
          <p className="agent-feedback" role="status">
            {guideMessage}
          </p>
        ) : null}
      </div>

      <div className="preference-group">
        <div className="agent-section-heading">
          <h4>已授权 Agent</h4>
          <span className="agent-section-count">{state?.grants.length ?? 0} 个</span>
        </div>
        {state?.grants.length === 0 ? (
          <div className="preference-card agent-empty-state">
            <strong>暂无已授权 Agent</strong>
          </div>
        ) : null}
        {state?.grants.map((grant) => (
          <div className="preference-card agent-grant" key={grant.grantId}>
            <div className="agent-grant__heading">
              <div>
                <h5>{grant.label}</h5>
                <p>
                  本任务已新建 {grant.createdCount} 条专利
                  {grant.creationRemaining !== undefined
                    ? `，本轮剩余 ${grant.creationRemaining} 件`
                    : ""}
                </p>
              </div>
              <span className="agent-status-badge" data-enabled="true">
                已授权
              </span>
            </div>
            {scopeSummary(grant.scope)}
            <div className="agent-actions">
              <button
                type="button"
                disabled={busy || editingGrant === grant.grantId}
                aria-label={`调整 ${grant.label} 授权`}
                onClick={() => {
                  update(grant.grantId, structuredClone(grant.scope));
                  setEditingGrant(grant.grantId);
                }}
              >
                调整授权
              </button>
              <button
                type="button"
                className="agent-revoke"
                disabled={busy}
                aria-label={`撤销 ${grant.label} 授权`}
                onClick={() => void run({ action: "revoke", grantId: grant.grantId })}
              >
                撤销授权
              </button>
            </div>
            <MotionPresence kind="panel">
              {editingGrant === grant.grantId ? (
                <fieldset className="agent-grant-editor" disabled={busy}>
                  <legend>调整 {grant.label} 的授权范围</legend>
                  <ScopeEditor
                    scope={drafts[grant.grantId] ?? grant.scope}
                    patents={patents}
                    onChange={(scope) => update(grant.grantId, scope)}
                  />
                  {scopeSummary(drafts[grant.grantId] ?? grant.scope)}
                  <div className="agent-actions">
                    <button
                      type="button"
                      className="agent-primary"
                      onClick={() =>
                        void run({
                          action: "updateGrant",
                          grantId: grant.grantId,
                          scope: drafts[grant.grantId] ?? grant.scope,
                        })
                      }
                    >
                      保存授权范围
                    </button>
                    <button type="button" disabled={busy} onClick={() => setEditingGrant(null)}>
                      取消调整
                    </button>
                  </div>
                </fieldset>
              ) : null}
            </MotionPresence>
          </div>
        ))}
      </div>

      {state?.pendingPairs.length ? (
        <div className="preference-group">
          <div className="agent-section-heading">
            <h4>待授权请求</h4>
            <span className="agent-section-count">{state.pendingPairs.length} 个</span>
          </div>
          {state.pendingPairs.map((pair) => (
            <div className="preference-card agent-pair" key={pair.pairId}>
              <strong>{pair.label}</strong>
              <p>请在中央授权窗口处理此请求。</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="preference-group">
        <div className="agent-section-heading">
          <h4>任务与暂存</h4>
          <span className="agent-section-count">{state?.changes.length ?? 0} 项待应用修改</span>
        </div>
        <div className="preference-card agent-task-list">
          {state?.changes.length === 0 ? (
            <p className="agent-empty-copy">
              暂无待应用修改。已授权任务由 Agent 连续执行，无需逐步批准。
            </p>
          ) : null}
          {state?.changes.map((change) => (
            <details className="agent-change" key={change.changeId}>
              <summary>
                {change.name ?? change.patentId} · {change.clientLabel}
              </summary>
              <div className="agent-change__body">
                <p>
                  基于修订 {change.expectedRevision} · 无需再次批准 · 到期{" "}
                  {new Date(change.expiresAt).toLocaleString("zh-CN")}
                </p>
                <p>{change.risk.reasons.map(riskReason).join("；")}</p>
                <ChangeDiff diff={change.diff} />
                <div className="agent-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run({ action: "discardChange", changeId: change.changeId })}
                  >
                    丢弃此修改
                  </button>
                </div>
              </div>
            </details>
          ))}
          <div className="agent-asset-row">
            <span>暂存素材：{state?.stagedAssetCount ?? 0} 项</span>
            <button
              type="button"
              disabled={busy || !state?.stagedAssetCount}
              onClick={async () => {
                if (await confirmAppAction("丢弃未被待处理修改引用的暂存素材？"))
                  void run({ action: "discardAssets" });
              }}
            >
              丢弃闲置暂存素材
            </button>
          </div>
        </div>
      </div>
      <AgentCliPolicyDialog
        open={policyOpen !== null}
        onClose={() => setPolicyOpen(null)}
        onAccept={
          policyOpen === "enable"
            ? () =>
                run({
                  action: "setEnabled",
                  enabled: true,
                  policyAcceptedVersion: AGENT_CLI_POLICY_VERSION,
                })
            : undefined
        }
      />
    </section>
  );
}
