import { useCallback, useEffect, useRef, type ReactNode } from "react";

export interface SwipeAction {
  key: string;
  label: string;
  className: string;
  onClick: () => void;
}

interface SwipeableRowProps {
  children: ReactNode;
  /** 操作按钮列表（从左到右排列，最右侧为最后一个） */
  actions: SwipeAction[];
  /** 单个操作按钮宽度（px），默认 72 */
  actionWidth?: number;
  /** 外部控制：当前打开的行 id */
  openId?: string | null;
  /** 本行的 id */
  rowId: string;
  /** 通知父组件哪一行被打开 */
  onOpenChange?: (id: string | null) => void;
  disabled?: boolean;
}

const THRESHOLD_RATIO = 0.4;
const ANIM = "transform 200ms cubic-bezier(.25,.46,.45,.94)";
const LOCK_THRESHOLD = 10; // 方向锁定需要的最小位移（px）

export function SwipeableRow({
  children,
  actions,
  actionWidth = 72,
  openId,
  rowId,
  onOpenChange,
  disabled,
}: SwipeableRowProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const baseOffset = useRef(0);
  const isTracking = useRef(false);
  const directionLocked = useRef<"h" | "v" | null>(null);
  const isOpen = openId === rowId;

  const totalWidth = actions.length * actionWidth;

  // 外部关闭时动画归位
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    if (!isOpen) {
      el.style.transition = ANIM;
      el.style.transform = "translateX(0)";
    }
  }, [isOpen]);

  const snapTo = useCallback(
    (open: boolean) => {
      const el = rowRef.current;
      if (!el) return;
      el.style.transition = ANIM;
      el.style.transform = open ? `translateX(-${totalWidth}px)` : "translateX(0)";
      onOpenChange?.(open ? rowId : null);
    },
    [totalWidth, rowId, onOpenChange],
  );

  // 使用原生事件以便 preventDefault 阻止纵向滚动与水平滑动互相干扰
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    function handleTouchStart(e: TouchEvent) {
      if (disabled) return;
      const touch = e.touches[0];
      startX.current = touch.clientX;
      startY.current = touch.clientY;
      baseOffset.current = isOpen ? -totalWidth : 0;
      isTracking.current = true;
      directionLocked.current = null;
      const el = rowRef.current;
      if (el) el.style.transition = "none";
    }

    function handleTouchMove(e: TouchEvent) {
      if (!isTracking.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX.current;
      const dy = touch.clientY - startY.current;

      // 方向锁定
      if (!directionLocked.current) {
        if (Math.abs(dx) < LOCK_THRESHOLD && Math.abs(dy) < LOCK_THRESHOLD) return;
        directionLocked.current = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      }

      if (directionLocked.current === "v") {
        // 纵向滚动，放弃追踪
        isTracking.current = false;
        return;
      }

      // 水平滑动：阻止页面滚动
      e.preventDefault();

      let offset = baseOffset.current + dx;
      offset = Math.max(-totalWidth, Math.min(0, offset));

      const el = rowRef.current;
      if (el) el.style.transform = `translateX(${offset}px)`;
    }

    function handleTouchEnd() {
      if (!isTracking.current) return;
      isTracking.current = false;

      const el = rowRef.current;
      if (!el) return;

      const style = getComputedStyle(el);
      const matrix = new DOMMatrixReadOnly(style.transform);
      const tx = matrix.m41;
      const threshold = totalWidth * THRESHOLD_RATIO;

      if (isOpen) {
        snapTo(tx < -totalWidth + threshold);
      } else {
        snapTo(tx < -threshold);
      }
    }

    wrapper.addEventListener("touchstart", handleTouchStart, { passive: true });
    wrapper.addEventListener("touchmove", handleTouchMove, { passive: false });
    wrapper.addEventListener("touchend", handleTouchEnd, { passive: true });
    wrapper.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      wrapper.removeEventListener("touchstart", handleTouchStart);
      wrapper.removeEventListener("touchmove", handleTouchMove);
      wrapper.removeEventListener("touchend", handleTouchEnd);
      wrapper.removeEventListener("touchcancel", handleTouchEnd);
    };
    // isOpen / disabled 会变化，需要重新绑定以获取最新闭包值
  }, [isOpen, disabled, totalWidth, snapTo]);

  return (
    <div ref={wrapperRef} className="relative overflow-hidden rounded-lg">
      {/* 底层：操作按钮区域，绝对定位在右侧，z-0 */}
      <div
        className="absolute inset-y-0 right-0 z-0 flex"
        style={{ width: totalWidth }}
      >
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={`flex flex-1 items-center justify-center text-sm font-medium active:brightness-90 ${action.className}`}
            onClick={(e) => {
              e.stopPropagation();
              snapTo(false);
              action.onClick();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* 上层：内容行，z-10 + 不透明背景确保完全覆盖底层按钮 */}
      <div
        ref={rowRef}
        className="relative z-10 bg-background"
        style={{ transform: "translate3d(0,0,0)" }}
      >
        {children}
      </div>
    </div>
  );
}
