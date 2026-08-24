import { useCallback, useEffect, useRef, useState } from "react";

import type { ContextCenterApiPort, ContextCenterSnapshot } from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "请求失败，请稍后重试";
}

export function useContextCenter(api: ContextCenterApiPort) {
  const [snapshot, setSnapshot] = useState<ContextCenterSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const snapshotRequest = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    snapshotRequest.current?.abort();
    const controller = new AbortController();
    snapshotRequest.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await api.getSnapshot({ signal: controller.signal });
      if (!controller.signal.aborted) setSnapshot(next);
    } catch (requestError) {
      if (!controller.signal.aborted) setError(errorMessage(requestError));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
    return () => snapshotRequest.current?.abort();
  }, [reload]);

  return { snapshot, loading, error, reload };
}
