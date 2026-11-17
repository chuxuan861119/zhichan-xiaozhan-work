import { useEffect, useRef, useState } from "react";
import {
  AI_LOCAL_STORAGE_NOTICE,
  AI_OPERATOR_PRIVACY_NOTICE,
  AI_RESPONSIBILITY_NOTICE,
} from "../../../shared/ai-correction/policy";
import { StandardDialog } from "./standard-dialog";
import "./ai-data-policy.css";

export function AiDataPolicy() {
  const [visible, setVisible] = useState(false);
  return (
    <>
      <button className="ai-policy-trigger" type="button" onClick={() => setVisible(true)}>
        AI 使用协议与隐私说明
      </button>
      <AiDataPolicyDialog open={visible} onClose={() => setVisible(false)} />
    </>
  );
}

export function AiDataPolicyDialog({
  open: visible,
  onClose,
  onAccept,
}: {
  open: boolean;
  onClose(): void;
  onAccept?: () => Promise<boolean>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [readToEnd, setReadToEnd] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setReadToEnd(false);
    setAgreed(false);
    setError(null);
    const body = dialogRef.current?.querySelector<HTMLElement>(".standard-dialog__body");
    if (!body) return;
    body.scrollTop = 0;
    const measure = () => {
      if (body.clientHeight > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2)
        setReadToEnd(true);
    };
    // A hidden body cannot count as completed reading.
    const frame = requestAnimationFrame(measure);
    body.addEventListener("scroll", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(body);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      body.removeEventListener("scroll", measure);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [visible]);
  const accept = async () => {
    if (!onAccept || !readToEnd || !agreed || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await onAccept()) onClose();
      else setError("保存失败，AI 连接未开启，请重试。");
    } catch {
      setError("保存失败，AI 连接未开启，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const [error, setError] = useState<string | null>(null);
  async function open(document: "privacy" | "terms") {
    setError(null);
    try {
      const result = await window.patentApi.aiCorrection.openProviderDocs({
        providerId: "deepseek",
        document,
      });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("无法打开 DeepSeek 官方政策，请稍后重试。");
    }
  }
  return (
    <StandardDialog
      open={visible}
      title="AI 使用协议与隐私说明"
      size="l"
      portal
      dialogRef={dialogRef}
      closeDisabled={busy}
      onCancel={onClose}
      footer={
        onAccept ? (
          <>
            <div className="ai-policy-consent">
              {!readToEnd ? <span>请阅读并滚动至说明底部</span> : null}
              <label>
                <input
                  type="checkbox"
                  checked={agreed}
                  disabled={!readToEnd || busy}
                  onChange={(event) => setAgreed(event.target.checked)}
                />
                我已阅读并同意 AI 使用协议与隐私说明
              </label>
            </div>
            <button type="button" disabled={busy} onClick={onClose}>
              暂不开启
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!readToEnd || !agreed || busy}
              onClick={() => void accept()}
            >
              {busy ? "正在开启…" : "同意并开启"}
            </button>
          </>
        ) : (
          <button type="button" className="primary-button" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      <section className="ai-policy-content">
        <h3>服务与隐私边界</h3>
        <p>{AI_OPERATOR_PRIVACY_NOTICE}</p>
        <h3>本机存储与删除</h3>
        <p>{AI_LOCAL_STORAGE_NOTICE}</p>
        <p>
          文档、快照和备份按本地功能规则保存；删除对话历史不等于删除文档、快照或备份。 请妥善保管
          API Key，不要共享。
        </p>
        <h3>数据发送与控制</h3>
        <p>
          AI
          纠错和小栈AI助手会按所选任务发送相关文档文字、用户要求及必要上下文；连续对话可能发送历史或摘要。
          连接测试会发送测试文字，读取模型列表会发送身份凭据。请求从您的设备直接发送至 DeepSeek
          官方接口。
        </p>
        <p>
          首次发送任务内容前会询问；取消时不发送。可以在 AI
          设置中关闭连接，停止当前连接并阻止后续请求，
          本机模型配置、密钥与历史记录继续保留。关闭、取消或停止请求无法撤回已发送的数据。
        </p>
        <p>
          DeepSeek 对相关数据的处理和保存适用其隐私政策，本软件不作第三方零留存承诺。
          请确认有权发送所选材料，谨慎处理未公开专利、商业秘密及个人信息；有保密要求的材料应先脱敏，或关闭
          AI 连接。
        </p>
        <h3>使用协议与责任边界</h3>
        <p>{AI_RESPONSIBILITY_NOTICE}</p>
        <h3>模型提供方政策</h3>
        <p>以下链接在浏览器中打开，不会发送文档内容或 API Key。</p>
        <div className="ai-policy-links">
          <button type="button" onClick={() => void open("privacy")}>
            DeepSeek 隐私政策 ↗
          </button>
          <button type="button" onClick={() => void open("terms")}>
            DeepSeek 用户协议 ↗
          </button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </StandardDialog>
  );
}
