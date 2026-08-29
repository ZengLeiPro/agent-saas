import { describe, expect, it } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import { FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

const USER = { sub: 'tier-user-1', username: 'tier_user_1', role: 'user' as const, tenantId: 'tenant-tier' };

function tierChannel(runStore: MemoryRunStore): WebChannel {
  return new WebChannel({
    agentCwd: '/tmp/web-channel-approval-tier-test',
    enqueueRuntime: { scheduler: {} as never, runStore, sessionCatalog: {} as never, enabled: true },
  } as never, async function* () { yield { type: 'done' as const }; });
}

/**
 * TASK-256 review 返工回归：前端三档「有效批准策略」经 approval_policy WS 消息
 * 写入 run metadata（webChannelCoverage 的 handleApprovalPolicy 用例已超 ratchet
 * 基线，独立文件承载本组断言）：
 * - ask->low-risk：直接写入 { autoApproveTools: true, lowRiskOnly: true }，不落 null；
 * - full->low-risk：低风险策略覆盖既有 { autoApproveTools: true }，不被降为 null；
 * - ask 档（关闭指令）仍重置为 null。
 */
describe('WebChannel approval_policy 三档传播', () => {
  it('低风险档写入 lowRiskOnly metadata；ask->low-risk 与 full->low-risk 均不落 null', async () => {
    const runStore = new MemoryRunStore();
    await runStore.upsertPending({ runId: 'run-tier-1', sessionId: 's-tier-1', userId: USER.sub, model: 'm', channel: 'web' });
    await runStore.upsertPending({ runId: 'run-tier-2', sessionId: 's-tier-2', userId: USER.sub, model: 'm', channel: 'web' });
    const channel = tierChannel(runStore);
    const sendPolicy = async (runId: string, approvalPolicy: object) => {
      const ws = new FakeWebSocket();
      await (channel as unknown as {
        handleApprovalPolicy: (client: unknown, msg: object) => Promise<void>;
      }).handleApprovalPolicy(wsClient(ws, USER), { action: 'approval_policy', runId, approvalPolicy });
    };

    // ask -> low-risk：此前 run 无策略，直接写入低风险档（dangerous 仍人工）。
    await sendPolicy('run-tier-1', { autoApproveTools: true, lowRiskOnly: true });
    expect((await runStore.get('run-tier-1'))?.metadata?.approvalPolicy).toEqual({ autoApproveTools: true, lowRiskOnly: true });

    // full -> low-risk：先 full 档再降档，metadata 更新为 lowRiskOnly 而不是 null。
    await sendPolicy('run-tier-2', { autoApproveTools: true });
    expect((await runStore.get('run-tier-2'))?.metadata?.approvalPolicy).toEqual({ autoApproveTools: true });
    await sendPolicy('run-tier-2', { autoApproveTools: true, lowRiskOnly: true });
    expect((await runStore.get('run-tier-2'))?.metadata?.approvalPolicy).toEqual({ autoApproveTools: true, lowRiskOnly: true });

    // ask 档关闭指令：重置为 null（人工审批），语义不变。
    await sendPolicy('run-tier-1', { autoApproveTools: false });
    expect((await runStore.get('run-tier-1'))?.metadata?.approvalPolicy).toBeNull();
  });
});
