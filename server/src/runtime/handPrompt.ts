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

export function buildAvailableHandsPrompt(hands: HandRecord[]): string {
  const activeHands = hands.filter((hand) => hand.status !== 'destroyed');
  if (activeHands.length === 0) {
    return [
      '<current-runtime status="unavailable">',
      '  <none />',
      '</current-runtime>',
      '运行态提示：当前没有 durable runtime 记录；workspace 工具使用会话默认运行态，工具参数不接受执行环境标识。',
    ].join('\n');
  }

  const runtime = selectCurrentRuntime(activeHands);
  const lines = [`<current-runtime status="${escapeXml(runtime?.status ?? 'unavailable')}" workspaceId="${escapeXml(runtime?.workspaceId ?? '')}">`];
  lines.push('  <workspace-tools default="true" />');
  lines.push('</current-runtime>');
  lines.push(
    '运行态提示：',
    '  - 当前会话对 Agent 只暴露一个 workspace 运行态。',
    '  - 普通 workspace 文件/命令工具不接受执行环境标识参数；工具始终在当前运行态执行。',
    '  - 如果当前运行态仍在 provisioning 或 unhealthy，先调用 WaitForWorkspaceReady；不要改用其他执行环境猜测文件状态。',
    '  - 需要保留文件、截图、patch 或日志供下载/后续步骤使用时，登记为 artifact。',
  );
  return lines.join('\n');
}
