/** Server-resolved model options only; this does not grant model visibility or runtime permissions. */
export function isSubscriptionTransport(
  transport: unknown,
): transport is 'codex_subscription' | 'grok_subscription' {
  return transport === 'codex_subscription' || transport === 'grok_subscription';
}
export function modelRequiresApiKey(options: { responsesTransport?: string } | undefined): boolean {
  return !isSubscriptionTransport(options?.responsesTransport);
}
