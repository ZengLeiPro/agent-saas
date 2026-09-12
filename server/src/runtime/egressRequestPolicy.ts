/** Local-only request policy: not serialized as a header or sent to the provider. */
const SINGLE_ATTEMPT = Symbol.for('agent-saas.egress.single-attempt');
const PROXY_REQUIRED = Symbol.for('agent-saas.egress.proxy-required');
type EgressRequestInit = RequestInit & {
  [SINGLE_ATTEMPT]?: true;
  [PROXY_REQUIRED]?: true;
};
export function isSingleAttemptEgressRequest(init?: RequestInit): boolean {
  return (init as EgressRequestInit | undefined)?.[SINGLE_ATTEMPT] === true;
}
export function isProxyRequiredEgressRequest(init?: RequestInit): boolean {
  return (init as EgressRequestInit | undefined)?.[PROXY_REQUIRED] === true;
}
/** Rotating OAuth grants and uncertain model requests must never be replayed by proxy fallback. */
export function singleAttemptEgressFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) =>
    fetchImpl(input, { ...init, [SINGLE_ATTEMPT]: true } as EgressRequestInit);
}
/** Subscription credentials and prompts for Grok must never leave through a direct connection. */
export function proxyRequiredSingleAttemptEgressFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) =>
    fetchImpl(input, {
      ...init,
      [SINGLE_ATTEMPT]: true,
      [PROXY_REQUIRED]: true,
    } as EgressRequestInit);
}
