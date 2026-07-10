/**
 * 消息反馈路由测试（/api/feedback，计划用例 17）
 *
 * 17. 同 content 重复提交幂等（duplicated=true）；非本人会话 → 403（owner-only）；
 *     非专职 Agent 会话 → 400；本人反馈可经 GET /session/:id 恢复
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import { createFeedbackRouter } from '../routes/feedback.js';
import type {
  MessageFeedbackInsert,
  MessageFeedbackListFilter,
  MessageFeedbackRecord,
  MessageFeedbackStore,
} from '../data/feedback/store.js';
import type { SessionMeta } from '../data/transcripts/meta.js';

const ORG_SESSION = '33333333-3333-4333-8333-333333333333';
const PERSONAL_SESSION = '44444444-4444-4444-8444-444444444444';

interface TestUser {
  sub: string;
  username: string;
  role: 'admin' | 'user';
  tenantId: string;
}

/** 内存实现：UNIQUE (tenant,session,user,contentHash) 幂等语义与 PG 对齐 */
class MemoryFeedbackStore implements MessageFeedbackStore {
  records: MessageFeedbackRecord[] = [];
  private seq = 0;

  async insert(item: MessageFeedbackInsert): Promise<{ duplicated: boolean }> {
    const exists = this.records.some(
      (r) => r.tenantId === item.tenantId && r.sessionId === item.sessionId
        && r.userId === item.userId && r.contentHash === item.contentHash,
    );
    if (exists) return { duplicated: true };
    this.records.push({ ...item, id: String(++this.seq), verdict: 'down', createdAt: new Date().toISOString() });
    return { duplicated: false };
  }

  async listByTenant(filter: MessageFeedbackListFilter) {
    const items = this.records.filter((r) => r.tenantId === filter.tenantId);
    return { items, total: items.length };
  }

  async listBySessionUser(sessionId: string, userId: string) {
    return this.records
      .filter((r) => r.sessionId === sessionId && r.userId === userId)
      .map((r) => ({ contentHash: r.contentHash, ...(r.comment ? { comment: r.comment } : {}), createdAt: r.createdAt }));
  }
}

async function startServer(
  store: MessageFeedbackStore | undefined,
  transcriptDir: string,
  user: TestUser,
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser }).user = user;
    next();
  });
  app.use('/api/feedback', createFeedbackRouter({
    messageFeedbackStore: store,
    resolveTranscriptPath: async (sessionId) => join(transcriptDir, `${sessionId}.jsonl`),
  }));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: s, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

async function writeMeta(dir: string, sessionId: string, meta: SessionMeta): Promise<void> {
  await writeFile(join(dir, `${sessionId}.meta.json`), JSON.stringify(meta, null, 2));
}

describe('/api/feedback routes', () => {
  let transcriptDir: string;
  let store: MemoryFeedbackStore;
  const servers: Server[] = [];

  const owner: TestUser = { sub: 'u-owner', username: 'owner', role: 'user', tenantId: 'tenant-a' };
  const other: TestUser = { sub: 'u-other', username: 'other', role: 'user', tenantId: 'tenant-a' };

  beforeEach(async () => {
    transcriptDir = await mkdtemp(join(tmpdir(), 'feedback-routes-test-'));
    store = new MemoryFeedbackStore();
    await writeMeta(transcriptDir, ORG_SESSION, {
      userId: owner.sub, username: owner.username, tenantId: 'tenant-a',
      channel: 'web', createdAt: '2026-07-10T07:00:00.000Z', orgAgentId: 'oa-1',
    });
    await writeMeta(transcriptDir, PERSONAL_SESSION, {
      userId: owner.sub, username: owner.username, tenantId: 'tenant-a',
      channel: 'web', createdAt: '2026-07-10T07:00:00.000Z',
    });
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await stopServer(s);
    await rm(transcriptDir, { recursive: true, force: true });
  });

  it('用例17: 重复提交幂等 duplicated；非本人会话 403；非专职会话 400', async () => {
    const { server, baseUrl } = await startServer(store, transcriptDir, owner);
    servers.push(server);

    const content = '这是一段专职 Agent 的回答文本';
    const expectedHash = createHash('sha256').update(content, 'utf-8').digest('hex');

    // 首次提交
    const first = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: ORG_SESSION, messageId: 'msg-1', content, comment: '答非所问' }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { ok: boolean; duplicated: boolean; contentHash: string };
    expect(firstBody.duplicated).toBe(false);
    expect(firstBody.contentHash).toBe(expectedHash);
    // orgAgentId 从会话 meta 取（防伪造），excerpt 截取
    expect(store.records[0].orgAgentId).toBe('oa-1');
    expect(store.records[0].messageExcerpt).toBe(content);

    // 同 content 重复提交（即使 messageId 不同：刷新后 id 变为 line-N）→ 幂等
    const dup = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: ORG_SESSION, messageId: 'line-7', content }),
    });
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as { duplicated: boolean }).duplicated).toBe(true);
    expect(store.records).toHaveLength(1);

    // 非专职 Agent 会话 → 400
    const personal = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: PERSONAL_SESSION, messageId: 'msg-1', content }),
    });
    expect(personal.status).toBe(400);

    // 恢复已反馈态：GET /session/:id 返回本人 contentHash
    const restore = await fetch(`${baseUrl}/api/feedback/session/${ORG_SESSION}`);
    expect(restore.status).toBe(200);
    const restoreBody = await restore.json() as { items: Array<{ contentHash: string; comment?: string }> };
    expect(restoreBody.items).toHaveLength(1);
    expect(restoreBody.items[0].contentHash).toBe(expectedHash);
    expect(restoreBody.items[0].comment).toBe('答非所问');

    // 非本人会话 → 403（owner-only；同租户其他用户也不行）
    const { server: otherServer, baseUrl: otherBaseUrl } = await startServer(store, transcriptDir, other);
    servers.push(otherServer);
    const foreign = await fetch(`${otherBaseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: ORG_SESSION, messageId: 'msg-1', content }),
    });
    expect(foreign.status).toBe(403);
    const foreignList = await fetch(`${otherBaseUrl}/api/feedback/session/${ORG_SESSION}`);
    expect(foreignList.status).toBe(403);

    // store 未装配 → 503（PG 不可用红线）
    const { server: bareServer, baseUrl: bareBaseUrl } = await startServer(undefined, transcriptDir, owner);
    servers.push(bareServer);
    const res503 = await fetch(`${bareBaseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: ORG_SESSION, messageId: 'msg-1', content }),
    });
    expect(res503.status).toBe(503);
  });
});
