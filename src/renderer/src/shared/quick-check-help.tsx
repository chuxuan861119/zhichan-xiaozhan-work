import { ArrowRight, FileSearch, ListChecks, LocateFixed, ScanText } from "lucide-react";
import { platformShortcut } from "../../../shared/platform";
import type { ShortcutSettings } from "../../../shared/settings/shortcuts";
import logoOutline from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./quick-check-help.css";

export const QUICK_CHECK_HELP_TARGET =
  ".patent-global-function-rail-slot .patent-book-tools__problem-check-button:not(:disabled):not([aria-disabled='true']), .tool-bar button[aria-label='本地检查']:not(:disabled):not([aria-disabled='true'])";

export function QuickCheckHelp({ settings }: { settings: ShortcutSettings }) {
  return (
    <FloatingHelp
      target={QUICK_CHECK_HELP_TARGET}
      ariaLabel="本地检查说明"
      className="quick-check-help"
      renderPanel={(detailed, onToggle) => (
        <QuickCheckPanel
          detailed={detailed}
          shortcut={settings["check-problems"]}
          onToggle={onToggle}
        />
      )}
    />
  );
}

function QuickCheckPanel({
  detailed,
  shortcut,
  onToggle,
}: {
  detailed: boolean;
  shortcut: string | null;
  onToggle: () => void;
}) {
  return (
    <>
      <div className="quick-check-help__brand" aria-hidden="true">
        <img src={logoOutline} alt="" />
      </div>
      <header className="quick-check-help__header">
        <h2>
          <FileSearch size={22} strokeWidth={1.5} />
          本地检查
        </h2>
        <p>功能：检查当前专利，找出文字、编号与标点等常见格式性问题</p>
      </header>
      {detailed ? (
        <div className="quick-check-help__details">
          <section>
            <h3>检查什么</h3>
            <p>
              文字与编号 · 引用与章节 · 附图与标记
              <br />
              数值、公式与表格等常见问题
            </p>
          </section>
          <section>
            <h3>如何使用</h3>
            <div className="quick-check-help__flow">
              <div>
                <ScanText aria-hidden="true" />
                <strong>全文检查</strong>
                <span>打开面板后点击</span>
              </div>
              <ArrowRight className="quick-check-help__flow-arrow" aria-hidden="true" />
              <div>
                <ListChecks aria-hidden="true" />
                <strong>查看结果</strong>
                <span>错误、警告、建议</span>
              </div>
              <ArrowRight className="quick-check-help__flow-arrow" aria-hidden="true" />
              <div>
                <LocateFixed aria-hidden="true" />
                <strong>定位核对</strong>
                <span>前往对应文档处理</span>
              </div>
            </div>
          </section>
          <p className="quick-check-help__boundary">
            仅提示问题，不自动修改正文；修改后请重新检查。
          </p>
        </div>
      ) : null}
      <footer className="quick-check-help__footer">
        <p>快捷键：{platformShortcut(shortcut || "未设置")}</p>
        <span className="quick-check-help__detail-control">
          <span>详细介绍</span>
          <button
            type="button"
            role="switch"
            aria-checked={detailed}
            aria-label="详细介绍"
            className="quick-check-help__detail-switch"
            onClick={onToggle}
          >
            <span />
          </button>
        </span>
      </footer>
    </>
  );
}
