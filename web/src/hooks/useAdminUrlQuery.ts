import { useCallback, useEffect, useMemo, useState } from "react";

type QueryValue = string | number | boolean | null | undefined;

function currentSearch() {
  return typeof window === "undefined" ? "" : window.location.search;
}

function replaceSearch(params: URLSearchParams) {
  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", next);
}

export function useAdminUrlQuery() {
  const [search, setSearch] = useState(currentSearch);

  useEffect(() => {
    const onPopstate = () => setSearch(currentSearch());
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, []);

  const query = useMemo(() => new URLSearchParams(search), [search]);

  const replace = useCallback((recipe: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(window.location.search);
    recipe(params);
    replaceSearch(params);
    setSearch(window.location.search);
  }, []);

  const set = useCallback((key: string, value: QueryValue) => {
    replace((params) => {
      if (value === null || value === undefined || value === "") params.delete(key);
      else params.set(key, String(value));
    });
  }, [replace]);

  const patch = useCallback((values: Record<string, QueryValue>) => {
    replace((params) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === undefined || value === "") params.delete(key);
        else params.set(key, String(value));
      }
    });
  }, [replace]);

  const clear = useCallback((keys?: string[]) => {
    replace((params) => {
      if (!keys) {
        for (const key of Array.from(params.keys())) params.delete(key);
        return;
      }
      for (const key of keys) params.delete(key);
    });
  }, [replace]);

  return {
    query,
    get: (key: string) => query.get(key),
    set,
    patch,
    clear,
    replace,
  };
}
