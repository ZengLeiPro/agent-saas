import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { normalizeChatSubmission, toCanonicalChatSubmissionWireMessage, type AgentTarget } from '@agent/shared';
import { WebChannel } from '../channels/web/channel.js';
import { readSessionMeta, writeSessionMeta } from '../data/transcripts/meta.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { createRuntimeSessionRecord, FileSessionCatalog } from '../runtime/sessionCatalog.js';
import type { UpsertRunInput } from '../runtime/runStore.js';
import { enabledTenantStore, FakeWebSocket, flushMicrotasks, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

const WAIN_USER = { sub: 'u-wu', username: 'wain_user', role: 'user' as const, tenantId: 'wain' };

function canonicalMessage(target: { sessionId?: string; agentTarget?: AgentTarget }, clientMsgId: string) {
  const normalized = normalizeChatSubmission({
    text: 'hi', clientMsgId: `${clientMsgId}-${randomUUID()}`, target, deliveryMode: 'queue', attachments: [],
  });
  if (!normalized.ok) throw new Error(normalized.issue.message);
  return toCanonicalChatSubmissionWireMessage(normalized.value);
}

describe('WebChannel V1 agent target binding', () => {
  const channels: WebChannel[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    channels.length = 0;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRig() {
    const cwd = await mkdtemp(join(tmpdir(), 'web-agent-target-binding-'));
    dirs.push(cwd);
    const runStore = new MemoryRunStore();
    const enqueued: UpsertRunInput[] = [];
    const sessionCatalog = new FileSessionCatalog({ agentCwd: cwd });
    const orgAgentStore = new OrgAgentStore(join(cwd, 'org-agents.json'));
    const channel = new WebChannel({
      agentCwd: cwd,
      executionConfig: createExecutionConfig(),
      tenantStore: enabledTenantStore(),
      orgAgentStore,
      runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), WAIN_USER.tenantId),
      enqueueRuntime: {
        scheduler: { enqueue: async (input: UpsertRunInput) => {
          enqueued.push(input);
          return runStore.upsertPending(input);
        } } as any,
        runStore, sessionCatalog, enabled: true,
      },
    }, async function* () { yield { type: 'done' as const }; });
    channels.push(channel);
    const ws = new FakeWebSocket();
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => { target?.send?.(JSON.stringify({ data })); },
      emitSession: (ctx: any, data: any) => { ctx?.ws?.send?.(JSON.stringify({ data })); },
      emitUser: () => {}, emitDual: () => {}, emit: () => {}, subscribe: () => () => {}, register: () => {},
    };
    return {
      ws, enqueued, sessionCatalog, orgAgentStore,
      sendRaw: async (message: any) => {
        await (channel as any).processChatMessage(wsClient(ws, WAIN_USER), message);
        await flushMicrotasks();
      },
    };
  }

  it('V1 新会话首绑 target 并持久 bindingVersion；已有 session 的 incoming mismatch 被拒', async () => {
    const rig = await makeRig();
    const agent = await rig.orgAgentStore.create({
      tenantId: 'wain', name: '产品选型助手', instructions: '只回答唯恩选型问题', allowedSkills: ['wain-kb'],
      audience: { exposure: 'all', usernames: [] },
      guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超纲。', strictness: 'strict' },
      enabled: true,
    } as any, 'wain_admin');
    const orgTarget = { kind: 'org-agent' as const, tenantId: 'wain', orgAgentId: agent.id };

    await rig.sendRaw(canonicalMessage({ agentTarget: orgTarget }, 'v1-first-bind'));
    expect(rig.enqueued).toHaveLength(1);
    const session = await rig.sessionCatalog.get(rig.enqueued[0].sessionId);
    const meta = await readSessionMeta(session!.transcriptPath);
    expect(meta).toMatchObject({
      orgAgentId: agent.id,
      agentTarget: orgTarget,
      agentTargetBindingVersion: 1,
    });
    expect((rig.enqueued[0].metadata?.chatSubmission as any)?.target).toMatchObject({ agentTarget: orgTarget });

    rig.ws.sent.length = 0;
    await rig.sendRaw(canonicalMessage({
      sessionId: rig.enqueued[0].sessionId,
      agentTarget: { kind: 'personal', tenantId: 'wain' },
    }, 'v1-target-mismatch'));
    expect(rig.ws.sent.find((message) => message.data?.type === 'chat_rejected')?.data).toMatchObject({
      reason_code: 'invalid_submission',
    });
    expect(rig.enqueued).toHaveLength(1);
  });

  function legacySession(rig: { sessionCatalog: FileSessionCatalog }) {
    return createRuntimeSessionRecord({
      sessionId: randomUUID(),
      userId: WAIN_USER.sub,
      username: WAIN_USER.username,
      userRole: WAIN_USER.role,
      tenantId: WAIN_USER.tenantId,
      channel: 'web',
      cwd: (rig.sessionCatalog as any).options.agentCwd,
    });
  }

  it('N-1 无证据历史会话兜底为 personal 并落盘 canonical target', async () => {
    // 生产 9227 个会话 meta 中只有 6 个带 agentTarget；把「无 agentTarget + 无 orgAgentId
    // + tenant 可证明」判成 unproven，等于让 9192 个历史会话全部只读。
    const rig = await makeRig();
    const legacy = legacySession(rig);
    await rig.sessionCatalog.ensure(legacy);

    await rig.sendRaw(canonicalMessage({ sessionId: legacy.sessionId }, 'v1-legacy-personal'));
    expect(rig.ws.sent.find((message) => message.data?.type === 'chat_rejected')).toBeUndefined();
    expect(await readSessionMeta(legacy.transcriptPath)).toMatchObject({
      agentTarget: { kind: 'personal', tenantId: 'wain' },
      agentTargetBindingVersion: 1,
    });
  });

  it('已写入但不可信的 agentTarget（跨租户）绝不被兜底降级为 personal', async () => {
    const rig = await makeRig();
    const crossTenant = legacySession(rig);
    await rig.sessionCatalog.ensure(crossTenant);
    const meta = await readSessionMeta(crossTenant.transcriptPath);
    await writeSessionMeta(crossTenant.transcriptPath, {
      ...meta!,
      agentTarget: { kind: 'personal', tenantId: 'other-tenant' },
    });

    await rig.sendRaw(canonicalMessage({ sessionId: crossTenant.sessionId }, 'v1-cross-tenant-legacy'));
    expect(rig.ws.sent.find((message) => message.data?.type === 'chat_rejected')?.data).toMatchObject({
      reason_code: 'invalid_submission',
    });
    expect(rig.enqueued).toHaveLength(0);
  });
});
