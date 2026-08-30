const directLoopbackFetch = globalThis.fetch.bind(globalThis);

export function isLoopbackControlPlane(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

/**
 * Staging 全局 fetch 必须保持全量代理且 fail-closed；同机 ACS orchestrator 则是
 * 已由启动门禁校验过的内部控制面，不能被送入 Squid。显式测试注入始终优先。
 */
export function controlPlaneFetch(baseUrl: string, injectedFetch?: typeof fetch): typeof fetch {
  if (injectedFetch) return injectedFetch;
  return isLoopbackControlPlane(baseUrl) ? directLoopbackFetch : fetch;
}
