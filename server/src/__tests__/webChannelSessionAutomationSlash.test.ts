import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { logger } = vi.hoisted(() => {
  const value: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  value.child = vi.fn(() => value);
  return { logger: value };
});
vi.mock('../utils/logger.js', () => ({
  createLogger: () => logger,
  configureLogger: vi.fn(),
  getLoggerConfig: () => ({}),
  serverLogger: logger,
  chatLogger: logger,
  dingtalkLogger: logger,
  ttsLogger: logger,
  sessionLogger: logger,
  apiLogger: logger,
  uploadLogger: logger,
  voiceLogger: logger,
  cronLogger: logger,
  dataLogger: logger,
  authLogger: logger,
}));

import { WebChannel } from '../channels/web/channel.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { chatMessage, FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

describe('WebChannel session automation slash isolation', () => {
  const channels: WebChannel[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    channels.length = 0;
    dirs.length = 0;
  });

  async function createRig() {
    const agentCwd = await mkdtemp(join(tmpdir(), 'web-automation-slash-'));
    dirs.push(agentCwd);
    const runStore = new MemoryRunStore();
    const enqueue = vi.fn(async (input: any) => runStore.upsertPending(input));
    const dispatch = vi.fn(async function* () { yield { type: 'done' as const }; });
    const modelResolver = vi.fn();
    const orgAgentLookup = vi.fn();
    const getGuardrailModelConfigs = vi.fn(() => []);
    const channel = new WebChannel({
      agentCwd,
      modelResolver,
      orgAgentStore: { get: orgAgentLookup } as any,
      getGuardrailModelConfigs,
      enqueueRuntime: {
        scheduler: { enqueue } as any,
        runStore,
        sessionCatalog: new FileSessionCatalog({ agentCwd }),
        enabled: true,
      },
    }, dispatch as any);
    channels.push(channel);
    const ws = new FakeWebSocket();
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => target?.send?.(JSON.stringify({ data })),
      emitSession: (context: any, data: any) => context?.ws?.send?.(JSON.stringify({ data })),
      emitUser: () => {},
      emitDual: () => {},
    };
    const send = async (message: string, clientMsgId: string, extra: Record<string, unknown> = {}) => {
      await (channel as any).processChatMessage(
        wsClient(ws),
        chatMessage({ message, client_msg_id: clientMsgId, ...extra }),
      );
    };
    return { ws, send, enqueue, dispatch, modelResolver, orgAgentLookup, getGuardrailModelConfigs };
  }

  it.each([
    '/loop',
    '/loop 5m --max-runs 3 -- check CI',
    '/goal',
    '/goal status',
    '/goal -- tests pass',
    '/goal pause',
  ])('rejects automation command %s before guardrail, enqueue, or model resolution', async (command) => {
    const rig = await createRig();

    await rig.send(command, `slash-${command.length}`, { model: 'configured/model', orgAgentId: 'org-1' });

    expect(rig.ws.sent.at(-1)?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'access_denied',
      reason: expect.stringContaining('不能通过普通 WebSocket chat 提交'),
    });
    expect(rig.enqueue).not.toHaveBeenCalled();
    expect(rig.dispatch).not.toHaveBeenCalled();
    expect(rig.modelResolver).not.toHaveBeenCalled();
    expect(rig.orgAgentLookup).not.toHaveBeenCalled();
    expect(rig.getGuardrailModelConfigs).not.toHaveBeenCalled();
  });

  it('routes explicit goal status through automation isolation instead of ordinary chat', async () => {
    const rig = await createRig();

    await rig.send('/goal status', 'goal-status');

    expect(rig.ws.sent.at(-1)?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'access_denied',
      reason: expect.stringContaining('不能通过普通 WebSocket chat 提交'),
    });
    expect(rig.orgAgentLookup).not.toHaveBeenCalled();
    expect(rig.enqueue).not.toHaveBeenCalled();
  });

  it('replays the same chat_rejected result for a duplicate automation command', async () => {
    const rig = await createRig();

    await rig.send('/loop 5m -- check CI', 'slash-duplicate');
    const first = rig.ws.sent.at(-1)?.data;
    await rig.send('/loop 5m -- check CI', 'slash-duplicate');
    const replay = rig.ws.sent.at(-1)?.data;

    expect(first).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'access_denied',
      reason: expect.stringContaining('不能通过普通 WebSocket chat 提交'),
    });
    expect(replay).toEqual(first);
    expect(rig.ws.sent.filter(event => event.data.type === 'chat_ack')).toHaveLength(0);
    expect(rig.enqueue).not.toHaveBeenCalled();
    expect(rig.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed for malformed exact automation syntax', async () => {
    const rig = await createRig();

    await rig.send('/goal set --', 'slash-invalid');

    expect(rig.ws.sent.at(-1)?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'access_denied',
      reason: expect.stringContaining('无效的 session automation 命令'),
    });
    expect(rig.enqueue).not.toHaveBeenCalled();
    expect(rig.dispatch).not.toHaveBeenCalled();
  });

  it('replays the exact parse rejection for a duplicate malformed automation command', async () => {
    const rig = await createRig();

    await rig.send('/goal set --', 'slash-invalid-duplicate');
    const first = rig.ws.sent.at(-1)?.data;
    await rig.send('/goal set --', 'slash-invalid-duplicate');

    expect(rig.ws.sent.at(-1)?.data).toEqual(first);
    expect(first).toMatchObject({ type: 'chat_rejected', reason_code: 'access_denied' });
    expect(rig.ws.sent.filter(event => event.data.type === 'chat_ack')).toHaveLength(0);
  });

  it.each(['/goals', '/looping', 'ordinary text'])('leaves non-command text %s in ordinary chat handling', async (text) => {
    const rig = await createRig();

    await rig.send(text, `normal-${text.length}`, { orgAgentId: 'missing-org-agent' });

    expect(rig.orgAgentLookup).toHaveBeenCalledWith('missing-org-agent');
    expect(rig.ws.sent.at(-1)?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'org_agent_unavailable',
    });
    expect(rig.enqueue).not.toHaveBeenCalled();
  });
});
