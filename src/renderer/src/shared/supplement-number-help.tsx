import { CirclePlus } from "lucide-react";
import { platformShortcut } from "../../../shared/platform";
import type { ShortcutSettings } from "../../../shared/settings/shortcuts";
import logo from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./clear-format-help.css";
import "./supplement-number-help.css";

export const SUPPLEMENT_NUMBER_HELP_TARGET =
  ".patent-global-function-rail-slot .patent-book-tools__supplement-reference-numbers, .patent-global-function-rail-slot .patent-book-tools__supplement-claims-numbers";

export function SupplementNumberHelp({ settings }: { settings: ShortcutSettings }) {
  return (
    <>
      <SupplementPanelHelp settings={settings} claims={false} />
      <SupplementPanelHelp settings={settings} claims />
    </>
  );
}

function SupplementPanelHelp({
  settings,
  claims,
}: {
  settings: ShortcutSettings;
  claims: boolean;
}) {
  return (
    <FloatingHelp
      target={`.patent-global-function-rail-slot .patent-book-tools__supplement-${claims ? "claims" : "reference"}-numbers:not(:disabled)`}
      ariaLabel={claims ? "权利要求书增补编号说明" : "增补编号说明"}
      className="clear-format-help supplement-number-help"
      renderPanel={(detailed, onToggle) => (
        <>
          <div className="brand-corner" aria-hidden="true">
            <img src={logo} alt="" />
          </div>
          <header className="panel-header">
            <h2>
              <CirclePlus size={22} strokeWidth={1.5} aria-hidden="true" />
              增补编号
            </h2>
            <p>
              功能：
              {claims
                ? "为权利要求书中已登记的关键词补上遗漏的附图标记编号"
                : "为“具体实施方式”中已登记的关键词补上遗漏编号"}
            </p>
          </header>
          {detailed && (
            <div className="supplement-number-help__details">
              <h3 className="example-heading">增补示例：</h3>
              <div className="supplement-number-help__registry">
                附图标记已登记
                <span>底座 · 1</span>
                <span>支撑杆 · 2</span>
              </div>
              <section className="supplement-number-help__sample" aria-label="增补前示意">
                <h4>增补前</h4>
                {claims ? (
                  <p>
                    1. 一种支架，包括<span className="supplement-number-help__token">底座(1)</span>
                    ，其特征在于，支撑杆设置在所述底座上。
                  </p>
                ) : (
                  <p>支撑杆安装在底座1上，底座用于承托工件。</p>
                )}
              </section>
              <div className="supplement-number-help__arrow" aria-hidden="true">
                ↓
              </div>
              <section className="supplement-number-help__sample" aria-label="增补后示意">
                <h4>增补后</h4>
                {claims ? (
                  <p>
                    1. 一种支架，包括<span className="supplement-number-help__token">底座(1)</span>
                    ，其特征在于，<span className="supplement-number-help__token">支撑杆(2)</span>
                    设置在所述<span className="supplement-number-help__token">底座(1)</span>上。
                  </p>
                ) : (
                  <p>
                    <em>支撑杆2</em>安装在底座1上，<em>底座1</em>用于承托工件。
                  </p>
                )}
              </section>
              <p
                className={
                  claims ? "supplement-number-help__usage" : "supplement-number-help__sample-note"
                }
              >
                {claims
                  ? "补充的是关键词后的附图标记，不是权利要求条号；已有正确编号保持不变。"
                  : "增补的关键词与编号一起显示为紫色，已有编号的词组保持不变。"}
              </p>
              <p className="supplement-number-help__usage">
                <strong>使用：</strong>
                {claims
                  ? "先在附图标记中登记关键词，再点击“增补编号”，检查整份权利要求书，无需选中文字。"
                  : "补写正文后点击“增补编号”，自动检查该章节，无需选中文字。"}
              </p>
            </div>
          )}
          <footer className="panel-footer">
            <p>快捷键：{platformShortcut(settings["supplement-reference-numbers"] || "未设置")}</p>
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
