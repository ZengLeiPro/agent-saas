import { useRef, useCallback, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const LOCK_THRESHOLD = 10;    // 方向锁定阈值 px
const TRIGGER_DISTANCE = 100; // 触发刷新的最小下拉距离 px
const MAX_PULL = 200;         // 橡皮筋效果的最大拉距 px
const INDICATOR_H = 88;       // 指示器区域高度 / 刷新时内容保持下移量 px
const ANIM = "300ms cubic-bezier(.25,.1,.25,1)";
const SPOKE_COUNT = 8;

function rubberBand(distance: number): number {
  return MAX_PULL * (1 - Math.exp(-distance / MAX_PULL));
}

// --- Activity Spinner (8 辐射线条，空心圆环排列) ---

function ActivitySpinner() {
  // 线条不触及中心，形成空心环
  const size = 44;
  const r = size / 2;
  const inner = r * 0.38;  // 内半径：留出空心
  const outer = r * 0.7;   // 外半径
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {Array.from({ length: SPOKE_COUNT }, (_, i) => {
        const angle = (i * 360) / SPOKE_COUNT;
        const opacity = +(1 - (i / SPOKE_COUNT) * 0.75).toFixed(2);
        return (
          <line
            key={i}
            x1={r}
            y1={r - inner}
            x2={r}
            y2={r - outer}
            transform={`rotate(${angle} ${r} ${r})`}
            stroke="currentColor"
            strokeWidth={4}
            strokeLinecap="round"
            opacity={opacity}
          />
        );
      })}
    </svg>
  );
}

// --- PullToRefresh ---

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  className?: string;
}

export function PullToRefresh({ onRefresh, children, className }: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  const refreshingRef = useRef(false);
  const vibratedRef = useRef(false);

  const applyPosition = useCallback((y: number, animate: boolean, spinning = false) => {
    const content = contentRef.current;
    const ind = indicatorRef.current;
    if (!content || !ind) return;

    // transition
    content.style.transition = animate ? `transform ${ANIM}` : "none";
    ind.style.transition = animate ? `opacity ${ANIM}` : "none";

    // 内容下移
    content.style.transform = y > 0 ? `translateY(${y}px)` : "";

    // 指示器固定在原位，仅控制透明度；下拉未到 INDICATOR_H 之前不显示
    const progress = y < INDICATOR_H ? 0 : Math.min(1, (y - INDICATOR_H) / (TRIGGER_DISTANCE - INDICATOR_H));
    ind.style.opacity = String(progress);

    // 内部 SVG 旋转
    const svg = ind.querySelector("svg") as HTMLElement | null;
    if (!svg) return;
    if (spinning) {
      // steps(12) 跳跃旋转，模拟线条依次高亮
      svg.style.animation = `spin 0.7s steps(${SPOKE_COUNT}, end) infinite`;
      svg.style.transform = "";
    } else {
      svg.style.animation = "none";
      // 下拉跟手旋转 0-360°
      svg.style.transform = `rotate(${Math.min(1, y / TRIGGER_DISTANCE) * 360}deg)`;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let dirLocked: "h" | "v" | null = null;
    let pullDistance = 0;

    function findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
      while (el && el !== container) {
        const { overflowY } = getComputedStyle(el);
        if ((overflowY === "auto" || overflowY === "scroll") && el.scrollTop > 0) {
          return el;
        }
        el = el.parentElement;
      }
      return null;
    }

    function onTouchStart(e: TouchEvent) {
      if (refreshingRef.current) return;
      if (findScrollableAncestor(e.target as HTMLElement)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      dirLocked = null;
      pullDistance = 0;
      vibratedRef.current = false;
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;

      if (!dirLocked) {
        if (Math.abs(dx) < LOCK_THRESHOLD && Math.abs(dy) < LOCK_THRESHOLD) return;
        dirLocked = Math.abs(dy) >= Math.abs(dx) ? "v" : "h";
      }
      if (dirLocked === "h") { tracking = false; return; }

      if (dy <= 0) {
        pullDistance = 0;
        applyPosition(0, false);
        return;
      }

      e.preventDefault();
      pullDistance = rubberBand(dy);
      applyPosition(pullDistance, false);

      if (pullDistance >= TRIGGER_DISTANCE && !vibratedRef.current) {
        vibratedRef.current = true;
        navigator.vibrate?.(10);
      }
    }

    function onTouchEnd() {
      if (!tracking) return;
      tracking = false;

      if (pullDistance >= TRIGGER_DISTANCE) {
        applyPosition(INDICATOR_H, true, true);
        refreshingRef.current = true;
        // 保证 spinner 至少显示 600ms，避免本地快速响应时一闪而过
        const minDelay = new Promise<void>((r) => setTimeout(r, 600));
        Promise.all([onRefresh(), minDelay]).finally(() => {
          refreshingRef.current = false;
          applyPosition(0, true);
        });
      } else {
        applyPosition(0, true);
      }
      pullDistance = 0;
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [onRefresh, applyPosition]);

  return (
    <div ref={containerRef} className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {/* 指示器：固定在容器顶部，不随内容移动 */}
      <div
        ref={indicatorRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center text-muted-foreground"
        style={{ height: INDICATOR_H, opacity: 0 }}
      >
        <ActivitySpinner />
      </div>

      {/* 内容区：下拉时 translateY 下移，露出上方指示器 */}
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}
