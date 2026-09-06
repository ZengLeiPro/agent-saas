import { useEffect, useRef, useCallback } from "react";
import { wsClient } from "@agent/shared";
import { CANONICAL_REACHABILITY_EVENT, webReachability } from "@/lib/lifecycleAdapter";
import { apiUrl } from "@/lib/apiBase";

export interface AppLifecycleCallbacks {
  /** 仅在后台数据已经陈旧，或从 bfcache 恢复时调用。 */
  onResume: () => void;
  onSuspend: () => void;
}

const BACKGROUND_WS_GRACE_MS = 3_000;
const STALE_DATA_THRESHOLD_MS = 30_000;
const NETWORK_DEBOUNCE_MS = 750;
const RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

interface PendingRecovery {
  forceReconnect: boolean;
  refreshData: boolean;
}

/** Web 前后台适配：短暂切换不刷新数据，传输恢复与陈旧数据重验分开处理。 */
export function useAppLifecycle(callbacks: AppLifecycleCallbacks) {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const generationRef = useRef(0);
  const backgroundedAtRef = useRef<number | null>(null);
  const staleDataRef = useRef(false);
  const detachedRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRecoveryRef = useRef<PendingRecovery | null>(null);
  const activeRecoveryRef = useRef<PendingRecovery | null>(null);
  const activeRecoveryGenerationRef = useRef<number | null>(null);
  const recoveryRetryRef = useRef(0);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
    pendingRecoveryRef.current = null;
  }, []);

  const suspend = useCallback(() => {
    if (backgroundedAtRef.current !== null) return;
    generationRef.current += 1;
    clearRecoveryTimer();
    backgroundedAtRef.current = Date.now();
    cbRef.current.onSuspend();
    wsClient.suspendNonEssentialTransport();
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (document.visibilityState === "visible") return;
      // detach 与 disconnect 必须同时在宽限期到期后执行；短暂切页不能留下 detached 标记。
      if (wsClient.isConnected) wsClient.send({ action: "detach" });
      wsClient.disconnect();
      detachedRef.current = true;
    }, BACKGROUND_WS_GRACE_MS);
  }, [clearCloseTimer, clearRecoveryTimer]);

  const scheduleRecovery = useCallback((next: PendingRecovery, delayMs = NETWORK_DEBOUNCE_MS) => {
    // health / reconnect 已经在执行时，直接把新要求并入同一周期；不再启动第二个副作用链。
    if (activeRecoveryRef.current && activeRecoveryGenerationRef.current === generationRef.current) {
      activeRecoveryRef.current.forceReconnect ||= next.forceReconnect;
      activeRecoveryRef.current.refreshData ||= next.refreshData;
      return;
    }
    const pending = pendingRecoveryRef.current;
    pendingRecoveryRef.current = {
      forceReconnect: Boolean(pending?.forceReconnect || next.forceReconnect),
      refreshData: Boolean(pending?.refreshData || next.refreshData),
    };
    // 上一代 recovery 尚未 settle 时只排队；它结束后再串行处理，避免并发 forceReconnect。
    if (activeRecoveryRef.current) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      const recovery = pendingRecoveryRef.current;
      pendingRecoveryRef.current = null;
      if (!recovery || generation !== generationRef.current || document.visibilityState !== "visible") return;
      activeRecoveryRef.current = recovery;
      activeRecoveryGenerationRef.current = generation;
      let retry: PendingRecovery | null = null;
      void (async () => {
        try {
          // navigator.onLine=true 只是提示；成功的 HTTP 交换才证明服务可达。
          await fetch(apiUrl("/api/health"), { method: "HEAD", cache: "no-store" });
          window.dispatchEvent(new CustomEvent<boolean>(CANONICAL_REACHABILITY_EVENT, { detail: true }));
        } catch {
          window.dispatchEvent(new CustomEvent<boolean>(CANONICAL_REACHABILITY_EVENT, { detail: false }));
          if (generation === generationRef.current && document.visibilityState === "visible" && navigator.onLine) {
            retry = { ...recovery };
          }
          return;
        }
        if (generation !== generationRef.current || document.visibilityState !== "visible") return;
        recoveryRetryRef.current = 0;
        // HTTP 数据同步不能等待可能长期 pending 的 WS 握手。
        if (recovery.refreshData || staleDataRef.current) {
          staleDataRef.current = false;
          cbRef.current.onResume();
          recovery.refreshData = false;
        }
        if (recovery.forceReconnect || detachedRef.current || !wsClient.isConnected) {
          try {
            await wsClient.forceReconnect();
          } catch {
            // 后续 connected listener / ensureConnectedSend 仍可继续受控恢复。
          }
        }
        if (generation !== generationRef.current || document.visibilityState !== "visible") return;
        detachedRef.current = false;
        // forceReconnect pending 期间到达的 stale 事件也并入本轮，不再等待第二次网络恢复。
        if (recovery.refreshData || staleDataRef.current) {
          staleDataRef.current = false;
          cbRef.current.onResume();
        }
      })().finally(() => {
        activeRecoveryRef.current = null;
        activeRecoveryGenerationRef.current = null;
        if (document.visibilityState !== "visible" || !navigator.onLine) return;
        const queued = pendingRecoveryRef.current;
        pendingRecoveryRef.current = null;
        if (queued) {
          scheduleRecovery(queued);
          return;
        }
        if (!retry || generation !== generationRef.current) return;
        const retryIndex = recoveryRetryRef.current;
        if (retryIndex >= RECOVERY_RETRY_DELAYS_MS.length) return;
        recoveryRetryRef.current += 1;
        scheduleRecovery(retry, RECOVERY_RETRY_DELAYS_MS[retryIndex]);
      });
    }, delayMs);
  }, []);

  const recover = useCallback((options: {
    forceTransport?: boolean;
    refreshData?: boolean;
    verifyReachability?: boolean;
  } = {}) => {
    clearCloseTimer();
    if (document.visibilityState !== "visible") return;
    const backgroundedAt = backgroundedAtRef.current;
    backgroundedAtRef.current = null;
    if (backgroundedAt !== null && Date.now() - backgroundedAt >= STALE_DATA_THRESHOLD_MS) {
      staleDataRef.current = true;
    }
    if (webReachability(navigator.onLine, null) === false) {
      generationRef.current += 1;
      clearRecoveryTimer();
      window.dispatchEvent(new CustomEvent<boolean>(CANONICAL_REACHABILITY_EVENT, { detail: false }));
      return;
    }

    // 解除 suspend 不依赖健康检查成功，避免一次探针失败把 heartbeat/retry 永久冻结。
    wsClient.resumeNonEssentialTransport();
    const forceReconnect = options.forceTransport === true;
    const needsTransportRecovery = forceReconnect || detachedRef.current || !wsClient.isConnected;
    if (options.refreshData === true) staleDataRef.current = true;
    const refreshData = staleDataRef.current;
    if (!needsTransportRecovery && !refreshData && options.verifyReachability !== true) return;
    scheduleRecovery({ forceReconnect, refreshData });
  }, [clearCloseTimer, clearRecoveryTimer, scheduleRecovery]);

  const handleVisibilityChange = useCallback(() => {
    if (document.visibilityState === "visible") recover();
    else suspend();
  }, [recover, suspend]);

  const handlePageShow = useCallback((event: PageTransitionEvent) => {
    if (event.persisted) recover({ forceTransport: true, refreshData: true });
  }, [recover]);

  useEffect(() => {
    const handleOnline = () => {
      if (document.visibilityState === "visible") recover({ verifyReachability: true });
    };
    const handleOffline = () => {
      generationRef.current += 1;
      clearRecoveryTimer();
      wsClient.suspendNonEssentialTransport();
      window.dispatchEvent(new CustomEvent<boolean>(CANONICAL_REACHABILITY_EVENT, { detail: false }));
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    // StrictMode 重挂载或路由边界后，不能继承上一个实例留下的 suspended 状态；首次挂载不做网络恢复。
    if (document.visibilityState === "visible" && navigator.onLine) wsClient.resumeNonEssentialTransport();
    return () => {
      generationRef.current += 1;
      clearCloseTimer();
      clearRecoveryTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [clearCloseTimer, clearRecoveryTimer, handlePageShow, handleVisibilityChange, recover]);
}
