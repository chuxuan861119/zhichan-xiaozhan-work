import { preload } from "react-dom";
import logo from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./clear-format-help.css";
import "./drawing-list-help.css";
export const DRAWING_LIST_HELP_TARGET =
  ".reference-mark-panel__fill,.reference-mark-panel__copy,.drawing-explanation-rail__fill,.drawing-explanation-rail__copy";
export function DrawingListHelp() {
  preload(logo, { as: "image" });
  return (
    <>
      <FloatingHelp
        target=".reference-mark-panel__fill"
        showWhenDisabled
        ariaLabel="附图标记填入说明书说明"
        className="clear-format-help drawing-list-help"
        renderPanel={(detailed, onToggle) => (
          <>
            <div className="brand-corner" aria-hidden="true">
              <img src={logo} alt="" />
            </div>
            <header className="panel-header">
              <div className="context-label">附图标记</div>
              <h2>填入说明书</h2>
              <p>功能：将已登记的附图标记整理后，填入说明书的附图说明部分</p>
            </header>
            <div className="details" hidden={!detailed}>
              <h3 className="example-heading">填入示例：</h3>
              <div className="sample">
                <h4>附图标记列表</h4>
                <div className="mark-table">
                  <div className="mark-row table-head">
                    <span>序号</span>
                    <span>关键词</span>
                  </div>
                  <div className="mark-row">
                    <span>1</span>
                    <span>底座</span>
                  </div>
                  <div className="mark-row">
                    <span>2</span>
                    <span>支撑杆</span>
                  </div>
                </div>
              </div>
              <div className="sample-arrow" aria-hidden="true">
                ↓
              </div>
              <div className="sample">
                <h4>说明书 · 附图说明</h4>
                <div className="document-example inserted">
                  <h5>附图说明</h5>
                  <p>
                    其中：1、<span className="keyword-block">底座</span>；2、
                    <span className="keyword-block">支撑杆</span>。
                  </p>
                </div>
              </div>
              <p className="usage">
                <strong>使用：</strong>
                核对附图标记后点击“填入说明书”；已有内容需要替换时，按提示确认。
              </p>
              <p className="result">修改说明书正文，不是插入到当前光标位置。</p>
            </div>
            <footer className="panel-footer">
              <p>快捷键：未设置</p>
              <span className="detail-control">
                <span>详细介绍</span>
                <button
                  className="detail-switch"
                  type="button"
                  role="switch"
                  aria-label="附图标记填入说明书详细介绍"
                  aria-checked={detailed}
                  onClick={onToggle}
                >
                  <span></span>
                </button>
              </span>
            </footer>
          </>
        )}
      />
      <FloatingHelp
        target=".reference-mark-panel__copy"
        showWhenDisabled
        ariaLabel="附图标记复制说明"
        className="clear-format-help drawing-list-help"
        renderPanel={(detailed, onToggle) => (
          <>
            <div className="brand-corner" aria-hidden="true">
              <img src={logo} alt="" />
            </div>
            <header className="panel-header">
              <div className="context-label">附图标记</div>
              <h2>复制</h2>
              <p>功能：将附图标记列表复制到剪贴板，方便粘贴使用</p>
            </header>
            <div className="details" hidden={!detailed}>
              <h3 className="example-heading">复制示例：</h3>
              <div className="sample">
                <h4>附图标记列表</h4>
                <div className="mark-table">
                  <div className="mark-row table-head">
                    <span>序号</span>
                    <span>关键词</span>
                  </div>
                  <div className="mark-row">
                    <span>1</span>
                    <span>底座</span>
                  </div>
                  <div className="mark-row">
                    <span>2</span>
                    <span>支撑杆</span>
                  </div>
                </div>
              </div>
              <div className="sample-arrow" aria-hidden="true">
                ↓
              </div>
              <div className="sample">
                <h4>复制后粘贴</h4>
                <div className="document-example">
                  <p className="no-indent">1、底座；2、支撑杆</p>
                </div>
              </div>
              <p className="usage">
                <strong>使用：</strong>点击“复制”，再到需要的位置粘贴。
              </p>
              <p className="result">复制整个列表，沿用当前排列顺序，不修改正文。</p>
            </div>
            <footer className="panel-footer">
              <p>快捷键：未设置</p>
              <span className="detail-control">
                <span>详细介绍</span>
                <button
                  className="detail-switch"
                  type="button"
                  role="switch"
                  aria-label="附图标记复制详细介绍"
                  aria-checked={detailed}
                  onClick={onToggle}
                >
                  <span></span>
                </button>
              </span>
            </footer>
          </>
        )}
      />
      <FloatingHelp
        target=".drawing-explanation-rail__fill"
        showWhenDisabled
        ariaLabel="附图说明填入说明书说明"
        className="clear-format-help drawing-list-help"
        renderPanel={(detailed, onToggle) => (
          <>
            <div className="brand-corner" aria-hidden="true">
              <img src={logo} alt="" />
            </div>
            <header className="panel-header">
              <div className="context-label">附图说明</div>
              <h2>填入说明书</h2>
              <p>功能：将各张附图的说明文字填入说明书的附图说明部分</p>
            </header>
            <div className="details" hidden={!detailed}>
              <h3 className="example-heading">填入示例：</h3>
              <div className="sample">
                <h4>附图说明列表</h4>
                <div className="explanation-row">
                  <strong>图1</strong>
                  <p>图1为本实用新型的整体结构示意图。</p>
                </div>
                <div className="explanation-row">
                  <strong>图2</strong>
                  <p>图2为本实用新型的局部结构示意图。</p>
                </div>
              </div>
              <div className="sample-arrow" aria-hidden="true">
                ↓
              </div>
              <div className="sample">
                <h4>说明书 · 附图说明</h4>
                <div className="document-example inserted">
                  <h5>附图说明</h5>
                  <p>图1为本实用新型的整体结构示意图。</p>
                  <p>图2为本实用新型的局部结构示意图。</p>
                </div>
              </div>
              <p className="usage">
                <strong>使用：</strong>在各图说明框中写好内容，再点击“填入说明书”。
              </p>
              <p className="result">按当前图序填入对应说明，不是插入图片。</p>
            </div>
            <footer className="panel-footer">
              <p>快捷键：未设置</p>
              <span className="detail-control">
                <span>详细介绍</span>
                <button
                  className="detail-switch"
                  type="button"
                  role="switch"
                  aria-label="附图说明填入说明书详细介绍"
                  aria-checked={detailed}
                  onClick={onToggle}
                >
                  <span></span>
                </button>
              </span>
            </footer>
          </>
        )}
      />
      <FloatingHelp
        target=".drawing-explanation-rail__copy"
        showWhenDisabled
        ariaLabel="附图说明复制说明"
        className="clear-format-help drawing-list-help"
        renderPanel={(detailed, onToggle) => (
          <>
            <div className="brand-corner" aria-hidden="true">
              <img src={logo} alt="" />
            </div>
            <header className="panel-header">
              <div className="context-label">附图说明</div>
              <h2>复制</h2>
              <p>功能：将各张附图的说明文字复制到剪贴板，方便粘贴使用</p>
            </header>
            <div className="details" hidden={!detailed}>
              <h3 className="example-heading">复制示例：</h3>
              <div className="sample">
                <h4>附图说明列表</h4>
                <div className="explanation-row">
                  <strong>图1</strong>
                  <p>图1为本实用新型的整体结构示意图。</p>
                </div>
                <div className="explanation-row">
                  <strong>图2</strong>
                  <p>图2为本实用新型的局部结构示意图。</p>
                </div>
              </div>
              <div className="sample-arrow" aria-hidden="true">
                ↓
              </div>
              <div className="sample">
                <h4>复制后粘贴</h4>
                <div className="document-example">
                  <p>图1为本实用新型的整体结构示意图。</p>
                  <p>图2为本实用新型的局部结构示意图。</p>
                </div>
              </div>
              <p className="usage">
                <strong>使用：</strong>写好各图说明后点击“复制”，再到需要的位置粘贴。
              </p>
              <p className="result">按当前图序复制说明文字，保留分段及首行缩进，不修改正文。</p>
            </div>
            <footer className="panel-footer">
              <p>快捷键：未设置</p>
              <span className="detail-control">
                <span>详细介绍</span>
                <button
                  className="detail-switch"
                  type="button"
                  role="switch"
                  aria-label="附图说明复制详细介绍"
                  aria-checked={detailed}
                  onClick={onToggle}
                >
                  <span></span>
                </button>
              </span>
            </footer>
          </>
        )}
      />
    </>
  );
}
