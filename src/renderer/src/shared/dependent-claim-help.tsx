import { platformShortcut } from "../../../shared/platform";
import type { ShortcutSettings } from "../../../shared/settings/shortcuts";
import logo from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./clear-format-help.css";
import "./dependent-claim-help.css";

export const DEPENDENT_CLAIM_HELP_TARGET =
  ".patent-global-function-rail-slot .patent-book-tools__insert-dependent-claim:not(:disabled)";

export function DependentClaimHelp({ settings }: { settings: ShortcutSettings }) {
  return (
    <FloatingHelp
      target={DEPENDENT_CLAIM_HELP_TARGET}
      ariaLabel="插入从权说明"
      className="clear-format-help dependent-claim-help"
      renderPanel={(detailed, onToggle) => (
        <>
          <div className="brand-corner" aria-hidden="true">
            <img src={logo} alt="" />
          </div>
          <header className="panel-header">
            <h2>
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 4h12M8 9h12M8 14h5M3 4h.01M3 9h.01M3 14h.01M17 14v7M13.5 17.5h7" />
              </svg>
              插入从权
            </h2>
            <p>功能：在当前“光标处”权利要求后插入一条从属权利要求，其他权利要求编号做适应性调整</p>
          </header>
          {detailed && (
            <div className="dependent-claim-help__details">
              <h3 className="example-heading">插入示例：</h3>
              <section className="claim-sample" aria-label="插入前示意">
                <h4>插入前</h4>
                <p>
                  1. 一种支撑装置，包括底座
                  <span className="claim-caret" aria-hidden="true" />
                  和支撑杆……<span className="claim-tag">光标所在项</span>
                </p>
                <p>2. 根据权利要求1所述的支撑装置，……</p>
                <p>3. 根据权利要求2所述的支撑装置，……</p>
              </section>
              <div className="claim-arrow" aria-hidden="true">
                ↓
              </div>
              <section className="claim-sample" aria-label="插入后示意">
                <h4>插入后</h4>
                <p>1. 一种支撑装置，包括底座和支撑杆……</p>
                <p className="claim-new">
                  <em>2.</em> 根据权利要求1所述的支撑装置，其特征在于：
                  <span className="claim-caret" aria-hidden="true" />
                  <span className="claim-tag">新增从权</span>
                </p>
                <p>
                  <em>3.</em> 根据权利要求1所述的支撑装置，……
                  <span className="claim-tag">原第2项</span>
                </p>
                <p>
                  <em>4.</em> 根据权利要求<em>3</em>所述的支撑装置，……
                  <span className="claim-tag">原第3项 · 引用同步调整</span>
                </p>
              </section>
              <p className="claim-usage">
                <strong>使用：</strong>
                将光标放入要引用的权利要求，点击“插入从权”，继续填写新增的技术特征。
              </p>
              <p className="claim-usage claim-note">
                新从权默认引用当前项，光标自动移到新段落末尾。
              </p>
            </div>
          )}
          <footer className="panel-footer">
            <p>快捷键：{platformShortcut(settings["insert-dependent-claim"] || "未设置")}</p>
            <span className="detail-control">
              <span>详细介绍</span>
              <button
                type="button"
                role="switch"
                aria-label="详细介绍"
                aria-checked={detailed}
                className="detail-switch"
                onClick={onToggle}
              >
                <span />
              </button>
            </span>
          </footer>
        </>
      )}
    />
  );
}
