import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AUTOMATION_GLOBAL_DOMAINS } from "../../../shared/automation/global";
import type {
  AutomationAuthorizationRequest,
  AutomationScope,
} from "../../../shared/automation/protocol";
import { AUTOMATION_CREATE_BATCH } from "../../../shared/automation/protocol";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { buildPatentLibraryGroups } from "../library/patent-library-groups";
import { StandardDialog } from "../shared/standard-dialog";

export function CreatePermissionSwitch({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange(enabled: boolean): void;
}) {
  return (
    <div className="authorization-scope__creation">
      <label className="authorization-create-control">
        <input
          type="checkbox"
          role="switch"
          aria-checked={enabled}
          aria-label="允许新建专利"
          checked={enabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="authorization-create-switch" aria-hidden="true" />
        <span>允许新建专利</span>
      </label>
      <span className="authorization-scope__status">每次最多 {AUTOMATION_CREATE_BATCH} 件</span>
    </div>
  );
}

export function CreationPermissionRequest() {
  return (
    <section className="authorization-creation-request" aria-label="Agent 请求的新建权限">
      <span className="authorization-creation-request__icon" aria-hidden="true">
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M12 12v6M9 15h6" />
        </svg>
      </span>
      <div>
        <span>Agent 请求</span>
        <strong>新建专利（控制）权限</strong>
      </div>
      <span className="authorization-creation-request__quota">
        每次最多 {AUTOMATION_CREATE_BATCH} 件
      </span>
    </section>
  );
}

export function requestedPatents(
  requested: AutomationAuthorizationRequest | undefined,
  patents: LibraryPatentSummary[],
) {
  const byId = new Map(patents.filter((p) => !p.deletedAt).map((p) => [p.patentId, p]));
  const byName = new Map<string, LibraryPatentSummary[]>();
  for (const patent of byId.values()) {
    if (patent.name) byName.set(patent.name, [...(byName.get(patent.name) ?? []), patent]);
  }
  return (requested?.patents ?? []).map((request) => {
    const identified = request.patentId ? byId.get(request.patentId) : undefined;
    const matches = request.patentId
      ? identified
        ? [identified]
        : []
      : (byName.get(request.name ?? "") ?? []);
    return {
      request,
      patent: matches.length === 1 ? matches[0] : undefined,
      ambiguous: matches.length > 1,
    };
  });
}

export function AuthorizationScopeEditor({
  scope,
  patents,
  requested,
  onChange,
  onChoosePatents,
}: {
  scope: AutomationScope;
  patents: LibraryPatentSummary[];
  requested?: AutomationAuthorizationRequest | undefined;
  onChange(scope: AutomationScope): void;
  onChoosePatents(): void;
}) {
  const selected = patents.filter((p) => !p.deletedAt && scope.patents[p.patentId]);
  const globalCount = Object.keys(scope.global ?? {}).length;
  const globalEntries = Object.entries(AUTOMATION_GLOBAL_DOMAINS);
  const levels = globalEntries.map(
    ([domain]) => scope.global?.[domain as keyof typeof AUTOMATION_GLOBAL_DOMAINS] ?? "none",
  );
  const bulkLevel = levels.every((level) => level === levels[0]) ? levels[0] : "custom";
  return (
    <div className="authorization-scope">
      {(requested?.createLimit ?? 0) > 0 ? <CreationPermissionRequest /> : null}
      <section aria-label="本次专利授权" className="authorization-scope__patent-summary">
        <h3>专利授权</h3>
        <div className="authorization-scope__patent-actions">
          <button
            type="button"
            className="authorization-secondary-button authorization-patent-choose"
            onClick={onChoosePatents}
          >
            {selected.length ? "选择 / 调整专利" : "从专利库选择"}
          </button>
          <span className="authorization-scope__status">
            {selected.length ? `已选 ${selected.length} 件` : "未授权"}
          </span>
        </div>
      </section>
      <details className="authorization-scope__global">
        <summary>
          全局设置授权<span>{globalCount ? `已选 ${globalCount} 项` : "未授权"}</span>
        </summary>
        <label className="authorization-patent-row authorization-global-bulk">
          <span>批量设置</span>
          <select
            aria-label="批量设置全局权限"
            value={bulkLevel}
            onChange={(event) => {
              const level = event.target.value;
              if (level === "custom") return;
              const global: NonNullable<AutomationScope["global"]> = {};
              if (level !== "none")
                for (const [domain] of globalEntries)
                  global[domain as keyof typeof AUTOMATION_GLOBAL_DOMAINS] = level as
                    | "read"
                    | "full";
              onChange({ ...scope, global });
            }}
          >
            <option value="none">全部无权限</option>
            <option value="read">全部只读</option>
            <option value="full">全部完整权限</option>
            <option value="custom" disabled>
              自定义
            </option>
          </select>
        </label>
        {globalEntries.map(([domain, label]) => (
          <label key={domain} className="authorization-patent-row">
            <span>
              {label}
              {requested?.global?.[domain as keyof typeof AUTOMATION_GLOBAL_DOMAINS]
                ? "（申请）"
                : ""}
            </span>
            <select
              aria-label={`全局权限 ${label}`}
              value={scope.global?.[domain as keyof typeof AUTOMATION_GLOBAL_DOMAINS] ?? "none"}
              onChange={(e) => {
                const global = { ...scope.global };
                const key = domain as keyof typeof AUTOMATION_GLOBAL_DOMAINS;
                if (e.target.value === "none") delete global[key];
                else global[key] = e.target.value as "read" | "full";
                onChange({ ...scope, global });
              }}
            >
              <option value="none">无权限</option>
              <option value="read">只读</option>
              <option value="full">完整权限</option>
            </select>
          </label>
        ))}
      </details>
    </div>
  );
}

export function AuthorizationPatentPicker({
  patents,
  selected,
  requested,
  open = true,
  onCancel,
  onConfirm,
}: {
  patents: LibraryPatentSummary[];
  selected: AutomationScope["patents"];
  requested?: AutomationAuthorizationRequest | undefined;
  open?: boolean;
  onCancel(): void;
  onConfirm(patents: AutomationScope["patents"]): void;
}) {
  const active = patents.filter((p) => !p.deletedAt);
  const requests = requestedPatents(requested, patents);
  const requestById = new Map(
    requests.flatMap((r) => (r.patent ? [[r.patent.patentId, r.request] as const] : [])),
  );
  const activeIds = new Set(active.map((p) => p.patentId));
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(Object.entries(selected).filter(([id]) => activeIds.has(id))),
  );
  const activeRef = useRef(activeIds);
  activeRef.current = activeIds;
  useEffect(() => {
    if (open)
      setDraft(
        Object.fromEntries(Object.entries(selected).filter(([id]) => activeRef.current.has(id))),
      );
  }, [open, selected]);
  const [search, setSearch] = useState("");
  const [permission, setPermission] = useState<"read" | "full">("full");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const filtered = active.filter((p) =>
    `${p.name ?? ""} ${p.customer ?? ""}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const groups = buildPatentLibraryGroups(filtered, new Date(), !!search.trim());
  const allChecked = filtered.length > 0 && filtered.every((p) => draft[p.patentId]);
  const update = (ids: string[], checked: boolean) => {
    const next = { ...draft };
    for (const id of ids)
      if (checked) next[id] ??= permission;
      else delete next[id];
    if (Object.keys(next).length > 10000) {
      setError("最多选择 10000 件专利，请缩小范围。");
      return;
    }
    setError("");
    setDraft(next);
  };
  return (
    <StandardDialog
      open={open}
      title="选择授权专利"
      subtitle={`已选择 ${Object.keys(draft).length} 件`}
      size="l"
      onCancel={onCancel}
      className="authorization-patent-picker"
      footer={
        <>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary-button" onClick={() => onConfirm(draft)}>
            确定选择
          </button>
        </>
      }
    >
      {requests
        .filter((r) => !r.patent)
        .slice(0, 5)
        .map(({ request, ambiguous }, index) => (
          <div
            key={request.patentId ?? `${request.name}-${index}`}
            className="authorization-scope__unmatched"
          >
            <span>{request.name ?? request.patentId}</span>
            <span>{ambiguous ? "同名专利，请选择具体专利" : "未找到可授权专利"}</span>
          </div>
        ))}
      <div className="authorization-picker-toolbar">
        <input
          type="search"
          aria-label="搜索授权专利"
          placeholder="搜索专利名称或客户"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label>
          新增选择权限{" "}
          <select
            aria-label="新增选择权限"
            value={permission}
            onChange={(e) => setPermission(e.target.value as "read" | "full")}
          >
            <option value="full">完整权限</option>
            <option value="read">只读参考</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={(e) =>
              update(
                filtered.map((p) => p.patentId),
                e.target.checked,
              )
            }
          />
          {search.trim() ? "全选搜索结果" : "全选"}
        </label>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="authorization-picker-library">
        {groups.map((group) => (
          <section key={group.key}>
            <div className="authorization-picker-month">
              <input
                type="checkbox"
                aria-label={`全选 ${group.label}`}
                checked={group.patents.every((p) => !!draft[p.patentId])}
                onChange={(e) =>
                  update(
                    group.patents.map((p) => p.patentId),
                    e.target.checked,
                  )
                }
              />
              <button
                type="button"
                aria-expanded={expanded[group.key] ?? group.defaultExpanded}
                onClick={() =>
                  setExpanded({
                    ...expanded,
                    [group.key]: !(expanded[group.key] ?? group.defaultExpanded),
                  })
                }
              >
                {(expanded[group.key] ?? group.defaultExpanded) ? (
                  <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
                )}
                {group.label}
                <span>{group.patents.length} 项</span>
              </button>
            </div>
            {(expanded[group.key] ?? group.defaultExpanded) ? (
              <div className="authorization-picker-cards">
                {group.patents.slice(0, visibleCounts[group.key] ?? 100).map((patent) => (
                  <article
                    key={patent.patentId}
                    className="authorization-picker-card"
                    data-selected={!!draft[patent.patentId]}
                  >
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${patent.name ?? patent.patentId}`}
                        checked={!!draft[patent.patentId]}
                        onChange={(e) => update([patent.patentId], e.target.checked)}
                      />
                      <span>
                        <strong>{patent.name ?? "未命名专利"}</strong>
                        {requestById.has(patent.patentId) ? (
                          <small className="authorization-scope__request-access">
                            Agent 申请
                            {requestById.get(patent.patentId)?.access === "read"
                              ? "只读参考"
                              : "完整权限"}
                          </small>
                        ) : null}
                        <small>
                          {patent.patentType === "utility-model" ? "实用新型" : "发明专利"}
                          {patent.customer ? ` · ${patent.customer}` : ""}
                        </small>
                      </span>
                    </label>
                    {draft[patent.patentId] ? (
                      <select
                        aria-label={`所选权限 ${patent.name ?? patent.patentId}`}
                        value={draft[patent.patentId]}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            [patent.patentId]: e.target.value as "read" | "full",
                          })
                        }
                      >
                        <option value="full">完整权限</option>
                        <option value="read">只读参考</option>
                      </select>
                    ) : null}
                  </article>
                ))}
                {group.patents.length > (visibleCounts[group.key] ?? 100) ? (
                  <button
                    type="button"
                    className="authorization-text-button"
                    onClick={() =>
                      setVisibleCounts({
                        ...visibleCounts,
                        [group.key]: (visibleCounts[group.key] ?? 100) + 100,
                      })
                    }
                  >
                    显示更多（已显示 {visibleCounts[group.key] ?? 100} / {group.patents.length}）
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        ))}
        {!filtered.length ? (
          <p className="authorization-picker-empty">
            {search ? "没有匹配的专利" : "没有可授权的专利"}
          </p>
        ) : null}
      </div>
    </StandardDialog>
  );
}

export function AuthorizationNotice({
  open = true,
  agreed,
  onCancel,
  onAgree,
}: {
  agreed: boolean;
  open?: boolean;
  onCancel(): void;
  onAgree(): void;
}) {
  const [checked, setChecked] = useState(agreed);
  useEffect(() => {
    if (open) setChecked(agreed);
  }, [open, agreed]);
  return (
    <StandardDialog
      open={open}
      title="Agent 用户授权须知"
      size="m"
      onCancel={onCancel}
      className="authorization-notice"
      footer={
        <>
          <button type="button" onClick={onCancel}>
            返回
          </button>
          <button type="button" className="primary-button" disabled={!checked} onClick={onAgree}>
            同意并返回
          </button>
        </>
      }
    >
      <ol>
        <li>
          <strong>授权范围由你决定。</strong>
          未授权专利不能访问；只读参考不能修改；完整权限允许在所选专利内连续操作，无需逐步确认。
        </li>
        <li>
          <strong>新建专利。</strong>开启新建权限后，Agent 每次获准最多新建 5
          件，超过剩余额度必须再次请求用户授权；新一轮不累加旧的剩余额度。新建专利自动获得完整权限；其他专利不会因此获得授权。
        </li>
        <li>
          <strong>修改与恢复。</strong>
          完整权限包含编辑、整书改写、历史恢复和移入回收站。软件按现有机制保存恢复点；回收站专利必须先由用户恢复才能再操作。
        </li>
        <li>
          <strong>AI 服务与数据。</strong>完整权限允许使用软件已配置的 AI
          服务发送所选专利内容，软件联网开关继续生效。请确认你接受该服务的数据处理方式。
        </li>
        <li>
          <strong>全局设置授权。</strong>
          按域单独选择，可能影响全局配置及其他文档；专利权限不包含全局权限。
        </li>
        <li>
          <strong>文件位置。</strong>导入、导出使用独立工作区。自定义位置在实际操作时由 Agent
          询问，并由你在软件中确认，Agent 不能自行扩展目录访问范围。
        </li>
        <li>
          <strong>撤销与实验功能。</strong>可在设置中撤销授权；关闭软件或 Agent CLI
          后授权失效。Agent CLI 为实验功能，请核对实际操作结果。拥有本机文件权限的 Agent
          仍受其自身权限控制，CLI 授权不能代替系统沙箱。
        </li>
      </ol>
      <label className="authorization-notice__agreement">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        我已阅读并同意以上授权须知
      </label>
    </StandardDialog>
  );
}
