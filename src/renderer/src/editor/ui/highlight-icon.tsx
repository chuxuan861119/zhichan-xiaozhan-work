import type { CSSProperties } from "react";

type HighlightIconProps = {
  /** 图标尺寸（像素），默认 18，与工具栏其余 lucide 图标一致 */
  size?: number;
  /** 高亮笔笔身填充色，默认亮黄 */
  fill?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * 高亮笔图标：外轮廓线条继承 currentColor（黑色系），笔身内部填充选中色。
 * 笔身为闭合圆角四边形（填充 + 描边同一路径），左下角以单条斜线收出笔尖，
 * 再以开放五边形勾勒笔尖轮廓——比 lucide 原版线稿少一条内部对角线，
 * 视觉更简洁。
 */
export function HighlightIcon({
  size = 18,
  fill = "#FFFF00",
  className,
  style,
}: HighlightIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {/* 笔身填充层 */}
      <path
        d="M22 12 L17.4 16.6 A2 2 0 0 1 14.6 16.6 L9.4 11.4 A2 2 0 0 1 9.4 8.6 L14 4 Z"
        fill={fill}
        stroke="none"
      />
      {/* 笔身闭合轮廓 */}
      <path
        d="M22 12 L17.4 16.6 A2 2 0 0 1 14.6 16.6 L9.4 11.4 A2 2 0 0 1 9.4 8.6 L14 4 Z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 单线笔尖 */}
      <path d="m9.4 11.4-6.4 6.4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* 笔尖轮廓 */}
      <path
        d="m9 11-6 6v3h9l3-3"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
