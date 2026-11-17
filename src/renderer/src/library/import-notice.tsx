import { ArrowRight, FileArchive, FileCheck2, Files, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import logoOutline from "../shared/clear-format-help-assets/logo-outline.png";
import { StandardDialog } from "../shared/standard-dialog";
import "./import-notice.css";

type ImportFormat = "zip" | "patdoc" | "docx";
const key = (format: ImportFormat) => `patent-workbench:import-notice:${format}:v1`;
const notices = {
  zip: {
    title: "压缩包导入须知",
    intro: "一次导入多个专利，完成后留在专利库。",
    icon: FileArchive,
    steps: ["本软件导出的 ZIP", "校验文档包", "生成多个专利"],
    items: [
      ["只支持本软件导出的文档包", "可导入 PATDOC 或 DOCX 压缩包；PDF 压缩包不支持导入。"],
      ["请保留压缩包原样", "无需解压，请勿修改、删减或重新打包其中的文件。"],
      ["导入后生成独立副本", "不会覆盖现有专利，不打开文档或识别预览。重复导入会先询问。"],
    ],
  },
  patdoc: {
    title: "PATDOC 导入须知",
    intro: "导入原生专利文件，继续编辑。",
    icon: Files,
    steps: ["选择 PATDOC", "读取原生内容", "打开导入的专利"],
    items: [
      ["优先使用原生格式", "PATDOC 用于保留本软件的文档内容、附图及关联数据。"],
      ["导入为独立副本", "不会覆盖专利库中已有的专利，也不会修改原文件。"],
      ["历史版本不会一并迁入", "迁移整个文档库、快照和设置，请使用设置中的“数据迁移”。"],
    ],
  },
  docx: {
    title: "DOCX 导入须知",
    intro: "识别已有文档，整理为本软件的专利书册。",
    icon: FileText,
    steps: ["选择 DOCX", "核对识别预览", "确认后导入"],
    items: [
      ["请选择 DOCX 文件", "旧版 DOC 文件请先在 Word 或 WPS 中另存为 DOCX。"],
      ["先预览，再确认", "核对专利名称、类型和各书册的识别结果，确认后才创建专利。"],
      ["导入后检查排版", "复杂表格、公式、附图和特殊格式可能存在差异，请结合导入提示核对。"],
    ],
  },
} as const;

export function useImportNotice() {
  const [format, setFormat] = useState<ImportFormat | null>(null);
  const pending = useRef<((proceed: boolean) => void) | null>(null);
  const acknowledged = useRef(new Set<ImportFormat>());
  useEffect(
    () => () => {
      pending.current?.(false);
      pending.current = null;
    },
    [],
  );

  const request = useCallback((next: ImportFormat): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    try {
      if (localStorage.getItem(key(next)) === "true") acknowledged.current.add(next);
    } catch {
      /* Keep the notice usable when local storage is unavailable. */
    }
    if (acknowledged.current.has(next)) return Promise.resolve(true);
    return new Promise((resolve) => {
      pending.current = resolve;
      setFormat(next);
    });
  }, []);

  const finish = (proceed: boolean) => {
    if (!pending.current || !format) return;
    if (proceed) {
      acknowledged.current.add(format);
      try {
        localStorage.setItem(key(format), "true");
      } catch {
        /* Remember for this session. */
      }
    }
    const resolve = pending.current;
    pending.current = null;
    setFormat(null);
    resolve(proceed);
  };
  const content = format ? notices[format] : null;
  const Icon = content?.icon ?? FileText;
  return {
    request,
    isOpen: format !== null,
    dialog: content ? (
      <StandardDialog
        open
        title={content.title}
        onCancel={() => finish(false)}
        topInset={40}
        className="import-notice"
        bodyClassName="import-notice__body"
        footer={
          <>
            <button type="button" className="secondary-button" onClick={() => finish(false)}>
              取消
            </button>
            <button type="button" className="primary-button" onClick={() => finish(true)}>
              继续导入
            </button>
          </>
        }
      >
        <img className="import-notice__brand" src={logoOutline} alt="" aria-hidden="true" />
        <p className="import-notice__intro">
          <Icon size={24} strokeWidth={1.5} aria-hidden="true" />
          {content.intro}
        </p>
        <section className="import-notice__flow" aria-label="导入流程">
          {content.steps.map((step, index) => (
            <span key={step}>
              {index > 0 && <ArrowRight size={17} aria-hidden="true" />}
              <span>{step}</span>
            </span>
          ))}
        </section>
        <ul className="import-notice__items">
          {content.items.map(([title, description]) => (
            <li key={title}>
              <FileCheck2 size={21} strokeWidth={1.5} aria-hidden="true" />
              <div>
                <h3>{title}</h3>
                <p>{description}</p>
              </div>
            </li>
          ))}
        </ul>
      </StandardDialog>
    ) : null,
  };
}
