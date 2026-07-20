/**
 * 登录/注册门面背景「线束汇流」动画（07-20 对标 LangSmith 登录页改版）：
 * 多条曲线从左缘不同高度汇入一条水平主干，小球沿线从左向右滑动，
 * 每条线速度（dur）与初始相位（begin 负偏移）各不相同。
 * 纯 SVG + SMIL（animateMotion），零 JS 运行开销；reduced-motion 时隐藏小球。
 */

interface FlowBallProps {
  pathId: string;
  /** 跑完整条线的时长，各线不同以形成速度差 */
  dur: string;
  /** 负偏移错开初始位置，避免同时从左缘出发 */
  begin: string;
}

function FlowBall({ pathId, dur, begin }: FlowBallProps) {
  return (
    <g className="motion-reduce:hidden">
      {/* 外圈浅色光晕 + 内核实心球 */}
      <circle r="8" fill="#BDCCFF" opacity="0.55" />
      <circle r="4.5" fill="#6480F6" />
      <animateMotion dur={dur} begin={begin} repeatCount="indefinite" calcMode="linear">
        <mpath href={`#${pathId}`} />
      </animateMotion>
    </g>
  );
}

export function AuthFlowLines({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1440 900"
      fill="none"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      {/* 线束：上下各三条弧线汇入 y=450 主干，汇入后沿主干延伸到右缘 */}
      <g stroke="#93A9FF" strokeLinecap="round">
        <path id="afl-main" d="M 0 450 H 1440" strokeWidth="1.2" opacity="0.65" />
        <path id="afl-u1" d="M 0 40 C 200 130 200 450 440 450 H 1440" strokeWidth="1" opacity="0.55" />
        <path id="afl-u2" d="M 0 235 C 175 300 180 450 405 450 H 1440" strokeWidth="1" opacity="0.55" />
        <path id="afl-u3" d="M -40 -70 C 290 100 280 450 505 450 H 1440" strokeWidth="1" opacity="0.45" />
        <path id="afl-d1" d="M 0 860 C 200 770 200 450 440 450 H 1440" strokeWidth="1" opacity="0.55" />
        <path id="afl-d2" d="M 0 665 C 175 600 180 450 405 450 H 1440" strokeWidth="1" opacity="0.55" />
        <path id="afl-d3" d="M -40 970 C 290 800 280 450 505 450 H 1440" strokeWidth="1" opacity="0.45" />
      </g>
      {/* 小球：主干两颗 + 每条弧线一颗，速度/相位全部不同 */}
      <FlowBall pathId="afl-main" dur="11s" begin="-3s" />
      <FlowBall pathId="afl-main" dur="17s" begin="-11s" />
      <FlowBall pathId="afl-u1" dur="8.5s" begin="-2s" />
      <FlowBall pathId="afl-u2" dur="13s" begin="-6s" />
      <FlowBall pathId="afl-u3" dur="15.5s" begin="-9s" />
      <FlowBall pathId="afl-d1" dur="9.5s" begin="-5s" />
      <FlowBall pathId="afl-d2" dur="12s" begin="-1s" />
      <FlowBall pathId="afl-d3" dur="14.5s" begin="-7.5s" />
    </svg>
  );
}
