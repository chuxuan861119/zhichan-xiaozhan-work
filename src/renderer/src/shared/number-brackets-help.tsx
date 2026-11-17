import logo from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./clear-format-help.css";
import "./number-brackets-help.css";

export const NUMBER_BRACKETS_HELP_TARGET = ".tool-bar [data-number-brackets]";

export function NumberBracketsIcon({ add }: { add: boolean }) {
  return (
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
      <path d="M10 9l2-2v10m-2 0h4" />
      {add ? <path d="M6 4C2 8 2 16 6 20M18 4c4 4 4 12 0 16" /> : <path d="M3 12h4m10 0h4" />}
    </svg>
  );
}

export function NumberBracketsHelp() {
  return (
    <>
      {([true, false] as const).map((add) => {
        const label = add ? "数字加括号" : "数字去括号";
        return (
          <FloatingHelp
            showWhenDisabled
            key={label}
            target={`.tool-bar [data-number-brackets="${add ? "add" : "remove"}"]`}
            ariaLabel={`${label}说明`}
            className="clear-format-help number-brackets-help"
            renderPanel={(detailed, onToggle) => (
              <>
                <div className="brand-corner" aria-hidden="true">
                  <img src={logo} alt="" />
                </div>
                <header className="panel-header">
                  <h2>
                    <NumberBracketsIcon add={add} />
                    {label}
                  </h2>
                  <p>
                    功能：
                    {add
                      ? "为选中文字中的连续数字添加圆括号"
                      : "去掉选中文字中的括号，保留括号内的内容"}
                  </p>
                </header>
                {detailed && (
                  <div className="number-brackets-help__details">
                    <h3 className="example-heading">示例：</h3>
                    <div className="number-brackets-help__comparison">
                      <section>
                        <h4>处理前</h4>
                        <p>
                          {add ? "关键词1" : "关键词(1)"}
                          <br />
                          {add ? "关键词201" : "关键词（201）"}
                        </p>
                      </section>
                      <span aria-hidden="true">→</span>
                      <section>
                        <h4>处理后</h4>
                        <p>
                          {add ? "关键词(1)" : "关键词1"}
                          <br />
                          {add ? "关键词(201)" : "关键词201"}
                        </p>
                      </section>
                    </div>
                    <p className="number-brackets-help__usage">
                      <strong>使用：</strong>先选中文字，再点击按钮。未选中文字时不可用。
                    </p>
                    <p className="number-brackets-help__note">
                      {add
                        ? "已有圆括号的数字不重复添加。只处理选区，保留原有格式。"
                        : "包括中英文圆括号、方括号和花括号；不删除其中的文字和数字。"}
                    </p>
                  </div>
                )}
                <footer className="panel-footer">
                  <p>快捷键：暂无</p>
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
      })}
    </>
  );
}
