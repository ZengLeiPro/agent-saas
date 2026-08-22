import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ContextCenterApiPort,
  ContextCenterSnapshot,
  ContextEvidence,
  ContextSource,
} from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "请求失败，请稍后重试";
}

export function useContextCenter(api: ContextCenterApiPort) {
  const [snapshot, setSnapshot] = useState<ContextCenterSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const snapshotRequest = useRef<AbortController | null>(null);

  const [evidenceSource, setEvidenceSource] = useState<ContextSource | null>(null);
  const [evidence, setEvidence] = useState<ContextEvidence[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const evidenceRequest = useRef<AbortController | null>(null);

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

  const loadEvidence = useCallback(async (source: ContextSource) => {
    evidenceRequest.current?.abort();
    const controller = new AbortController();
    evidenceRequest.current = controller;
    setEvidenceSource(source);
    setEvidence([]);
    setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const items = await api.listEvidence(
        { sourceId: source.sourceId, collectionId: source.collectionId },
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setEvidence(items);
    } catch (requestError) {
      if (!controller.signal.aborted) setEvidenceError(errorMessage(requestError));
    } finally {
      if (!controller.signal.aborted) setEvidenceLoading(false);
    }
  }, [api]);

  const closeEvidence = useCallback(() => {
    evidenceRequest.current?.abort();
    setEvidenceSource(null);
    setEvidence([]);
    setEvidenceError(null);
    setEvidenceLoading(false);
  }, []);

  useEffect(() => () => evidenceRequest.current?.abort(), []);

  return {
    snapshot,
    loading,
    error,
    reload,
    evidenceSource,
    evidence,
    evidenceLoading,
    evidenceError,
    loadEvidence,
    closeEvidence,
  };
}
