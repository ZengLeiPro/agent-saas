import { useCallback, useEffect, useRef, useState } from "react";
import { searchSessions, type SessionSearchHit } from "@/lib/searchApi";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 20;

export function useSessionSearch(query: string) {
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nonceRef = useRef(0);

  const trimmedQuery = query.trim();

  useEffect(() => {
    const nonce = ++nonceRef.current;
    if (!trimmedQuery) {
      setHits([]);
      setNextCursor(undefined);
      setHasMore(false);
      setIsSearching(false);
      setIsLoadingMore(false);
      setError(null);
      return;
    }

    setIsSearching(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void searchSessions({ q: trimmedQuery, limit: SEARCH_LIMIT })
        .then((result) => {
          if (nonceRef.current !== nonce) return;
          setHits(result.hits);
          setNextCursor(result.nextCursor);
          setHasMore(result.hasMore);
        })
        .catch((err) => {
          if (nonceRef.current !== nonce) return;
          setHits([]);
          setNextCursor(undefined);
          setHasMore(false);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (nonceRef.current === nonce) setIsSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [trimmedQuery]);

  const loadMore = useCallback(async () => {
    if (!trimmedQuery || !hasMore || !nextCursor || isLoadingMore) return;
    const nonce = nonceRef.current;
    setIsLoadingMore(true);
    setError(null);
    try {
      const result = await searchSessions({
        q: trimmedQuery,
        limit: SEARCH_LIMIT,
        cursor: nextCursor,
      });
      if (nonceRef.current !== nonce) return;
      setHits((prev) => [...prev, ...result.hits]);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      if (nonceRef.current !== nonce) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (nonceRef.current === nonce) setIsLoadingMore(false);
    }
  }, [trimmedQuery, hasMore, nextCursor, isLoadingMore]);

  return {
    hits,
    hasMore,
    isSearching,
    isLoadingMore,
    error,
    loadMore,
  };
}
