import type { SVGProps } from "react";

/**
 * 侧边栏折叠 / 展开图标。
 *
 * 取代 lucide `PanelLeft`（`rect rx=2` + `M9 3v18` 贯穿竖线）：
 * 后者圆角率仅 11%、竖线贯穿全高，小尺寸下方框感硬、读起来像「分栏表格」。
 * 本图标外框 18×16.8（1.07:1）、`rx=4.8`（圆角率 ~27%），内部竖线缩短为
 * 框高 42% 并用圆头端点，只保留「左边一栏」的空间暗示。
 *
 * 展开态（侧边栏 header 的收起入口）与收起态（内容区 header 的展开入口）共用同一图标，
 * 不按状态换向 —— 两处必须保持一致，改一处即为 bug。
 *
 * 两个切换入口均以 `size-5` 渲染，`strokeWidth=2`。
 */
export function PanelToggleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
      {...props}
    >
      <rect x="3" y="3.6" width="18" height="16.8" rx="4.8" />
      <path d="M9.12 8.47v7.06" strokeLinecap="round" />
    </svg>
  );
}
