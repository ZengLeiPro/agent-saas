/** Local-only request policy: not serialized as a header or sent to the provider. */
const SINGLE_ATTEMPT = Symbol.for('agent-saas.egress.single-attempt');
type EgressRequestInit = RequestInit & { [SINGLE_ATTEMPT]?: true };
export function isSingleAttemptEgressRequest(init?: RequestInit): boolean {
  return (init as EgressRequestInit | undefined)?.[SINGLE_ATTEMPT] === true;
}
/** Rotating OAuth grants and uncertain model requests must never be replayed by proxy fallback. */
export function singleAttemptEgressFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) =>
    fetchImpl(input, { ...init, [SINGLE_ATTEMPT]: true } as EgressRequestInit);
}
