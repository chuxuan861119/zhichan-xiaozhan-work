import { useState } from "react";
import policy from "../../../../resources/legal-policies.json";
import {
  APPLICATION_COPYRIGHT,
  APPLICATION_NAME,
  APPLICATION_VERSION,
  APPLICATION_WEBSITE,
} from "../../../shared/branding";
import { APPLICATION_BUILD_INFO } from "../../../shared/build-info";
import { openSoftwareUpdates } from "../updates/use-software-updates";
import { BrandLogo } from "./brand-logo";
import { StandardDialog } from "./standard-dialog";
import "./about-dialog.css";

type AboutDialogProps = {
  onClose(): void;
  onOpen(destination: "terms" | "privacy" | "feedback" | "notices"): void;
};

type ThirdPartyNoticesDialogProps = {
  onClose(): void;
  onOpenNotices(): void;
  onOpenLicensesFolder(): void;
};

export function AboutDialog({ onClose, onOpen }: AboutDialogProps) {
  const [websiteError, setWebsiteError] = useState("");
  const openWebsite = async () => {
    setWebsiteError("");
    try {
      const open = window.patentApi?.application.openOfficialWebsite;
      if (!open) throw new Error("unavailable");
      const result = await open("work-home");
      if (!result.ok) throw new Error("unavailable");
    } catch {
      setWebsiteError(`暂时无法打开浏览器，请访问 ${APPLICATION_WEBSITE}`);
    }
  };
  return (
    <StandardDialog
      open
      title={`关于${APPLICATION_NAME}`}
      className="about-dialog"
      size="s"
      onCancel={onClose}
      footer={
        <>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              onClose();
              openSoftwareUpdates();
            }}
          >
            检查更新
          </button>
          <button
            type="button"
            className="primary-button"
            aria-label="关闭关于窗口"
            onClick={onClose}
          >
            关闭
          </button>
        </>
      }
    >
      <div className="about-dialog__content">
        <div className="about-dialog__identity">
          <BrandLogo className="about-dialog__logo" />
          <div>
            <h3>{APPLICATION_NAME}</h3>
            <p className="about-dialog__version">版本 {APPLICATION_VERSION}</p>
          </div>
        </div>
        <p className="about-dialog__description">
          面向专利撰写人员的本地工作台，支持专利文档编辑、附图制作、分类查询与导出打印。
        </p>
        <div className="about-dialog__provider">
          <span>软件提供方</span>
          <p>{policy.operator || "软件提供方待公布"}</p>
        </div>
        <nav className="about-dialog__support" aria-label="联系与支持">
          <button type="button" className="about-dialog__link" onClick={() => void openWebsite()}>
            官方网站 <span aria-hidden="true">↗</span>
          </button>
          <button type="button" className="about-dialog__link" onClick={() => onOpen("feedback")}>
            联系与反馈
          </button>
        </nav>
        {websiteError ? (
          <p className="about-dialog__error" role="alert">
            {websiteError}
          </p>
        ) : null}
        <details className="about-dialog__build">
          <summary>版本详情</summary>
          <dl>
            <div>
              <dt>构建标识</dt>
              <dd>{APPLICATION_BUILD_INFO.buildId}</dd>
            </div>
            <div>
              <dt>构建时间</dt>
              <dd>
                {APPLICATION_BUILD_INFO.builtAt
                  ? new Date(APPLICATION_BUILD_INFO.builtAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })
                  : "未记录"}
                {APPLICATION_BUILD_INFO.builtAt ? "（本机时区）" : ""}
              </dd>
            </div>
            <div>
              <dt>源码提交</dt>
              <dd>{APPLICATION_BUILD_INFO.commit ?? "未记录"}</dd>
            </div>
          </dl>
          {APPLICATION_BUILD_INFO.dirty ? <p>构建时工作区包含未提交修改。</p> : null}
          {APPLICATION_BUILD_INFO.mode === "development" ? (
            <p>热更新开发实例，以上标识为启动时状态。</p>
          ) : null}
        </details>
        <div className="about-dialog__legal">
          <p className="about-dialog__copyright">{APPLICATION_COPYRIGHT}</p>
          <nav aria-label="协议与声明">
            <button type="button" className="about-dialog__link" onClick={() => onOpen("terms")}>
              软件使用协议
            </button>
            <button type="button" className="about-dialog__link" onClick={() => onOpen("privacy")}>
              隐私政策
            </button>
            <button type="button" className="about-dialog__link" onClick={() => onOpen("notices")}>
              开源声明
            </button>
          </nav>
        </div>
      </div>
    </StandardDialog>
  );
}

export function ThirdPartyNoticesDialog({
  onClose,
  onOpenNotices,
  onOpenLicensesFolder,
}: ThirdPartyNoticesDialogProps) {
  const [sourceError, setSourceError] = useState("");
  const openSources = async () => {
    setSourceError("");
    try {
      const result = await window.patentApi?.application.openOfficialWebsite?.("work-open-source");
      if (!result?.ok) throw new Error("unavailable");
    } catch {
      setSourceError("暂时无法打开浏览器，请访问 https://zcxzz.cn/open-source/。");
    }
  };
  return (
    <StandardDialog
      open
      title="开源许可证与第三方声明"
      subtitle="开放使用，完整致谢"
      size="l"
      onCancel={onClose}
      closeLabel="关闭第三方声明窗口"
      footer={
        <>
          <button type="button" className="secondary-button" onClick={onOpenLicensesFolder}>
            打开许可证目录
          </button>
          <button type="button" className="primary-button" onClick={onOpenNotices}>
            查看完整第三方声明
          </button>
        </>
      }
    >
      <div className="third-party-notices-dialog__content">
        <p className="third-party-notices-dialog__intro">
          {APPLICATION_NAME} 使用以下第三方组件。其许可证、版权与声明随软件一同提供，许可证目录中的
          INDEX.md 可定位各组件原始材料。
        </p>

        <h3 className="third-party-notices-dialog__section-title">第三方组件说明</h3>
        <div className="third-party-notices-dialog__components">
          <section>
            <h3>应用框架与文档组件</h3>
            <p>
              Electron / Chromium / Node.js 提供桌面运行环境；React、Tiptap /
              ProseMirror、Lucide、docx、PDF.js、DOMPurify
              等用于界面、编辑、导出与内容处理。逐项版本、许可和版权见完整声明；Electron
              运行时材料随对应平台运行时提供。
            </p>
          </section>
          <section>
            <h3>IPC 数据中心</h3>
            <p>
              离线页面使用 Tailwind CSS 与 Font Awesome 4.7。CSS 代码按 MIT 许可提供，Font Awesome
              字体按 SIL OFL 1.1 提供，原始文本已汇入第三方声明。
            </p>
          </section>
          <section>
            <h3>CAD 实体编辑</h3>
            <p>
              Cadcraft 编辑内核选择 MIT 许可；DWG 编解码使用 MPL-2.0 的 acadrust 0.6.3。
              原始许可证、版权和依赖清单位于 resources/cadcraft/licenses。
              对应未修改源码可从官网“开源组件与源码”页面免费获取，具体版本、下载地址和校验值见安装目录中的
              resources/OPEN_SOURCE_DOWNLOADS.txt。 本软件的使用协议不限制用户依 MPL
              享有的源码权利。
            </p>
          </section>
          <section>
            <h3>CAD 图纸转换</h3>
            <p>
              桌面转换器使用 ACadSharp、CSUtilities、.NET、Python、ezdxf
              及配套组件。许可证与运行时第三方声明随转换器提供，PyInstaller
              保留原始引导程序例外说明。鸿蒙 CAD 使用的 Pyodide / CPython 等材料按实际平台单独汇总。
            </p>
          </section>
          <section>
            <h3>思源宋体 / Source Han Serif CN</h3>
            <p>
              软件集成 Adobe 思源宋体 2.003 的 Regular、SemiBold 原始字体文件，按 SIL Open Font
              License 1.1 使用和分发。完整版权声明和 OFL 许可随软件提供，可通过上方按钮查看。
            </p>
          </section>
          <section>
            <h3>系统字体</h3>
            <p>
              Windows 的宋体、仿宋、楷体，鸿蒙的 HarmonyOS Sans SC，以及 Mac
              系统字体均调用本机已有字体，其版权属于各自权利人。本软件不随安装包分发这些系统字体文件。DOCX
              导出只指定字体名称，不嵌入系统字体文件。
            </p>
          </section>
          <section>
            <h3>draw.io</h3>
            <p>
              用于流程图编辑。软件采用其 Apache-2.0 许可的离线运行时；draw.io 名称和 Logo
              属于其权利人，本软件与其不存在官方关联或背书关系。
            </p>
          </section>
          <section>
            <h3>Ketcher / Indigo</h3>
            <p>用于化学结构式编辑与化学工具支持，相关版权、许可证与 NOTICE 已随软件提供。</p>
          </section>
          <section>
            <h3>MathLive、KaTeX 与 MathJax</h3>
            <p>用于数学和物理公式的输入、排版与渲染，完整文本请查看第三方声明。</p>
          </section>
          <section>
            <h3>Sharp / libvips</h3>
            <p>
              用于图片处理。许可证和动态库替换说明随软件提供；对应源码、补丁和构建材料在官网免费提供。
              普通离线使用无需下载源码。官网地址：https://zcxzz.cn/open-source/。
            </p>
            <button type="button" className="secondary-button" onClick={openSources}>
              获取开源组件源码
            </button>
            {sourceError && <p role="alert">{sourceError}</p>}
          </section>
        </div>
      </div>
    </StandardDialog>
  );
}
