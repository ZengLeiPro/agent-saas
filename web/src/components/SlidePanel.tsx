import { useRef, useEffect, useState, type ReactNode } from "react";

const ANIM = "350ms cubic-bezier(.25,.1,.25,1)";
const EDGE_WIDTH = 44;
const LOCK_THRESHOLD = 8;
const SWIPE_THRESHOLD = 0.2;
const VELOCITY_THRESHOLD = 0.3;

interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 从右侧滑入的全屏覆盖面板。
 * 支持左边缘右滑关闭手势（同 SwipeDrawer 参数）。
 * 关闭动画结束后 unmount children。
 */
export function SlidePanel({ open, onClose, children }: SlidePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 延迟卸载：关闭动画结束后才 unmount
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  // open 变化时驱动动画
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (open) {
      // 先设为 100%（屏幕外），下一帧滑入
      el.style.transition = "none";
      el.style.transform = "translateX(100%)";
      requestAnimationFrame(() => {
        el.style.transition = `transform ${ANIM}`;
        el.style.transform = "translateX(0)";
      });
    } else {
      // 手势关闭时 transform 已经是 translateX(100%)，
      // 再次设置相同值不会触发 transitionend，由 fallback 超时兜底 unmount
      el.style.transition = `transform ${ANIM}`;
      el.style.transform = "translateX(100%)";
      const onEnd = () => setMounted(false);
      el.addEventListener("transitionend", onEnd, { once: true });
      const fallback = setTimeout(onEnd, 400);
      return () => {
        clearTimeout(fallback);
        el.removeEventListener("transitionend", onEnd);
      };
    }
  }, [open]);

  // 左边缘右滑关闭手势
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let prevX = 0;
    let prevTime = 0;
    let tracking = false;
    let dirLocked: "h" | "v" | null = null;
    let width = 0;

    function onTouchStart(e: TouchEvent) {
      if (!openRef.current) return;
      const touch = e.touches[0];
      if (touch.clientX > EDGE_WIDTH) return;

      // 在边缘区域立即 preventDefault，阻止浏览器合成器线程
      // 将此触摸预判为滚动（否则后续 touchmove 的 cancelable 会变 false）
      e.preventDefault();

      width = el!.clientWidth;
      startX = touch.clientX;
      startY = touch.clientY;
      prevX = startX;
      prevTime = e.timeStamp;
      tracking = true;
      dirLocked = null;
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!dirLocked) {
        if (Math.abs(dx) < LOCK_THRESHOLD && Math.abs(dy) < LOCK_THRESHOLD) return;
        dirLocked = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      }
      if (dirLocked === "v") { tracking = false; return; }

      // 只响应右滑（关闭方向）
      if (dx <= 0) return;

      if (e.cancelable) e.preventDefault();
      prevX = touch.clientX;
      prevTime = e.timeStamp;

      const progress = Math.min(1, dx / width);
      el!.style.transition = "none";
      el!.style.transform = `translateX(${progress * 100}%)`;
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking) return;
      tracking = false;
      if (!width) return;

      const dt = e.timeStamp - prevTime || 1;
      const velocity = (prevX - startX) / dt;

      const matrix = new DOMMatrixReadOnly(getComputedStyle(el!).transform);
      const progress = matrix.m41 / width;

      if (progress > SWIPE_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
        el!.style.transition = `transform ${ANIM}`;
        el!.style.transform = "translateX(100%)";
        onCloseRef.current();
      } else {
        el!.style.transition = `transform ${ANIM}`;
        el!.style.transform = "translateX(0)";
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [mounted]);

  if (!mounted) return null;

  return (
    <div
      ref={panelRef}
      className="absolute inset-0 z-20 flex flex-col bg-background"
      style={{
        transform: "translateX(100%)",
        willChange: "transform",
      }}
    >
      {children}
    </div>
  );
}
