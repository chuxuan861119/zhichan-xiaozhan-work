import { preload } from "react-dom";
import { isNetworkAiAvailable, platformShortcut } from "../../../shared/platform";
import type { ShortcutSettings } from "../../../shared/settings/shortcuts";
import logo from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./clear-format-help.css";
import "./drawing-ai-help.css";
export const DRAWING_HELP_TARGET =
  ".patent-global-function-rail-slot .drawing-sort-button:not(:disabled):not([aria-pressed='true'])";
export const CORRECTION_HELP_TARGET =
  ".tool-bar button[aria-label='AI 纠错']:not(:disabled):not([aria-disabled='true']), .patent-global-function-rail-slot .patent-book-tools__ai-correction-button:not(:disabled):not([aria-disabled='true'])";
export const ASSISTANT_HELP_TARGET =
  ".tool-bar button[aria-label='小栈AI助手']:not(:disabled):not([aria-disabled='true']), .patent-global-function-rail-slot .patent-book-tools__text-polish-button:not(:disabled):not([aria-disabled='true'])";
export const DRAWING_AI_HELP_TARGET = [
  DRAWING_HELP_TARGET,
  CORRECTION_HELP_TARGET,
  ASSISTANT_HELP_TARGET,
].join(",");
type PanelProps = { detailed: boolean; onToggle: () => void; shortcut: string };
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
export function DrawingAiHelp({ settings }: { settings: ShortcutSettings }) {
  preload(logo, { as: "image" });
  return (
    <>
      <FloatingHelp
        target={DRAWING_HELP_TARGET}
        ariaLabel="附图排序说明"
        className="clear-format-help drawing-ai-help"
        renderPanel={(detailed, onToggle) => (
          <DrawingSortPanel
            detailed={detailed}
            onToggle={onToggle}
            shortcut={settings["toggle-drawing-sort"] || ""}
          />
        )}
      />
      {isNetworkAiAvailable() ? (
        <>
          <FloatingHelp
            target={CORRECTION_HELP_TARGET}
            ariaLabel="AI纠错说明"
            className="clear-format-help drawing-ai-help"
            renderPanel={(detailed, onToggle) => (
              <AiCorrectionPanel
                detailed={detailed}
                onToggle={onToggle}
                shortcut={settings["ai-correction"] || ""}
              />
            )}
          />
          <FloatingHelp
            target={ASSISTANT_HELP_TARGET}
            ariaLabel="小栈AI助手说明"
            className="clear-format-help drawing-ai-help assistant-help"
            renderPanel={(detailed, onToggle) => (
              <AiAssistantPanel detailed={detailed} onToggle={onToggle} shortcut="" />
            )}
          />
        </>
      ) : null}
    </>
  );
}
function DrawingSortPanel({ detailed, onToggle, shortcut }: PanelProps) {
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
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m3 16 4 4 4-4M7 20V4m14 4-4-4-4 4M17 4v16" />
          </svg>
          附图排序
        </h2>
        <p>功能：鼠标拖动调整说明书附图的排列顺序，系统会自动更新图号</p>
      </header>
      {detailed && (
        <div className="details">
          <h3 className="example-heading">排序示例：</h3>
          <div className="sample">
            <h4>排序前</h4>
            <div className="move-example">
              <svg
                className="move-arrow"
                viewBox="0 0 400 48"
                preserveAspectRatio="none"
                aria-label="将第三张图片移到第一位"
              >
                <defs>
                  <marker
                    id="sort-arrowhead"
                    viewBox="0 0 12 10"
                    refX="10"
                    refY="5"
                    markerWidth="8"
                    markerHeight="7"
                    markerUnits="userSpaceOnUse"
                    orient="auto"
                  >
                    <path d="M0 0 12 5 0 10Z" fill="#5688dc" stroke="none" />
                  </marker>
                </defs>
                <path
                  d="M337 40 C337 0 63 0 63 40"
                  vectorEffect="non-scaling-stroke"
                  markerEnd="url(#sort-arrowhead)"
                />
              </svg>
              <div className="drawings">
                <div className="drawing ">
                  <svg viewBox="0 0 64 50" aria-label="示意图 a">
                    <path d="M10 38h44v6H10zM20 38V16h24v22M16 16h32M32 6v10" />
                  </svg>
                  <span>图1</span>
                </div>
                <div className="drawing ">
                  <svg viewBox="0 0 64 50" aria-label="示意图 b">
                    <path d="M8 38h48M15 38V12h34v26M22 12V6h20v6M23 24h18" />
                  </svg>
                  <span>图2</span>
                </div>
                <div className="drawing moved">
                  <svg viewBox="0 0 64 50" aria-label="示意图 c">
                    <circle cx="32" cy="25" r="17" />
                    <circle cx="32" cy="25" r="8" />
                    <path d="M32 3v10M32 37v10M10 25h10M44 25h10" />
                  </svg>
                  <span>图3</span>
                </div>
              </div>
            </div>
          </div>
          <div className="arrow" aria-hidden="true">
            ↓
          </div>
          <div className="sample">
            <h4>将第三张图移到第一位</h4>
            <div className="drawings">
              <div className="drawing moved">
                <svg viewBox="0 0 64 50" aria-label="示意图 c">
                  <circle cx="32" cy="25" r="17" />
                  <circle cx="32" cy="25" r="8" />
                  <path d="M32 3v10M32 37v10M10 25h10M44 25h10" />
                </svg>
                <span>图1</span>
              </div>
              <div className="drawing ">
                <svg viewBox="0 0 64 50" aria-label="示意图 a">
                  <path d="M10 38h44v6H10zM20 38V16h24v22M16 16h32M32 6v10" />
                </svg>
                <span>图2</span>
              </div>
              <div className="drawing ">
                <svg viewBox="0 0 64 50" aria-label="示意图 b">
                  <path d="M8 38h48M15 38V12h34v26M22 12V6h20v6M23 24h18" />
                </svg>
                <span>图3</span>
              </div>
            </div>
          </div>
          <p className="usage">
            <strong>使用：</strong>点击“附图排序”，拖动图片调整位置，再点击“完成排序”。
          </p>
        </div>
      )}
      <HelpFooter detailed={detailed} onToggle={onToggle} shortcut={shortcut} />
    </>
  );
}
function AiCorrectionPanel({ detailed, onToggle, shortcut }: PanelProps) {
  return (
    <>
      <div className="brand-corner" aria-hidden="true">
        <img src={logo} alt="" />
      </div>
      <header className="panel-header">
        <h2>
          <svg
            className="spell-icon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 16 6-12 6 12" />
            <path d="M8 12h8" />
            <path d="m16 20 2 2 4-4" />
          </svg>
          AI纠错
        </h2>
        <p>功能：综合检查文字、标点、术语及内容一致性等问题，给出修改建议</p>
      </header>
      {detailed && (
        <div className="details">
          <h3 className="example-heading">综合检查示例：</h3>
          <div className="review-list">
            <div className="review-row">
              <small>错别字</small>
              <span>
                滑块沿导<span className="wrong">诡</span>移动
              </span>
              <i>→</i>
              <span>
                滑块沿导<b>轨</b>移动
              </span>
            </div>
            <div className="review-row">
              <small>重复表达</small>
              <span>
                与底座<span className="wrong">固接连接</span>
              </span>
              <i>→</i>
              <span>
                与底座<b>固定连接</b>
              </span>
            </div>
            <div className="review-row">
              <small>标点</small>
              <span>
                包括底座<span className="wrong">，，</span>支撑杆
              </span>
              <i>→</i>
              <span>
                包括底座<b>、</b>支撑杆
              </span>
            </div>
            <div className="review-row">
              <small>术语一致</small>
              <span>
                同一部件混用
                <br />
                支撑杆 / <span className="wrong">支承杆</span>
              </span>
              <i>→</i>
              <span>
                统一为
                <br />
                <b>支撑杆</b>
              </span>
            </div>
          </div>
          <p className="usage">
            <strong>使用：</strong>
            选择“当前文档”或“选中文字”开始检查，核对建议后接受，才会修改正文。
          </p>
          <p className="note ai-warning">
            需要注意：本功能需先配置 AI
            模型；本功能运行时，会将文档或选中的文字上传至您配置的模型提供商，不建议将带有技术秘密的文档直接上传，请谨慎使用。
          </p>
        </div>
      )}
      <HelpFooter detailed={detailed} onToggle={onToggle} shortcut={shortcut} />
    </>
  );
}
function AiAssistantPanel({ detailed, onToggle, shortcut }: PanelProps) {
  return (
    <>
      <div className="brand-corner" aria-hidden="true">
        <img src={logo} alt="" />
      </div>
      <header className="panel-header">
        <h2>
          <span className="ai-icon" aria-hidden="true">
            AI
          </span>
          小栈AI助手
        </h2>
        <p>功能：通过连续对话起草、润色和讨论专利内容，逐步完善文档</p>
      </header>
      {detailed && (
        <div className="details">
          <div className="assistant-layout">
            <section>
              <h3 className="example-heading">开始对话：</h3>
              <div className="start-guide">
                <section className="start-card">
                  <header>
                    <span className="start-symbol" aria-hidden="true">
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M3 6V3h3m8 0h3v3M3 14v3h3m8 0h3v-3M6 8h8M6 11h6" />
                      </svg>
                    </span>
                    <strong>选中文字</strong>
                    <small>围绕选区润色、讨论</small>
                  </header>
                  <div className="start-steps">
                    <span>选中正文</span>
                    <i aria-hidden="true">→</i>
                    <span>打开助手</span>
                    <i aria-hidden="true">→</i>
                    <span>输入要求并发送</span>
                  </div>
                </section>
                <section className="start-card">
                  <header>
                    <span className="start-symbol" aria-hidden="true">
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M16 12a2 2 0 0 1-2 2H8l-4 3V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" />
                        <path d="M7 7h6M7 10h4" />
                      </svg>
                    </span>
                    <strong>不选中文字</strong>
                    <small>自由起草、讨论</small>
                  </header>
                  <div className="start-steps">
                    <span>打开助手</span>
                    <i aria-hidden="true">→</i>
                    <span>输入需求并发送</span>
                  </div>
                </section>
              </div>
            </section>
            <section>
              <h3 className="example-heading">连续对话示例：</h3>
              <div className="conversation">
                <div className="message user">
                  <small>你</small>
                  <p>限位块能防止滑块脱出，帮我写成有益效果。</p>
                </div>
                <div className="message assistant">
                  <small>小栈AI助手</small>
                  <p>通过设置限位块，限制滑块的移动范围，从而防止滑块脱出。</p>
                </div>
                <div className="message user">
                  <small>你 · 继续追问</small>
                  <p>再简洁一点，不要改变原意。</p>
                </div>
                <div className="message assistant">
                  <small>小栈AI助手 · 结合上文</small>
                  <p>通过限位块限制滑块行程，防止滑块脱出。</p>
                </div>
              </div>
            </section>
          </div>
          <p className="usage">
            <strong>继续对话：</strong>直接追问或补充要求，助手会结合上文继续回答。
          </p>
          <p className="note ai-warning">
            需要注意：本功能需先配置 AI
            模型；本功能运行时，会将文档或选中的文字上传至您配置的模型提供商，不建议将带有技术秘密的文档直接上传，请谨慎使用。
          </p>
        </div>
      )}
      <HelpFooter detailed={detailed} onToggle={onToggle} shortcut={shortcut} />
    </>
  );
}
