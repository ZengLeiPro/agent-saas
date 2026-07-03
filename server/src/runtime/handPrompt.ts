import type { HandRecord } from './handStore.js';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isTenantRemoteHand(hand: HandRecord): boolean {
  return hand.type === 'server-remote'
    && hand.status !== 'destroyed'
    && typeof hand.metadata?.tenantRemoteHandId === 'string'
    && (hand.metadata.tenantRemoteHandId as string).length > 0;
}

function selectCurrentRuntime(activeHands: HandRecord[]): HandRecord | undefined {
  const tenantHands = activeHands.filter(isTenantRemoteHand);
  if (tenantHands.length > 0) {
    return tenantHands.find((hand) => hand.status === 'ready')
      ?? tenantHands.find((hand) => hand.status === 'provisioning')
      ?? tenantHands[0];
  }
  return activeHands.find((hand) => hand.status === 'ready') ?? activeHands[0];
}

/**
 * 只输出 <current-runtime> 状态 XML。运行态的行为指引（WaitForWorkspaceReady、
 * 单运行态语义、artifact 登记等）统一维护在 static.md「## 运行态」，此处不再
 * 重复——本段位于 system prompt 尾部高变动区，多一行重复文案就多一行每轮都
 * 无法缓存的 token。
 */
export function buildAvailableHandsPrompt(hands: HandRecord[]): string {
  const activeHands = hands.filter((hand) => hand.status !== 'destroyed');
  if (activeHands.length === 0) {
    return [
      '<current-runtime status="unavailable">',
      '  <none />',
      '</current-runtime>',
    ].join('\n');
  }

  const runtime = selectCurrentRuntime(activeHands);
  return [
    `<current-runtime status="${escapeXml(runtime?.status ?? 'unavailable')}" workspaceId="${escapeXml(runtime?.workspaceId ?? '')}">`,
    '  <workspace-tools default="true" />',
    '</current-runtime>',
  ].join('\n');
}
