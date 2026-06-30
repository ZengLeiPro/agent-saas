import { useRef, useCallback, useEffect, useState, type ReactNode } from "react";

const ANIM = "350ms cubic-bezier(.25,.1,.25,1)";
const EDGE_WIDTH = 44;       // 边缘触发区域 px（≈ iOS 返回手势热区）
const LOCK_THRESHOLD = 8;    // 方向锁定阈值 px
const SWIPE_THRESHOLD = 0.2; // 触发切换的位移比例（屏幕宽度的 20%）
const VELOCITY_THRESHOLD = 0.3; // 速度阈值 px/ms，快速轻扫直接触发

interface SwipeDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 左侧列表面板 */
  listPanel: ReactNode;
  /** 右侧详情面板 */
  detailPanel: ReactNode;
}

/**
 * 移动端双面板推滑容器。
 * open=true 时显示列表面板，open=false 时显示详情面板。
 * 两个面板平级放置，通过 translateX 同步推滑切换。
 * 支持从左侧边缘右滑打开侧边栏。
 */
export function SwipeDrawer({ open, onOpenChange, listPanel, detailPanel }: SwipeDrawerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const prevOpen = useRef(open);
  const openRef = useRef(open);
  openRef.current = open;

  // 延迟挂载列表面板：首次打开前不渲染，避免无谓开销
  const [listMounted, setListMounted] = useState(open);
  if (open && !listMounted) setListMounted(true);

  const applyTransform = useCallback((toOpen: boolean, animate: boolean) => {
    const l = listRef.current, d = detailRef.current;
    if (!l || !d) return;
    const transition = animate ? `transform ${ANIM}` : "none";
    l.style.transition = transition;
    d.style.transition = transition;
    l.style.transform = toOpen ? "translateX(0)" : "translateX(-100%)";
    d.style.transform = toOpen ? "translateX(100%)" : "translateX(0)";
  }, []);

  // open 变化时带动画切换
  useEffect(() => {
    if (open === prevOpen.current) return;
    prevOpen.current = open;
    applyTransform(open, true);
  }, [open, applyTransform]);

  // 首次挂载时设置初始位置（无动画）
  useEffect(() => {
    applyTransform(open, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 边缘滑动手势：关闭时从左侧边缘右滑打开
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let startX = 0;
    let startY = 0;
    let prevX = 0;
    let prevTime = 0;
    let tracking = false;
    let dirLocked: "h" | "v" | null = null;
    let width = 0;

    function onTouchStart(e: TouchEvent) {
      // 侧边栏已打开时不处理手势
      if (openRef.current) return;

      const touch = e.touches[0];
      // 仅从左侧边缘开始
      if (touch.clientX > EDGE_WIDTH) return;

      width = container!.clientWidth;
      startX = touch.clientX;
      startY = touch.clientY;
      prevX = startX;
      prevTime = e.timeStamp;
      tracking = true;
      dirLocked = null;
      // 确保列表面板已挂载，以便跟手时可见
      setListMounted(true);
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      // 方向锁定
      if (!dirLocked) {
        if (Math.abs(dx) < LOCK_THRESHOLD && Math.abs(dy) < LOCK_THRESHOLD) return;
        dirLocked = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      }
      if (dirLocked === "v") { tracking = false; return; }

      // 只响应右滑
      if (dx <= 0) return;

      e.preventDefault();

      prevX = touch.clientX;
      prevTime = e.timeStamp;

      const progress = Math.min(1, dx / width);

      const l = listRef.current, d = detailRef.current;
      if (!l || !d) return;
      l.style.transition = "none";
      d.style.transition = "none";
      l.style.transform = `translateX(${-100 + progress * 100}%)`;
      d.style.transform = `translateX(${progress * 100}%)`;
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking) return;
      tracking = false;

      const d = detailRef.current;
      if (!d || !width) return;

      // 用末段速度判断是否为快速轻扫
      const dt = e.timeStamp - prevTime || 1;
      const velocity = (prevX - startX) / dt; // px/ms，正值=右滑

      const matrix = new DOMMatrixReadOnly(getComputedStyle(d).transform);
      const progress = matrix.m41 / width;

      const isFastSwipe = velocity > VELOCITY_THRESHOLD;

      if (progress > SWIPE_THRESHOLD || isFastSwipe) {
        applyTransform(true, true);
        onOpenChange(true);
      } else {
        applyTransform(false, true);
      }
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
  }, [applyTransform, onOpenChange]);

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden md:hidden">
      {/* 列表面板：绝对定位，铺满容器 */}
      <div
        ref={listRef}
        className="absolute inset-0 flex flex-col bg-background"
        style={{
          transform: "translateX(-100%)",
          willChange: "transform",
        }}
      >
        {listMounted && listPanel}
      </div>

      {/* 详情面板：绝对定位，铺满容器 */}
      <div
        ref={detailRef}
        className="absolute inset-0 flex flex-col bg-background"
        style={{
          transform: "translateX(0)",
          willChange: "transform",
        }}
      >
        {detailPanel}
      </div>
    </div>
  );
}
