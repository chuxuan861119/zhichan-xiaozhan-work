import { ArrowRight, Eraser } from "lucide-react";
import { preload } from "react-dom";
import { platformShortcut } from "../../../shared/platform";
import type { ShortcutSettings } from "../../../shared/settings/shortcuts";
import after from "./clear-format-help-assets/after.png";
import before from "./clear-format-help-assets/before.png";
import logoOutline from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp, floatingHelpPosition } from "./floating-help";
import "./clear-format-help.css";

export const CLEAR_FORMAT_HELP_TARGET =
  ".patent-global-function-rail-slot .patent-book-tools__clear-extra-formatting:not(:disabled)";
export const clearFormatHelpPosition = floatingHelpPosition;
export function ClearFormatHelp({ settings }: { settings: ShortcutSettings }) {
  preload(before, { as: "image" });
  preload(after, { as: "image" });
  preload(logoOutline, { as: "image" });
  return (
    <FloatingHelp
      target={CLEAR_FORMAT_HELP_TARGET}
      ariaLabel="清除多余格式说明"
      className="clear-format-help"
      renderPanel={(detailed, onToggle) => (
        <HelpPanel
          detailed={detailed}
          shortcut={settings["clear-extra-formatting"]}
          onToggle={onToggle}
        />
      )}
    />
  );
}

function HelpPanel({
  detailed,
  onToggle,
  shortcut,
}: {
  detailed: boolean;
  onToggle: () => void;
  shortcut: string | null;
}) {
  return (
    <>
      <div className="brand-corner" aria-hidden="true">
        <img src={logoOutline} alt="" />
      </div>
      <header className="panel-header">
        <h2>
          <Eraser size={22} strokeWidth={1.5} />
          清除多余格式
        </h2>
        <p>功能：一键将当前文档整理干净整洁</p>
      </header>
      {detailed && (
        <>
          <h3 className="example-heading">示例：</h3>
          <div className="comparison">
            <ArrowRight
              className="comparison-arrow"
              size={20}
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <figure>
              <figcaption>清理前</figcaption>
              <img
                src={before}
                width={800}
                height={432}
                alt="清理前：带有红色、高亮、斜体、下划线、空行和占位线的示例文字"
              />
            </figure>
            <figure>
              <figcaption>清理后</figcaption>
              <img
                src={after}
                width={800}
                height={432}
                alt="清理后：多余格式和空白已清除，标题仍保持粗体"
              />
            </figure>
          </div>
          <div className="changes">
            <section>
              <h3>清除</h3>
              <p>
                颜色、高亮、斜体、下划线
                <br />
                空行、多余空格、连续下划线占位符
              </p>
            </section>
            <section>
              <h3>保留</h3>
              <p>
                粗体、字体、字号、上下标
                <br />
                图片、表格排版、公式
              </p>
            </section>
          </div>
          <p>表格内仅清除文字颜色与高亮，其余样式和空白均保留。</p>
        </>
      )}
      <footer className="panel-footer">
        <p>快捷键：{platformShortcut(shortcut || "未设置")}</p>
        <span className="detail-control">
          <span>详细介绍</span>
          <button
            type="button"
            role="switch"
            aria-checked={detailed}
            aria-label="详细介绍"
            className="detail-switch"
            onClick={onToggle}
          >
            <span />
          </button>
        </span>
      </footer>
    </>
  );
}
