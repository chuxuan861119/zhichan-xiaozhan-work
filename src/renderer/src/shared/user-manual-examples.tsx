import {
  ArrowDown,
  ArrowRight,
  FileCheck2,
  FilePlus2,
  FolderOpen,
  ListChecks,
  LocateFixed,
  MessageCircle,
  ScanText,
  ShieldCheck,
} from "lucide-react";
import after from "./clear-format-help-assets/after.png";
import before from "./clear-format-help-assets/before.png";

export function ManualExample({ topic }: { topic: string }) {
  if (topic === "AI纠错")
    return (
      <figure className="manual-example" aria-label="AI综合检查示例">
        <figcaption>综合检查示例 · 核对建议后接受</figcaption>
        <div className="manual-corrections">
          {[
            ["错别字", "滑块沿导诡移动", "滑块沿导轨移动"],
            ["重复表达", "与底座固接连接", "与底座固定连接"],
            ["标点", "包括底座，，支撑杆", "包括底座、支撑杆"],
            ["术语一致", "同一部件混用支撑杆 / 支承杆", "核对后统一为支撑杆"],
          ].map(([label, original, corrected]) => (
            <div key={label}>
              <small>{label}</small>
              <del>{original}</del>
              <ArrowRight size={16} aria-hidden="true" />
              <span>{corrected}</span>
            </div>
          ))}
        </div>
      </figure>
    );
  if (topic === "清除多余格式")
    return (
      <figure className="manual-example" aria-label="清除多余格式示例">
        <figcaption>示例</figcaption>
        <div className="manual-comparison">
          <figure>
            <figcaption>清理前</figcaption>
            <img
              src={before}
              width="800"
              height="432"
              alt="清理前：带有颜色、高亮、空白及多余格式的真实编辑器截图"
            />
          </figure>
          <ArrowRight className="manual-compare-arrow" aria-hidden="true" />
          <figure>
            <figcaption>清理后</figcaption>
            <img
              src={after}
              width="800"
              height="432"
              alt="清理后：正文整洁，标题粗体保留的真实编辑器截图"
            />
          </figure>
        </div>
      </figure>
    );
  if (topic === "插入从权")
    return (
      <figure className="manual-example">
        <figcaption>示例 · 在第1项中放置光标</figcaption>
        <div className="manual-paper">
          <strong>插入前</strong>
          <p>
            1. 一种支撑装置，包括底座
            <span className="manual-caret" />
            和支撑杆……
          </p>
          <p>2. 根据权利要求1所述的支撑装置，……</p>
          <p>3. 根据权利要求2所述的支撑装置，……</p>
        </div>
        <ArrowDown className="manual-down" aria-hidden="true" />
        <div className="manual-paper">
          <strong>插入后</strong>
          <p>1. 一种支撑装置，包括底座和支撑杆……</p>
          <p className="manual-blue">
            2. 根据权利要求1所述的支撑装置，其特征在于：
            <span className="manual-caret" />
          </p>
          <p>
            <b className="manual-blue">3.</b> 根据权利要求1所述的支撑装置，……
          </p>
          <p>
            <b className="manual-blue">4.</b> 根据权利要求<b className="manual-blue">3</b>
            所述的支撑装置，……
          </p>
        </div>
        <p className="manual-example-caption">新增从权后，后续编号与相关引用同步调整。</p>
      </figure>
    );
  if (topic === "增补编号")
    return (
      <figure className="manual-example">
        <figcaption>示例 · 附图标记已登记</figcaption>
        <div className="manual-tags">
          <span>底座 · 1</span>
          <span>支撑杆 · 2</span>
        </div>
        <div className="manual-paper">
          <strong>增补前</strong>
          <p>支撑杆安装在底座1上，底座用于承托工件。</p>
        </div>
        <ArrowDown className="manual-down" aria-hidden="true" />
        <div className="manual-paper">
          <strong>增补后</strong>
          <p>
            <span className="manual-purple">支撑杆2</span>安装在底座1上，
            <span className="manual-purple">底座1</span>用于承托工件。
          </p>
        </div>
      </figure>
    );
  if (topic === "附图排序")
    return (
      <figure className="manual-example">
        <figcaption>示例 · 将第三张图片拖到第一位</figcaption>
        <div className="manual-drawings">
          {["底座", "支架", "轴承"].map((label, i) => (
            <Drawing key={label} label={label} number={i + 1} />
          ))}
        </div>
        <div className="manual-reorder">
          <ArrowDown aria-hidden="true" />
          <span>图片移动，图号更新</span>
        </div>
        <div className="manual-drawings">
          {["轴承", "底座", "支架"].map((label, i) => (
            <Drawing key={label} label={label} number={i + 1} />
          ))}
        </div>
      </figure>
    );
  if (topic === "小栈AI助手：开始对话")
    return (
      <figure className="manual-example">
        <figcaption>开始对话</figcaption>
        <div className="manual-options">
          <div>
            <strong>选中文字</strong>
            <p>
              选中正文 → 打开助手
              <br />
              输入要求，围绕选区润色或讨论
            </p>
          </div>
          <div>
            <strong>不选中文字</strong>
            <p>
              直接打开助手
              <br />
              输入需求，开始起草或讨论
            </p>
          </div>
        </div>
        <div className="manual-chat">
          <p className="manual-chat-user">限位块可以防止滑块脱出，帮我润色。</p>
          <p>
            <MessageCircle size={16} aria-hidden="true" />
            通过限位块限制滑块的移动范围，防止滑块脱出。
          </p>
          <p className="manual-chat-user">再简洁一点。</p>
          <p>
            <MessageCircle size={16} aria-hidden="true" />
            限位块用于防止滑块脱出。
          </p>
        </div>
        <p className="manual-example-caption">可以继续追问，确认内容后再应用到正文。</p>
      </figure>
    );
  const flows: Record<string, { label: string; note: string; icon: typeof FolderOpen }[]> = {
    快速上手: [
      { label: "新建专利", note: "填写题目与类型", icon: FilePlus2 },
      { label: "完成五书", note: "撰写、配图与核对", icon: FileCheck2 },
      { label: "导出交付", note: "检查版式，保留备份", icon: ShieldCheck },
    ],
    本地检查: [
      { label: "全文检查", note: "在面板中启动", icon: ScanText },
      { label: "查看结果", note: "错误、警告、建议", icon: ListChecks },
      { label: "定位核对", note: "修改后再次检查", icon: LocateFixed },
    ],
    转为说明书内容: [
      { label: "转换复制", note: "选择目标章节", icon: FileCheck2 },
      { label: "定位粘贴", note: "在合适位置粘贴", icon: LocateFixed },
      { label: "补充完善", note: "核对技术内容", icon: FilePlus2 },
    ],
    完整数据迁移: [
      { label: "旧电脑导出", note: "设置迁移密码", icon: FolderOpen },
      { label: "新电脑导入", note: "必须使用空库", icon: ShieldCheck },
      { label: "核对资料", note: "重设本机选项", icon: FileCheck2 },
    ],
  };
  const flow = flows[topic];
  if (!flow) return null;
  return (
    <figure className="manual-example manual-flow">
      <figcaption>操作流程</figcaption>
      <div>
        {flow.map(({ label, note, icon: Icon }, i) => (
          <FragmentStep
            key={label}
            label={label}
            note={note}
            Icon={Icon}
            arrow={i < flow.length - 1}
          />
        ))}
      </div>
    </figure>
  );
}

function FragmentStep({
  label,
  note,
  Icon,
  arrow,
}: {
  label: string;
  note: string;
  Icon: typeof FolderOpen;
  arrow: boolean;
}) {
  return (
    <>
      <div className="manual-step">
        <Icon aria-hidden="true" strokeWidth={1.5} />
        <strong>{label}</strong>
        <span>{note}</span>
      </div>
      {arrow && <ArrowRight className="manual-flow-arrow" aria-hidden="true" />}
    </>
  );
}

function Drawing({ label, number }: { label: string; number: number }) {
  return (
    <div className={label === "轴承" ? "manual-drawing manual-drawing--moved" : "manual-drawing"}>
      <svg
        viewBox="0 0 64 50"
        role="img"
        aria-label={label}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        {label === "轴承" ? (
          <>
            <circle cx="32" cy="25" r="17" />
            <circle cx="32" cy="25" r="8" />
            <path d="M32 3v10M32 37v10M10 25h10M44 25h10" />
          </>
        ) : label === "底座" ? (
          <path d="M10 38h44v6H10zM20 38V16h24v22M16 16h32M32 6v10" />
        ) : (
          <path d="M8 38h48M15 38V12h34v26M22 12V6h20v6M23 24h18" />
        )}
      </svg>
      <span>图{number}</span>
    </div>
  );
}
