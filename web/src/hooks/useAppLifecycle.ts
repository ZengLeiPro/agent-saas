import { useEffect, useRef, useCallback } from "react";

export interface AppLifecycleCallbacks {
  /** 页面从后台恢复且超过阈值时调用，用于刷新数据 */
  onResume: () => void;
  /** 页面进入后台时调用，用于保存状态快照 */
  onSuspend: () => void;
}

/** iOS PWA 后台超过此时长（ms）后恢复时触发 onResume */
const STALE_THRESHOLD_MS = 30_000;

/**
 * iOS PWA 生命周期管理。
 *
 * 处理两种恢复场景：
 * 1. visibilitychange (hidden → visible)：进程未被杀，但后台时间过长需要刷新数据
 * 2. pageshow (persisted = true)：bfcache 恢复，必须刷新所有数据
 */
export function useAppLifecycle(callbacks: AppLifecycleCallbacks) {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const lastHiddenAtRef = useRef(0);

  const handleVisibilityChange = useCallback(() => {
    if (document.visibilityState === "hidden") {
      lastHiddenAtRef.current = Date.now();
      cbRef.current.onSuspend();
    } else if (document.visibilityState === "visible") {
      const elapsed = Date.now() - lastHiddenAtRef.current;
      if (lastHiddenAtRef.current > 0 && elapsed > STALE_THRESHOLD_MS) {
        cbRef.current.onResume();
      }
    }
  }, []);

  const handlePageShow = useCallback((event: PageTransitionEvent) => {
    if (event.persisted) {
      cbRef.current.onResume();
    }
  }, []);

  useEffect(() => {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [handleVisibilityChange, handlePageShow]);
}
