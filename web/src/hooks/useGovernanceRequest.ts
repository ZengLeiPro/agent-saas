import { useCallback, useEffect, useRef, useState } from 'react';

export interface GovernanceRequestState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  retry: () => void;
}

/** Latest-request-wins guard prevents stale authoritative decisions from resurfacing. */
export function useGovernanceRequest<T>(
  request: (() => Promise<T>) | null,
  requestKey: string,
): GovernanceRequestState<T> {
  const generationRef = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const [state, setState] = useState<Omit<GovernanceRequestState<T>, 'retry'>>({
    data: null,
    loading: request !== null,
    error: null,
  });

  const load = useCallback(async () => {
    const currentRequest = requestRef.current;
    const generation = ++generationRef.current;
    if (!currentRequest) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    // Clear prior grants while a new authoritative result is pending (fail closed).
    setState({ data: null, loading: true, error: null });
    try {
      const data = await currentRequest();
      if (generation === generationRef.current) setState({ data, loading: false, error: null });
    } catch (cause) {
      if (generation !== generationRef.current) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setState({ data: null, loading: false, error });
    }
  }, [requestKey]);

  useEffect(() => {
    void load();
    return () => { generationRef.current += 1; };
  }, [load]);

  return { ...state, retry: load };
}
