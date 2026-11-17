import { preload } from "react-dom";
import { Fragment } from "react";
import { platformShortcut } from "../../../shared/platform";
import type { ShortcutSettings } from "../../../shared/settings/shortcuts";
import logo from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./clear-format-help.css";
import "./reference-number-help.css";
export const SEQUENTIAL_HELP_TARGET =
  '.patent-global-function-rail-slot [data-numbering-help="sequential"]:not(:disabled)';
export const CUSTOM_NUMBER_HELP_TARGET =
  '.patent-global-function-rail-slot [data-numbering-help="custom"]:not(:disabled):not([aria-expanded="true"])';
export const REFERENCE_NUMBER_HELP_TARGET = [
  SEQUENTIAL_HELP_TARGET,
  CUSTOM_NUMBER_HELP_TARGET,
].join(",");
type PanelProps = {
  detailed: boolean;
  onToggle: () => void;
  shortcut: string;
  bookKind?: "claims" | "description";
};
function HelpFooter({ detailed, onToggle, shortcut }: PanelProps) {
  return (
    <footer className="panel-footer">
      <p>快捷键：{platformShortcut(shortcut || "未设置")}</p>
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
  );
}
export function ReferenceNumberHelp({ settings }: { settings: ShortcutSettings }) {
  preload(logo, { as: "image" });
  return (
    <>
      {(["claims", "description"] as const).map((bookKind) => {
        const context =
          bookKind === "description"
            ? '[data-numbering-book-kind="description"]'
            : ':not([data-numbering-book-kind="description"])';
        return (
          <Fragment key={bookKind}>
            <FloatingHelp
              target={SEQUENTIAL_HELP_TARGET + context}
              ariaLabel="顺序编号说明"
              className="clear-format-help reference-number-help"
              renderPanel={(detailed, onToggle) => (
                <SequentialPanel
                  bookKind={bookKind}
                  detailed={detailed}
                  onToggle={onToggle}
                  shortcut={settings["assign-reference-number"] || ""}
                />
              )}
            />
            <FloatingHelp
              target={CUSTOM_NUMBER_HELP_TARGET + context}
              ariaLabel="自定义编号说明"
              className="clear-format-help reference-number-help"
              renderPanel={(detailed, onToggle) => (
                <CustomPanel
                  bookKind={bookKind}
                  detailed={detailed}
                  onToggle={onToggle}
                  shortcut={settings["assign-custom-reference-number"] || ""}
                />
              )}
            />
          </Fragment>
        );
      })}
    </>
  );
}
function SequentialPanel({ detailed, onToggle, shortcut, bookKind = "claims" }: PanelProps) {
  const description = bookKind === "description";
  return (
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
            <path d="M11 5h10M11 12h10M11 19h10M4 4h1v5M4 9h2M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02" />
          </svg>
          顺序编号
        </h2>
        <p>
          {description
            ? "功能：为具体实施方式中的关键词接续编号，不加括号，并登记到附图标记"
            : "功能：为选中的关键词自动接续编号，并登记到附图标记"}
        </p>
      </header>
      {detailed && (
        <div className="details">
          <h3 className="example-heading">编号示例：</h3>
          <div className="registry">
            附图标记已登记<span>底座 · 1</span>
            <span>支撑杆 · 2</span>
          </div>
          <div className="number-comparison">
            <div className="sample">
              <h4>编号前</h4>
              <p>
                所述<mark>限位块</mark>设置在
                <span className="keyword-block">{description ? "底座1" : "底座(1)"}</span>上。
              </p>
            </div>
            <div className="sample-arrow" aria-hidden="true">
              →
            </div>
            <div className="sample">
              <h4>编号后</h4>
              <p>
                所述
                <span className="keyword-block recent">
                  {description ? "限位块3" : "限位块(3)"}
                </span>
                设置在
                <span className="keyword-block">{description ? "底座1" : "底座(1)"}</span>上。
              </p>
            </div>
          </div>
          <div className="registry-result">
            <span>新增附图标记</span>
            <strong>限位块 · 3</strong>
          </div>
          <p className="usage">
            <strong>使用：</strong>
            {description
              ? "在具体实施方式正文中选中关键词，再点击“顺序编号”；其他章节不变。"
              : "在权利要求书中选中关键词，再点击“顺序编号”。"}
          </p>
          <p className="footnote">新关键词从上次登记的编号接续，跳过已占用编号。</p>
        </div>
      )}
      <HelpFooter detailed={detailed} onToggle={onToggle} shortcut={shortcut} />
    </>
  );
}
function CustomPanel({ detailed, onToggle, shortcut, bookKind = "claims" }: PanelProps) {
  const description = bookKind === "description";
  return (
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
            <path d="M13 21h8m-6-16 4 4M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
          </svg>
          自定义编号
        </h2>
        <p>
          {description
            ? "功能：为具体实施方式中的关键词指定无括号编号，并登记到附图标记"
            : "功能：为选中的关键词指定编号，并登记到附图标记"}
        </p>
      </header>
      {detailed && (
        <div className="details">
          <h3 className="example-heading">编号示例：</h3>
          <div className="registry">
            附图标记已登记<span>底座 · 1</span>
            <span>支撑杆 · 2</span>
          </div>
          <div className="custom-comparison">
            <div className="sample">
              <h4>编号前</h4>
              <p style={{ color: "#24272c" }}>
                所述<mark>限位块</mark>设置在
                <span className="keyword-block">{description ? "底座1" : "底座(1)"}</span>上。
              </p>
            </div>
            <div className="custom-value">
              输入自定义编号<strong>10</strong>
              <span>并确认</span>
            </div>
            <div className="sample">
              <h4>编号后</h4>
              <p style={{ color: "#24272c" }}>
                所述
                <span className="keyword-block recent">
                  {description ? "限位块10" : "限位块(10)"}
                </span>
                设置在
                <span className="keyword-block">{description ? "底座1" : "底座(1)"}</span>上。
              </p>
            </div>
          </div>
          <div className="registry-result">
            <span>新增附图标记</span>
            <strong>限位块 · 10</strong>
          </div>
          <p className="usage">
            <strong>使用：</strong>
            {description
              ? "在具体实施方式正文中选中关键词，点击“自定义编号”，输入数字后确认；其他章节不变。"
              : "在权利要求书中选中关键词，点击“自定义编号”，输入数字后确认。"}
          </p>
          <p className="footnote">适合需要指定编号的情况，如按部件分组编号。</p>
        </div>
      )}
      <HelpFooter detailed={detailed} onToggle={onToggle} shortcut={shortcut} />
    </>
  );
}
