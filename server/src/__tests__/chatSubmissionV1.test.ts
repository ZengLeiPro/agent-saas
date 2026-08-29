import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { toCanonicalChatSubmissionWireMessage, normalizeChatSubmission } from '@agent/shared';
import type { AgentRunDispatch } from '../agent/types.js';
import { WebChannel } from '../channels/web/channel.js';
import { adaptWebChatSubmission } from '../channels/web/chatSubmissionAdapter.js';
import { projectQueuedMessageAttachments } from '../routes/sessionListHelpers.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { resolveRuntimeInboundAttachments } from '../runtime/runtimeAttachmentResolution.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { UploadManager } from '../uploads/manager.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { FakeWebSocket, MemoryRunStore } from './webChannelTestHelpers.js';

const USER = {
  sub: 'admin-m20',
  username: 'admin-m20',
  role: 'admin' as const,
  tenantId: DEFAULT_TENANT_ID,
};

const noopDispatch: AgentRunDispatch = async function* () {
  yield { type: 'done' };
};

function canonicalMessage(overrides: Record<string, unknown> = {}) {
  const normalized = normalizeChatSubmission({
    text: '请读取附件',
    clientMsgId: 'm20-client-1',
    target: {},
    deliveryMode: 'queue',
    attachments: [],
    ...overrides,
  });
  if (!normalized.ok) throw new Error(normalized.issue.message);
  return toCanonicalChatSubmissionWireMessage(normalized.value, ['replaceable_drafts']);
}

function client(ws: FakeWebSocket) {
  return { ws: ws as any, user: USER, alive: true, connectedAt: Date.now(), lastActivityAt: Date.now() };
}

function attachEventBus(channel: WebChannel): void {
  (channel as any).eventBus = {
    emitReply: (ws: FakeWebSocket, data: unknown) => ws.send(JSON.stringify({ data })),
    emitUser: (_userId: string, data: unknown) => (channel as any).__userEvents.push(data),
    emitDual: () => {},
    emitSession: () => {},
    emit: () => {},
    subscribe: () => () => {},
    register: () => {},
  };
  (channel as any).__userEvents = [];
}

describe('M20-01 server canonical chat boundary', () => {
  const roots: string[] = [];
  const channels: WebChannel[] = [];

  afterEach(async () => {
    await Promise.all(channels.splice(0).map((channel) => channel.stop()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('strictly rejects V1 missing/malformed IDs and a forged valid-format ID with structured reasons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm20-chat-reject-'));
    roots.push(root);
    const manager = new UploadManager({ agentCwd: root });
    const channel = new WebChannel({ agentCwd: root, uploadManager: manager }, noopDispatch);
    channels.push(channel);
    attachEventBus(channel);

    const cases = [
      {
        submission: {
          version: 1, text: 'x', clientMsgId: 'missing-id', target: {}, deliveryMode: 'queue',
          attachments: [{ display: { originalName: 'x.pdf' } }],
        },
        reason: 'attachment_id_missing',
      },
      {
        submission: {
          version: 1, text: 'x', clientMsgId: 'bad-id', target: {}, deliveryMode: 'queue',
          attachments: [{ attachmentId: 'fake', display: { originalName: 'x.pdf' } }],
        },
        reason: 'attachment_id_invalid',
      },
      {
        submission: canonicalMessage({
          clientMsgId: 'forged-id',
          attachments: [{
            attachmentId: '99999999-9999-4999-8999-999999999999',
            originalName: 'fake.pdf', mimeType: 'application/pdf', size: 1, isImage: false,
          }],
        }).submission,
        reason: 'attachment_not_found',
      },
    ];

    for (const testCase of cases) {
      const ws = new FakeWebSocket();
      await (channel as any).processChatMessage(client(ws), {
        action: 'chat',
        clientCapabilities: ['chat_submission_v1'],
        submission: testCase.submission,
      });
      expect(ws.sent.find((event) => event.data?.type === 'chat_rejected')?.data.reason_code)
        .toBe(testCase.reason);
      expect(ws.sent.find((event) => event.data?.type === 'chat_ack')).toBeUndefined();
    }
  });

  it('persists a path-free queue/replay DTO and materializes the exact same IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm20-chat-valid-'));
    roots.push(root);
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = resolveUserCwd(root, {
      id: USER.sub, username: USER.username, role: USER.role, tenantId: USER.tenantId,
    });
    await mkdir(join(userCwd, 'assets', 'm20'), { recursive: true });
    await copyFile(
      resolve(process.cwd(), '../web/public/favicon-32x32.png'),
      join(userCwd, 'assets', 'm20', '图片.png'),
    );
    await writeFile(join(userCwd, 'assets', 'm20', '合同.pdf'), 'pdf');
    const uploads = await manager.registerAssetReferences(userCwd, [
      'assets/m20/图片.png',
      'assets/m20/合同.pdf',
    ]);
    const ids = uploads.map((attachment) => attachment.attachmentId!);

    const runStore = new MemoryRunStore();
    const sessionCatalog = new FileSessionCatalog({ agentCwd: root });
    let capturedInput: any;
    const channel = new WebChannel({
      agentCwd: root,
      uploadManager: manager,
      runtimeEventStoreFor: (transcriptPath) => new FileEventStore(
        getRuntimeEventLogPath(transcriptPath), USER.tenantId,
      ),
      enqueueRuntime: {
        scheduler: {
          enqueue: async (input: any) => {
            capturedInput = input;
            return runStore.upsertPending({
              ...input,
              metadata: { ...input.metadata, deliveryMode: 'queue', queuedBehindRunId: 'active-run' },
            });
          },
        } as any,
        runStore,
        sessionCatalog,
        enabled: true,
      },
    }, noopDispatch);
    channels.push(channel);
    attachEventBus(channel);

    const ws = new FakeWebSocket();
    const message = canonicalMessage({
      clientMsgId: 'valid-multi-attachment',
      text: '图片 + PDF + share',
      attachments: uploads.map((upload) => ({
        ...upload,
        savedPath: `/client/forged/${upload.originalName}`,
        relativePath: `../../client/${upload.originalName}`,
      })),
    });
    await (channel as any).processChatMessage(client(ws), message);

    expect(ws.sent.find((event) => event.data?.type === 'chat_ack')?.data.status).toBe('queued');
    const durableSubmission = capturedInput.metadata.chatSubmission;
    const wakeMessage = capturedInput.metadata.wakeMessage;
    expect(durableSubmission.attachments.map((attachment: any) => attachment.attachmentId)).toEqual(ids);
    expect(wakeMessage.attachments.map((attachment: any) => attachment.attachmentId)).toEqual(ids);
    expect(JSON.stringify({ durableSubmission, wakeMessage })).not.toMatch(/savedPath|relativePath|\.\.\/|\/client\//);

    const queueEvent = (channel as any).__userEvents.find((event: any) => event.type === 'message_queued');
    expect(queueEvent.attachments.map((attachment: any) => attachment.attachmentId)).toEqual(ids);
    expect(JSON.stringify(queueEvent)).not.toMatch(/savedPath|relativePath/);
    expect(projectQueuedMessageAttachments(durableSubmission.attachments)
      .map((attachment) => attachment.attachmentId)).toEqual(ids);

    const run = [...runStore.records.values()][0];
    const materialized = await resolveRuntimeInboundAttachments(
      { agentCwd: root, sharedDir: root, uploadManager: manager },
      userCwd,
      run.sessionId,
      wakeMessage,
    );
    expect(materialized.map((attachment) => attachment.attachmentId)).toEqual(ids);
  });

  it('keeps the N-1 path shape explicitly isolated from the V1 adapter', () => {
    const adapted = adaptWebChatSubmission({
      action: 'chat',
      client_msg_id: 'legacy-client',
      message: 'legacy',
      attachments: [{
        originalName: 'legacy.pdf', relativePath: 'uploads/legacy.pdf', savedPath: '/tmp/legacy.pdf',
        size: 1, mimeType: 'application/pdf', isImage: false,
      }],
    });
    expect(adapted.protocol).toBe('legacy_n_minus_1');
    expect(adapted.legacyAttachments?.[0].relativePath).toBe('uploads/legacy.pdf');
    expect(adapted.canonical).toBeUndefined();
  });
});
