import { useEffect, useId, useRef, useState } from "react";
import policy from "../../../../resources/legal-policies.json";
import channel from "../../../../resources/usage-statistics-channel.json";
import { APPLICATION_VERSION } from "../../../shared/branding";
import type { AgreementState } from "../../../shared/legal/model";
import { LEGAL_TITLES, type LegalDocument, legalSections } from "../../../shared/legal/policies";
import { isNetworkAiAvailable } from "../../../shared/platform";
import { UsageStatisticsSettings } from "../settings/usage-statistics-settings";
import { StandardDialog } from "../shared/standard-dialog";
import "../shared/standard-dialog.css";
import "./agreement-gate.css";

const bundledState: AgreementState = {
  appVersion: APPLICATION_VERSION,
  policy,
  needsConfirmation: false,
  reason: "none",
  showStatistics: false,
  statistics: {
    enabled: false,
    accepted: false,
    available: false,
    status: "unconfigured",
    message: "",
    noticeVersion: channel.noticeVersion,
    lastAttempt: null,
    disclosure: channel.disclosure,
  },
};

/** Startup policy viewing stays read-only; Help embeds the existing statistics choice. */
export function LegalPolicyDialog({
  document: requested,
  state,
  onClose,
  returnLabel = "关闭",
}: {
  document: LegalDocument | null;
  state?: AgreementState | null;
  onClose(): void;
  returnLabel?: string;
}) {
  const retainedDocument = useRef<LegalDocument>("terms");
  if (requested !== null) retainedDocument.current = requested;
  const document = retainedDocument.current;
  const [liveState, setLiveState] = useState(bundledState);
  const [warning, setWarning] = useState("");
  const sectionPrefix = useId();
  useEffect(() => {
    if (requested === null || state !== undefined) return;
    let current = true;
    setWarning("");
    void (async () => {
      try {
        const api = window.patentApi;
        if (api?.agreements) {
          const result = await api.agreements.read();
          if (!result.ok) throw new Error("unavailable");
          if (current) setLiveState(result.value);
        } else if (api?.usageStatistics) {
          const result = await api.usageStatistics.read();
          if (!result.ok) throw new Error("unavailable");
          if (current) setLiveState({ ...bundledState, statistics: result.value });
        }
      } catch {
        if (current) setWarning("暂未读取到当前配置，以下显示随软件提供的离线协议正文。");
      }
    })();
    return () => {
      current = false;
    };
  }, [requested, state]);
  const resolvedState = state ?? liveState;
  const sections = legalSections(document, resolvedState);
  const version =
    document === "terms"
      ? resolvedState.policy.termsVersion
      : document === "privacy"
        ? resolvedState.policy.privacyVersion
        : (resolvedState.statistics?.noticeVersion ?? "待配置");
  return (
    <StandardDialog
      open={requested !== null}
      title={LEGAL_TITLES[document]}
      subtitle={`版本 ${version}`}
      size="l"
      portal
      className="consent-reader"
      onCancel={onClose}
      footer={
        <button type="button" className="primary-button" onClick={onClose}>
          {returnLabel}
        </button>
      }
    >
      {!isNetworkAiAvailable() ? (
        <p className="consent-publication-note">
          鸿蒙首发版本暂未开放联网 AI 功能；以下涉及 AI 的条款适用于提供该功能的版本。
        </p>
      ) : null}
      {warning ? (
        <p className="consent-publication-note" role="status">
          {warning}
        </p>
      ) : null}
      {!resolvedState.policy.operator || !resolvedState.policy.contact ? (
        <p className="consent-publication-note">
          软件提供方名称及正式联系方式尚待发布前补充。统计服务未开放时不会计时或上报。
        </p>
      ) : null}
      <nav className="consent-contents" aria-label="协议目录">
        {sections.map((section, index) => (
          <button
            type="button"
            key={section.title}
            onClick={() =>
              window.document
                .getElementById(`${sectionPrefix}-${index}`)
                ?.scrollIntoView({ block: "start" })
            }
          >
            {index + 1}. {section.title}
          </button>
        ))}
      </nav>
      <article>
        {sections.map((section, index) => (
          <section
            key={section.title}
            id={`${sectionPrefix}-${index}`}
            className={section.important ? "consent-important" : undefined}
          >
            <h3>
              {index + 1}. {section.title}
            </h3>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {document === "terms" && section.title === "使用统计" && state === undefined ? (
              <UsageStatisticsSettings embedded />
            ) : null}
          </section>
        ))}
      </article>
    </StandardDialog>
  );
}
