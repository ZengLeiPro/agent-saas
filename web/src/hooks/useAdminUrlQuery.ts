import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type QueryValue = string | number | boolean | null | undefined;

/** 文本输入的默认历史合并窗口：一次连续输入只留一条历史记录，而不是每个字符一条 */
export const QUERY_MERGE_MS = 500;

export interface QueryUpdateOptions {
  /**
   * `replace`（默认）= replaceState，程序性同步、分页游标、受控回填走这里，不污染历史栈。
   * `push` = pushState，**用户显式**的筛选动作走这里，浏览器后退可逐步撤销。
   *
   * 说明：改造前全部走 replace，后果不是「下钻后返回丢筛选」（后退拿到的是被覆盖后的条目，
   * 筛选还在），而是「页内连续调 5 次筛选，后退键一次把用户踢出整页」——撤销粒度问题。
   */
  history?: "push" | "replace";
  /**
   * 合并窗口（ms）。>0 且 history='push' 时：一段连续变更只在**首次**创建历史条目，
   * 窗口内的后续变更 replace 在同一条目上；静默超过窗口后下一次变更重新开一条。
   * 文本输入必须传（否则每个字符一条历史记录），默认 `QUERY_MERGE_MS`。
   */
  mergeMs?: number;
  /**
   * 合并分组标识。默认取本次变更涉及的 key 排序后拼接——即「同一个输入框连续打字」合并成一条，
   * 换到另一个输入框则另起一条。
   */
  mergeKey?: string;
}

/** 用户显式的离散筛选动作（下拉、分段控件、页签）：直接进历史栈 */
export const HISTORY_PUSH: QueryUpdateOptions = { history: "push" };
/** 用户显式的文本/日期输入：进历史栈，但一次连续输入只留一条 */
export const HISTORY_PUSH_MERGED: QueryUpdateOptions = { history: "push", mergeMs: QUERY_MERGE_MS };

function currentSearch() {
  return typeof window === "undefined" ? "" : window.location.search;
}

function nextHref(params: URLSearchParams) {
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

function replaceSearch(params: URLSearchParams) {
  window.history.replaceState({}, "", nextHref(params));
}

function pushSearch(params: URLSearchParams) {
  window.history.pushState({}, "", nextHref(params));
}

function applyValues(params: URLSearchParams, values: Record<string, QueryValue>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, String(value));
  }
}

export function useAdminUrlQuery() {
  const [search, setSearch] = useState(currentSearch);
  /** 当前进行中的历史合并分组：同 key 且未超时 → 复用已创建的历史条目 */
  const burstRef = useRef<{ key: string; expiresAt: number } | null>(null);

  useEffect(() => {
    const onPopstate = () => {
      // 用户自己动了历史栈，之前的合并分组作废，下一次显式筛选必须新开条目
      burstRef.current = null;
      setSearch(currentSearch());
    };
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, []);

  const query = useMemo(() => new URLSearchParams(search), [search]);

  /**
   * 唯一的写入口。recipe 收到当前 URL 的真实 params（不是 render 时的快照），
   * 避免同一 tick 内多次调用互相覆盖。
   */
  const update = useCallback((
    recipe: (params: URLSearchParams) => void,
    options: QueryUpdateOptions = {},
    mergeKeyFallback?: string,
  ) => {
    const params = new URLSearchParams(window.location.search);
    recipe(params);
    const target = nextHref(params);
    // URL 没变就什么都不做：避免受控输入回填、重复点击同一个筛选值造出空历史条目
    if (target === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      setSearch(window.location.search);
      return;
    }

    if (options.history !== "push") {
      replaceSearch(params);
      setSearch(window.location.search);
      return;
    }

    const mergeMs = options.mergeMs ?? 0;
    if (mergeMs <= 0) {
      burstRef.current = null;
      pushSearch(params);
      setSearch(window.location.search);
      return;
    }

    const mergeKey = options.mergeKey ?? mergeKeyFallback ?? "";
    const now = Date.now();
    const burst = burstRef.current;
    if (burst && burst.key === mergeKey && burst.expiresAt > now) {
      // 同一次连续输入：改写已创建的那条历史条目
      replaceSearch(params);
    } else {
      pushSearch(params);
    }
    burstRef.current = { key: mergeKey, expiresAt: now + mergeMs };
    setSearch(window.location.search);
  }, []);

  /** 保留原名：始终 replaceState（既有调用点语义不变） */
  const replace = useCallback((recipe: (params: URLSearchParams) => void) => {
    update(recipe, { history: "replace" });
  }, [update]);

  const set = useCallback((key: string, value: QueryValue, options?: QueryUpdateOptions) => {
    update((params) => applyValues(params, { [key]: value }), options, key);
  }, [update]);

  const patch = useCallback((values: Record<string, QueryValue>, options?: QueryUpdateOptions) => {
    update((params) => applyValues(params, values), options, Object.keys(values).sort().join("|"));
  }, [update]);

  const clear = useCallback((keys?: string[], options?: QueryUpdateOptions) => {
    update((params) => {
      if (!keys) {
        for (const key of Array.from(params.keys())) params.delete(key);
        return;
      }
      for (const key of keys) params.delete(key);
    }, options, keys ? keys.slice().sort().join("|") : "*");
  }, [update]);

  return {
    query,
    get: (key: string) => query.get(key),
    set,
    patch,
    clear,
    replace,
    update,
  };
}
