import { ShieldCheck } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { PATENT_BOOK_LABELS } from "../../../shared/patent/model";
import type {
  InspectionIssue,
  PatentInspectionReport,
} from "../../../shared/patent-inspection/types";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";
import {
  type CheckPriority,
  checkIssuePriority,
  conciseIssueSummary,
  groupCheckIssues,
  issueRecommendation,
} from "./patent-check-groups";
import "./patent-check-groups.css";
import "./patent-check-panel.css";

export type PatentCheckPhase = "ready" | "running" | "result";

type ReportProps = {
  phase: PatentCheckPhase;
  report: PatentInspectionReport | null;
  stale: boolean;
  patentName?: string;
  refreshing?: boolean;
  onRun(): void;
  onRecheck(): void;
  onCancel?(): void;
  onLocate(issue: InspectionIssue): void;
  onClose(): void;
};

type ResultProps = {
  report: PatentInspectionReport;
  stale: boolean;
  patentName?: string;
  refreshing?: boolean;
  onRecheck(): void;
  onCancel?(): void;
  onLocate(issue: InspectionIssue): void;
};

type CheckFilter = "all" | "claims" | "description" | "drawings" | "abstract" | "export";

const filters: ReadonlyArray<{ id: CheckFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "claims", label: "权利要求" },
  { id: "description", label: "说明书" },
  { id: "drawings", label: "附图" },
  { id: "abstract", label: "摘要" },
  { id: "export", label: "导出" },
];
const NO_IGNORED_ISSUES: ReadonlySet<string> = new Set();

const degradedRuleLabels: Readonly<Record<string, string>> = {
  engine: "检查引擎",
  "engine.facts": "基础检查数据",
  "core.assets.resource-health": "图片资源核验",
  "core.claims.reference-chain": "权利要求引用关系",
};

function degradedRuleLabel(ruleId: string): string {
  const exact = degradedRuleLabels[ruleId];
  if (exact) return exact;
  if (ruleId.startsWith("core.claims")) return "权利要求检查";
  if (ruleId.startsWith("core.drawings")) return "附图检查";
  if (ruleId.startsWith("core.reference-marks")) return "附图标记检查";
  if (ruleId.startsWith("core.numeric")) return "数值检查";
  if (ruleId.startsWith("core.formula")) return "公式检查";
  if (ruleId.startsWith("core.tables")) return "表格检查";
  if (ruleId.startsWith("core.description")) return "说明书章节检查";
  if (ruleId.startsWith("core.books")) return "文档完整性检查";
  if (ruleId.startsWith("core.abstract")) return "摘要检查";
  return "本地规则检查";
}

export function PatentCheckPanel(props: ReportProps) {
  const {
    phase,
    report,
    stale,
    patentName,
    refreshing = false,
    onRun,
    onRecheck,
    onCancel,
    onLocate,
    onClose,
  } = props;
  const showingResults = phase === "result" && report !== null;

  return (
    <aside
      className="assistant-side-panel patent-check-panel patent-check-panel--mint"
      aria-label="本地检查"
    >
      <header className="assistant-side-panel__header patent-check-panel__header">
        <div className="assistant-side-panel__header-title">
          <h2>本地检查</h2>
        </div>
        <div className="assistant-side-panel__header-actions">
          <button
            type="button"
            className="ai-icon-button dialog-close-button dialog-close-control"
            aria-label="关闭本地检查"
            onClick={onClose}
          >
            <DialogCloseIcon />
          </button>
        </div>
      </header>

      {!showingResults ? (
        phase === "ready" ? (
          <div className="assistant-side-panel__body patent-check-panel__launch">
            <div className="patent-check-panel__launch-icon" aria-hidden="true">
              <ShieldCheck size={28} strokeWidth={1.6} />
            </div>
            <h3>{patentName?.trim() || "未命名专利"}</h3>
            <p>检查全文、附图及标记。</p>
            <button type="button" className="patent-check-panel__primary" onClick={onRun}>
              全文检查
            </button>
          </div>
        ) : (
          <div className="assistant-side-panel__body patent-check-panel__running">
            <p role="status">正在检查全文…</p>
            {onCancel ? (
              <button type="button" className="patent-check-panel__recheck" onClick={onCancel}>
                停止检查
              </button>
            ) : null}
          </div>
        )
      ) : (
        <PatentCheckResults
          report={report}
          stale={stale}
          {...(patentName === undefined ? {} : { patentName })}
          refreshing={refreshing}
          onRecheck={onRecheck}
          {...(onCancel === undefined ? {} : { onCancel })}
          onLocate={onLocate}
        />
      )}
    </aside>
  );
}

function PatentCheckResults({
  report,
  stale,
  patentName,
  refreshing = false,
  onRecheck,
  onCancel,
  onLocate,
}: ResultProps) {
  const viewRef = useRef<HTMLDivElement>(null);
  const [activeFilter, setActiveFilter] = useState<CheckFilter>("all");
  const [priority, setPriority] = useState<CheckPriority | "all" | "focus">("focus");
  const [page, setPage] = useState(0);
  const reportKey = `${report.patentId}:${report.engineVersion}:${report.patentRevision}:${report.checkedAt}`;
  const [ignored, setIgnored] = useState<{ reportKey: string; keys: ReadonlySet<string> }>({
    reportKey,
    keys: new Set(),
  });
  const hidden = ignored.reportKey === reportKey ? ignored.keys : NO_IGNORED_ISSUES;
  const remaining = useMemo(
    () => report.issues.filter((issue) => !hidden.has(issue.fingerprint)),
    [report.issues, hidden],
  );
  const groups = useMemo(
    () => groupCheckIssues(remaining.filter((issue) => matchesFilter(issue, activeFilter))),
    [remaining, activeFilter],
  );
  const counts = { fix: 0, review: 0, suggestion: 0 };
  for (const group of groups) counts[checkIssuePriority(group.issue)]++;
  const activePriority =
    priority === "focus"
      ? counts.fix > 0
        ? "fix"
        : counts.review > 0
          ? "review"
          : "suggestion"
      : priority;
  const filteredIssues = useMemo(
    () =>
      groups.filter(
        (group) => activePriority === "all" || checkIssuePriority(group.issue) === activePriority,
      ),
    [activePriority, groups],
  );
  const lastPage = Math.max(0, Math.ceil(filteredIssues.length / 50) - 1);
  const currentPage = Math.min(page, lastPage);
  useSpatialViewMotion(viewRef, `${activeFilter}:${activePriority}:${currentPage}`);
  const visibleIssues = filteredIssues.slice(currentPage * 50, (currentPage + 1) * 50);
  const degraded = report.degradedRules.length > 0;
  const clean = report.issues.length === 0 && !stale && !degraded && report.mode === "full";

  const locate = (issue: InspectionIssue) => {
    onLocate(issue);
  };

  return (
    <>
      <div ref={viewRef} className="assistant-side-panel__body patent-check-panel__body">
        <p className="patent-check-panel__meta">
          <strong>{patentName?.trim() || "未命名专利"}</strong>
          <span>检查于 {new Date(report.checkedAt).toLocaleString("zh-CN")}</span>
        </p>
        <section className="patent-check-panel__summary" aria-label="检查结果摘要">
          <button
            type="button"
            className="patent-check-panel__total"
            aria-pressed={activePriority === "all"}
            onClick={() => {
              setPriority("all");
              setPage(0);
            }}
          >
            <strong>{groups.length} 项</strong>
            <span>全部结果</span>
          </button>
          {(
            [
              ["fix", "需处理"],
              ["review", "待核对"],
              ["suggestion", "写作建议"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-label={`${label} ${counts[id]}`}
              aria-pressed={activePriority === id}
              onClick={() => {
                setPriority(id);
                setPage(0);
              }}
            >
              <strong>{counts[id]}</strong>
              <span>{label}</span>
            </button>
          ))}
        </section>
        <p className="patent-check-panel__priority-note">
          {activePriority === "fix"
            ? "先处理这些明确的问题。"
            : activePriority === "review"
              ? "这些是待确认线索，请结合原文判断。"
              : activePriority === "suggestion"
                ? "这些建议可按写作需要选择处理。"
                : "按需处理、待核对、写作建议排序。"}
        </p>
        {hidden.size > 0 ? (
          <button
            type="button"
            className="patent-check-panel__restore"
            aria-label={`恢复已忽略的 ${hidden.size} 项`}
            onClick={() => setIgnored({ reportKey, keys: new Set() })}
          >
            已忽略 {hidden.size} 项 · 恢复
          </button>
        ) : null}

        {stale ? (
          <p className="patent-check-panel__notice">文档已修改，请重新检查。</p>
        ) : report.mode !== "full" ? (
          <p className="patent-check-panel__notice">当前为基础结果，请运行全文检查。</p>
        ) : null}
        {refreshing ? (
          <div className="patent-check-panel__refreshing">
            <p role="status">正在更新检查结果…</p>
            {onCancel ? (
              <button type="button" onClick={onCancel}>
                停止检查
              </button>
            ) : null}
          </div>
        ) : null}
        {degraded ? <p className="patent-check-panel__notice">部分检查未完成</p> : null}
        {report.degradedRules.length > 0 ? (
          <ul className="patent-check-panel__degraded" aria-label="未完成的检查项">
            {[
              ...new Map(
                report.degradedRules.map((rule) => [
                  rule.message === "该项检查未完成。" ? rule.ruleId : rule.message,
                  rule,
                ]),
              ).values(),
            ].map((rule) => (
              <li key={rule.ruleId}>
                <strong>{degradedRuleLabel(rule.ruleId)}</strong>
                <span>{rule.message}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="patent-check-panel__filters" role="tablist" aria-label="本地检查筛选">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={activeFilter === filter.id}
              onClick={() => {
                setActiveFilter(filter.id);
                setPage(0);
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {clean ? <p className="patent-check-panel__clean">当前检查范围内未发现问题</p> : null}
        {!clean && filteredIssues.length === 0 && report.issues.length > 0 ? (
          <p className="patent-check-panel__empty">
            {remaining.length === 0
              ? "本次结果已忽略，可恢复或重新检查。"
              : "当前分类没有结果，可切换其他分类。"}
          </p>
        ) : null}
        {filteredIssues.length > 0 ? (
          <ul>
            {visibleIssues.map(({ key, title, issue, members }) => {
              const location = issue.locations[0];
              const bookLabel =
                new Set(members.flatMap((item) => item.locations.map((loc) => loc.bookKind))).size >
                1
                  ? "多个文档"
                  : location?.metadataField
                    ? "专利设置"
                    : location
                      ? PATENT_BOOK_LABELS[location.bookKind]
                      : "专利文档";
              return (
                <li
                  key={key}
                  aria-label={`${bookLabel}：${title}`}
                  data-severity={issue.severity}
                  data-priority={checkIssuePriority(issue)}
                >
                  <div className="patent-check-panel__issue-header">
                    <span>{bookLabel}</span>
                    <small>{priorityLabel(checkIssuePriority(issue))}</small>
                  </div>
                  <p className="patent-check-panel__issue-title">{title}</p>
                  {issueRecommendation(issue) ? (
                    <p className="patent-check-panel__issue-recommendation">
                      {issueRecommendation(issue)}
                    </p>
                  ) : null}
                  {members.length === 1 && issue.evidence[0]?.excerpt ? (
                    <blockquote className="patent-check-panel__evidence">
                      {compactExcerpt(issue.evidence[0].excerpt)}
                    </blockquote>
                  ) : null}
                  {members.length > 1 ? (
                    <GroupedLocations members={members} onLocate={locate} />
                  ) : (
                    <IssueDetails issue={issue} title={title} />
                  )}
                  <div className="patent-check-panel__issue-actions">
                    {members.length === 1 ? (
                      <IssueLocations issue={issue} onLocate={locate} />
                    ) : null}
                    <button
                      type="button"
                      className="patent-check-panel__ignore"
                      disabled={stale || refreshing}
                      onClick={() =>
                        setIgnored({
                          reportKey,
                          keys: new Set([
                            ...hidden,
                            ...members.map((member) => member.fingerprint),
                          ]),
                        })
                      }
                    >
                      本次忽略
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {lastPage > 0 ? (
          <nav aria-label="检查结果分页">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </button>
            <span>
              第 {currentPage + 1} / {lastPage + 1} 页
            </span>
            <button
              type="button"
              disabled={currentPage === lastPage}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </button>
          </nav>
        ) : null}
      </div>
      <footer className="patent-check-panel__footer">
        <button className="patent-check-panel__recheck" type="button" onClick={onRecheck}>
          重新检查
        </button>
      </footer>
    </>
  );
}

function matchesFilter(issue: InspectionIssue, filter: CheckFilter): boolean {
  if (filter === "all") return true;
  if (filter === "export") return issue.category === "export";
  if (
    filter === "drawings" &&
    ["drawings", "reference-marks", "drawing-reference"].includes(issue.category)
  )
    return true;
  return issue.locations.some(({ bookKind }) => {
    if (filter === "drawings")
      return bookKind === "description-drawings" || bookKind === "abstract-drawing";
    if (filter === "abstract") return bookKind === "abstract" || bookKind === "abstract-drawing";
    return bookKind === filter;
  });
}

function IssueDetails({ issue, title }: { issue: InspectionIssue; title: string }) {
  const detail = conciseIssueSummary(issue, true);
  const fullRecommendation =
    issue.recommendation !== issueRecommendation(issue) ? issue.recommendation : null;
  const excerpt = issue.evidence[0]?.excerpt;
  const longExcerpt = excerpt && compactExcerpt(excerpt) !== excerpt.replace(/\s+/gu, " ").trim();
  if (title === detail && !fullRecommendation && !longExcerpt) return null;
  return (
    <details className="patent-check-group__details spatial-disclosure">
      <summary>查看详情</summary>
      {title !== detail ? <p>{detail}</p> : null}
      {fullRecommendation ? <p>{fullRecommendation}</p> : null}
      {longExcerpt ? (
        <blockquote className="patent-check-panel__evidence patent-check-panel__evidence--full">
          {excerpt}
        </blockquote>
      ) : null}
    </details>
  );
}

function IssueLocations({
  issue,
  onLocate,
}: {
  issue: InspectionIssue;
  onLocate(issue: InspectionIssue): void;
}) {
  return (
    <div className="patent-check-group__locations">
      {issue.locations.map((location, index) => {
        const picture =
          location.bookKind === "description-drawings" || location.bookKind === "abstract-drawing";
        const exact = location.startOffset !== undefined && location.endOffset !== undefined;
        const label = location.metadataField
          ? "前往专利设置"
          : picture
            ? "前往文档"
            : exact
              ? "定位文字"
              : location.targetId
                ? "前往段落"
                : "前往文档";
        return (
          <button
            type="button"
            key={`${location.bookKind}:${location.targetId}:${location.startOffset}:${location.endOffset}:${location.metadataField}`}
            onClick={() => {
              if (index === 0 && !picture) {
                onLocate(issue);
                return;
              }
              const evidence = issue.evidence.filter(
                (item) =>
                  item.location.bookKind === location.bookKind &&
                  item.location.targetId === location.targetId &&
                  item.location.startOffset === location.startOffset,
              );
              onLocate({
                ...issue,
                locations: [picture ? { ...location, targetId: null } : location],
                evidence,
              });
            }}
          >
            {label}
            {issue.locations.length > 1 ? ` ${index + 1}` : ""}
          </button>
        );
      })}
    </div>
  );
}

function GroupedLocations({
  members,
  onLocate,
}: {
  members: InspectionIssue[];
  onLocate(issue: InspectionIssue): void;
}) {
  const [limit, setLimit] = useState(20);
  return (
    <details className="patent-check-group__details spatial-disclosure">
      <summary>查看{members.length}处问题</summary>
      {members.slice(0, limit).map((member) => (
        <div key={member.fingerprint} className="patent-check-group__member">
          <small>
            {member.locations[0] ? PATENT_BOOK_LABELS[member.locations[0].bookKind] : "专利文档"}
          </small>
          <p>{conciseIssueSummary(member, true)}</p>
          {member.evidence[0]?.excerpt ? (
            <blockquote className="patent-check-panel__evidence">
              {compactExcerpt(member.evidence[0].excerpt)}
            </blockquote>
          ) : null}
          <IssueDetails issue={member} title={conciseIssueSummary(member, true)} />
          <IssueLocations issue={member} onLocate={onLocate} />
        </div>
      ))}
      {members.length > limit ? (
        <button type="button" onClick={() => setLimit(limit + 20)}>
          显示更多位置
        </button>
      ) : null}
    </details>
  );
}

function priorityLabel(priority: CheckPriority): string {
  return { fix: "需处理", review: "待核对", suggestion: "建议" }[priority];
}

function compactExcerpt(text: string): string {
  const value = text.replace(/\s+/gu, " ").trim();
  return value.length > 110 ? `${value.slice(0, 110)}…` : value;
}
