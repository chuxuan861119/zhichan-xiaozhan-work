import { DraftingCompass } from "lucide-react";
import { platformShortcut } from "../../../shared/platform";
import type { ShortcutSettings } from "../../../shared/settings/shortcuts";
import logo from "./clear-format-help-assets/logo-outline.png";
import { FloatingHelp } from "./floating-help";
import "./clear-format-help.css";
import "./cad-markup-help.css";

export const CAD_MARKUP_HELP_TARGET =
  ".tool-bar button[aria-label='CAD标号'], .patent-global-function-rail-slot .cad-markup-entry";

export function CadMarkupHelp({ settings }: { settings: ShortcutSettings }) {
  return (
    <FloatingHelp
      target={CAD_MARKUP_HELP_TARGET}
      showWhenDisabled
      ariaLabel="CAD标号说明"
      className="clear-format-help cad-markup-help"
      renderPanel={(detailed, onToggle) => (
        <>
          <div className="brand-corner" aria-hidden="true">
            <img src={logo} alt="" />
          </div>
          <header className="panel-header">
            <h2>
              <DraftingCompass size={22} aria-hidden="true" />
              CAD标号
            </h2>
            <p>绘制和编辑 CAD 图纸，支持 DWG/DXF 导入导出、标号、局部放大与附图生成。</p>
          </header>
          {detailed && (
            <div className="cad-markup-help__details">
              <svg viewBox="0 0 480 136" role="img" aria-label="标号与选区示意">
                <rect x="1" y="1" width="478" height="134" rx="10" fill="#f5f8fc" />
                <rect
                  x="23"
                  y="20"
                  width="214"
                  height="98"
                  rx="2"
                  fill="white"
                  stroke="#2673d9"
                  strokeDasharray="5 3"
                />
                <g fill="none" stroke="#243347" strokeWidth="1.4">
                  <rect x="54" y="63" width="77" height="34" />
                  <path d="M68 63V42h49v21M80 97v11m26-11v11M97 46l61-13M126 84l44 12" />
                </g>
                <g fill="#243347" fontSize="16">
                  <text x="162" y="34">
                    1
                  </text>
                  <text x="174" y="100">
                    2
                  </text>
                </g>
                <path d="M261 68h41m-9-7 9 7-9 7" fill="none" stroke="#7b8a9d" strokeWidth="2" />
                <rect x="327" y="24" width="124" height="88" rx="6" fill="white" stroke="#cfd9e6" />
                <text x="389" y="62" textAnchor="middle" fill="#243347" fontSize="16">
                  说明书附图
                </text>
                <text x="389" y="89" textAnchor="middle" fill="#2673d9" fontSize="14">
                  图 1
                </text>
              </svg>
              <ol>
                <li>
                  <strong>新建或导入</strong>
                  <span>新建空白图纸，或导入 DWG、DXF、PDF 和图片；PDF 和图片作为底图使用。</span>
                </li>
                <li>
                  <strong>绘图与修改</strong>
                  <span>在“CAD工具”中绘制线条、图形和文字，选择对象后移动、复制、旋转或缩放。</span>
                </li>
                <li>
                  <strong>放置标号</strong>
                  <span>点击指向位置，再点击数字位置；也可按住左键拖出引线，松开完成。</span>
                </li>
                <li>
                  <strong>选择成图内容</strong>
                  <span>通过选择／框选选中需要的线条、图形、标号和局部放大图，再预览或插入附图。</span>
                </li>
                <li>
                  <strong>生成与导出</strong>
                  <span>
                    预览成图后插入说明书附图或导出 JPG；CAD 图纸还可导出 DWG/DXF，继续在 CAD 软件中编辑。
                  </span>
                </li>
              </ol>
              <div className="cad-markup-help__gestures">
                <span>按住滚轮：平移画布</span>
                <span>Esc：取消当前操作或选择</span>
                <span>选中对象后拖动：移动；拖动控制点：调整形状</span>
              </div>
            </div>
          )}
          <footer className="panel-footer">
            <p>插入附图快捷键：{platformShortcut(settings["insert-marked-drawing"] || "未设置")}</p>
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
