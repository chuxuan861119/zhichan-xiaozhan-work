import { platformShortcut } from "../../../shared/platform";
export function DrawingGuidance({ children }: { children: string }) {
  const short = children
    .replace("拖动鼠标选取图片范围，按住滚轮移动图纸", "拖动取图 · 滚轮平移")
    .replace("点击图中位置，再点击放置编号；也可以按住左键拖动标号", "点击起点，再放置编号")
    .replace("直接输入下一个编号，继续点击标号；右键结束", "输入编号继续标号 · 右键结束")
    .replace("拖动数字调整位置，拖动引线整体移动，按 Delete 删除", "拖动调整 · Delete 删除")
    .replace("拖动整体移动，按 Delete 删除，Ctrl+C 复制", "拖动移动 · Delete 删除 · Ctrl+C 复制")
    .replace("拖动边缘调整范围，点击“预览成图”查看结果", "调整范围，预览成图")
    .replace("松开完成取图，碰到的标号会完整保留", "松开取图，保留完整标号")
    .replace("移动鼠标，点击放置，按 Esc 取消", "点击放置 · Esc 取消")
    .replace("使用缩放按钮检查成图，确认后导出或插入", "检查成图后导出或插入")
    .replace("移动鼠标放置局部放大图 · 点击确认 · Esc / 右键取消", "点击放置放大图 · Esc 取消")
    .replace("移动鼠标拉出字母引线，点击确定标记位置 · Esc / 右键取消", "点击放置字母 · Esc 取消");
  return (
    <span className="drawing-view-hint" title={platformShortcut(children)}>
      <span className="drawing-hint-full">{platformShortcut(children)}</span>
      <span className="drawing-hint-short">{platformShortcut(short)}</span>
    </span>
  );
}
