import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readSessionMeta,
  writeSessionMeta,
} from '../data/transcripts/meta.js';
import {
  formatTaskboardSessionTitle,
  writeTaskboardSessionTitle,
} from '../taskboard/sessionTitle.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('任务看板会话标题', () => {
  it('使用任务编号和标题生成确定性标题', () => {
    expect(formatTaskboardSessionTitle({
      identifier: ' TASK-50 ',
      title: ' 优化标题生成逻辑 ',
    })).toBe('TASK-50 优化标题生成逻辑');
  });

  it('写入 generatedTitle 且保留人工 customTitle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskboard-title-'));
    cleanup.push(dir);
    const transcriptPath = join(dir, 'taskboard-session.meta-source.jsonl');
    await writeSessionMeta(transcriptPath, {
      userId: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
      channel: 'web',
      createdAt: '2026-08-16T06:00:00.000Z',
      customTitle: '人工命名',
    });
    const store = {
      getExecutionContextBySessionId: vi.fn(async () => ({
        identity: { tenantId: 'tenant-a', ownerUserId: 'user-1', username: 'alice' },
        task: { identifier: 'TASK-50', title: '优化标题生成逻辑' },
      })),
    };

    const updated = await writeTaskboardSessionTitle({
      store: store as never,
      sessionId: 'taskboard-session',
      transcriptPath,
    });

    expect(updated).toEqual({
      ownerUserId: 'user-1',
      sessionId: 'taskboard-session',
      title: '人工命名',
    });
    expect(await readSessionMeta(transcriptPath)).toMatchObject({
      customTitle: '人工命名',
      generatedTitle: 'TASK-50 优化标题生成逻辑',
    });
  });

  it('相同标题已存在时保持幂等', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskboard-title-idempotent-'));
    cleanup.push(dir);
    const transcriptPath = join(dir, 'taskboard-session.jsonl');
    await writeSessionMeta(transcriptPath, {
      userId: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
      channel: 'web',
      createdAt: '2026-08-16T06:00:00.000Z',
      generatedTitle: 'TASK-50 优化标题生成逻辑',
    });

    const updated = await writeTaskboardSessionTitle({
      store: {
        getExecutionContextBySessionId: vi.fn(async () => ({
          identity: { tenantId: 'tenant-a', ownerUserId: 'user-1', username: 'alice' },
          task: { identifier: 'TASK-50', title: '优化标题生成逻辑' },
        })),
      } as never,
      sessionId: 'taskboard-session',
      transcriptPath,
    });

    expect(updated).toBeNull();
  });
});
