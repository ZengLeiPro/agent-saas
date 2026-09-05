import { hasUnresolvedHandProvisionFailure, type HandRecord, type HandStatus } from '../runtime/handStore.js';
import { DEFAULT_INVOKE_TIMEOUT_MS } from '../runtime/httpTransport.js';

/** 持久化未知结果防重放栅栏不代表启动失败；只在原请求的有界窗口内展示准备中。 */
export function tenantHandRuntimeStatus(hand: HandRecord, now = Date.now()): HandStatus {
  const metadata = hand.metadata;
  if (hand.status !== 'unhealthy' || hasUnresolvedHandProvisionFailure(hand)
    || metadata.dispatchAuthorized !== true || metadata.reconcileRequired !== true
    || metadata.provisionResult !== 'result_unknown'
    || typeof metadata.provisionDispatchClaim !== 'string' || !metadata.provisionDispatchClaim
    || typeof metadata.provisionDispatchClaimedAt !== 'string') return hand.status;
  const claimedAt = Date.parse(metadata.provisionDispatchClaimedAt);
  const timeoutMs = typeof metadata.invokeTimeoutMs === 'number' && Number.isFinite(metadata.invokeTimeoutMs) && metadata.invokeTimeoutMs > 0
    ? metadata.invokeTimeoutMs : DEFAULT_INVOKE_TIMEOUT_MS;
  return Number.isFinite(claimedAt) && now >= claimedAt && now < claimedAt + timeoutMs
    ? 'provisioning' : hand.status;
}

export function isTenantRemoteHand(hand: HandRecord): boolean {
  return (
    hand.type === 'server-remote' &&
    hand.status !== 'destroyed' &&
    typeof hand.metadata?.tenantRemoteHandId === 'string' &&
    hand.metadata.tenantRemoteHandId.length > 0
  );
}

export function selectCurrentTenantRemoteHand(
  hands: ReadonlyArray<HandRecord>,
): HandRecord | undefined {
  const selected = (
    hands.find((hand) => hand.status === 'ready') ??
    hands.find((hand) => tenantHandRuntimeStatus(hand) === 'provisioning') ??
    hands[0]
  );
  return selected ? { ...selected, status: tenantHandRuntimeStatus(selected) } : undefined;
}
