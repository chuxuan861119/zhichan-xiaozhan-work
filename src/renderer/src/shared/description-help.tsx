import logo from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./clear-format-help.css";
import "./description-help.css";

const panels = [
  {
    target: ".patent-global-function-rail-slot .claims-description-tool__toggle:not(:disabled)",
    label: "说明书说明",
    header: (
      <>
        <h2>说明书</h2>
        <p>功能：将权利要求整理为说明书段落，选择要转换的章节</p>
      </>
    ),
    details: (
      <>
        <h3 className="example-heading">选择章节：</h3>
        <div className="routes">
          <section className="route">
            <h4>发明内容</h4>
            <p>去掉附图编号，为从属项添加设定的开头。</p>
          </section>
          <section className="route">
            <h4>具体实施方式</h4>
            <p>保留附图编号，去掉编号外的括号。</p>
          </section>
        </div>
        <div className="flow">
          选择章节<span>→</span>转换并复制<span>→</span>跳转后粘贴
        </div>
        <p className="usage">
          <strong>使用：</strong>点击“说明书”展开，选择一个子按钮，再在跳转章节的合适位置粘贴。
        </p>
      </>
    ),
  },
  {
    target: ".claims-description-menu .claims-description-tool__invention-action:not(:disabled)",
    label: "发明内容说明",
    header: (
      <>
        <h2>发明内容</h2>
        <p>功能：将权利要求转为发明内容段落，复制后跳转到对应章节</p>
      </>
    ),
    details: (
      <>
        <h3 className="example-heading">转换示例：</h3>
        <div className="sample">
          <h4>转换前 · 权利要求</h4>
          <p>1. 一种支撑装置，包括底座(1)，其特征在于：底座(1)上设有可升降的支撑杆。</p>
          <p>2. 根据权利要求1所述的支撑装置，其特征在于：底座(1)设有防滑垫(2)。</p>
        </div>
        <div className="arrow" aria-hidden="true">
          ↓
        </div>
        <div className="sample">
          <h4>转换后 · 发明内容</h4>
          <p>一种支撑装置，包括底座，底座上设有可升降的支撑杆。</p>
          <p>
            <em>作为优化，</em>底座设有防滑垫。
          </p>
        </div>
        <p className="usage">
          <strong>使用：</strong>
          点击后，在“发明内容”章节中粘贴。通过按钮旁的“…”可更换或自定义段落开头。
        </p>
      </>
    ),
  },
  {
    target: ".claims-description-menu .claims-description-tool__embodiments-action:not(:disabled)",
    label: "具体实施方式说明",
    header: (
      <>
        <h2>具体实施方式</h2>
        <p>功能：将权利要求转为实施方式段落，复制后跳转到对应章节</p>
      </>
    ),
    details: (
      <>
        <h3 className="example-heading">转换示例：</h3>
        <div className="sample">
          <h4>转换前 · 权利要求</h4>
          <p>1. 一种支撑装置，包括底座(1)，其特征在于：底座(1)上设有可升降的支撑杆。</p>
          <p>2. 根据权利要求1所述的支撑装置，其特征在于：底座(1)设有防滑垫(2)。</p>
        </div>
        <div className="arrow" aria-hidden="true">
          ↓
        </div>
        <div className="sample">
          <h4>转换后 · 具体实施方式</h4>
          <p>
            一种支撑装置，包括底座<em>1</em>，底座<em>1</em>上设有可升降的支撑杆。
          </p>
          <p>
            底座<em>1</em>设有防滑垫<em>2</em>。
          </p>
        </div>
        <p className="usage">
          <strong>使用：</strong>点击后，在“具体实施方式”章节中粘贴，再补充结构、工作过程等细节。
        </p>
      </>
    ),
  },
];
export const DESCRIPTION_HELP_TARGET = panels.map((panel) => panel.target).join(", ");
export function DescriptionHelp() {
  return (
    <>
      {panels.map((panel) => (
        <FloatingHelp
          key={panel.target}
          target={panel.target}
          ariaLabel={panel.label}
          className="clear-format-help description-help"
          renderPanel={(detailed, onToggle) => (
            <>
              <div className="brand-corner" aria-hidden="true">
                <img src={logo} alt="" />
              </div>
              <header className="panel-header">{panel.header}</header>
              {detailed && <div className="description-help__details">{panel.details}</div>}
              <footer className="panel-footer">
                <p>快捷键：未设置</p>
                <span className="detail-control">
                  <span>详细介绍</span>
                  <button
                    className="detail-switch"
                    type="button"
                    role="switch"
                    aria-label="详细介绍"
                    aria-checked={detailed}
                    onClick={onToggle}
                  >
                    <span />
                  </button>
                </span>
              </footer>
            </>
          )}
        />
      ))}
    </>
  );
}
