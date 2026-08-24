import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readSessionMeta,
  writeSessionMeta,
} from '../data/transcripts/meta.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import {
  formatTaskboardSessionTitle,
  TASKBOARD_PURPOSE_LABELS,
  writeTaskboardSessionTitle,
} from '../taskboard/sessionTitle.js';

const cleanup: string[] = [];

beforeEach(async () => {
  await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('任务看板会话标题', () => {
  it('使用任务编号和阶段名生成确定性标题', () => {
    expect(formatTaskboardSessionTitle({
      identifier: ' TASK-50 ',
    }, 'work')).toBe('50 实施');
  });

  it('各执行阶段均生成对应阶段名', () => {
    expect(formatTaskboardSessionTitle({ identifier: 'TASK-35' }, 'review')).toBe('35 复核');
    expect(formatTaskboardSessionTitle({ identifier: 'TASK-67' }, 'work')).toBe('67 实施');
    expect(formatTaskboardSessionTitle({ identifier: 'TASK-71' }, 'merge')).toBe('71 合并');
    expect(TASKBOARD_PURPOSE_LABELS).toEqual({ work: '实施', review: '复核', merge: '合并' });
  });

  it('未提供 purpose 时仅保留任务编号', () => {
    expect(formatTaskboardSessionTitle({ identifier: 'TASK-50' })).toBe('50');
  });

  it('非 TASK- 前缀编号保持原样', () => {
    expect(formatTaskboardSessionTitle({ identifier: 'TASK-ABC' }, 'work')).toBe('ABC 实施');
    expect(formatTaskboardSessionTitle({ identifier: '35' }, 'review')).toBe('35 复核');
  });

  it('写入 generatedTitle 且保留人工 customTitle', async () => {
    const dir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'taskboard-title-'));
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
        execution: { purpose: 'work' },
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
      generatedTitle: '50 实施',
    });
  });

  it('相同标题已存在时保持幂等', async () => {
    const dir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'taskboard-title-idempotent-'));
    cleanup.push(dir);
    const transcriptPath = join(dir, 'taskboard-session.jsonl');
    await writeSessionMeta(transcriptPath, {
      userId: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
      channel: 'web',
      createdAt: '2026-08-16T06:00:00.000Z',
      generatedTitle: '50 实施',
    });

    const updated = await writeTaskboardSessionTitle({
      store: {
        getExecutionContextBySessionId: vi.fn(async () => ({
          identity: { tenantId: 'tenant-a', ownerUserId: 'user-1', username: 'alice' },
          task: { identifier: 'TASK-50', title: '优化标题生成逻辑' },
          execution: { purpose: 'work' },
        })),
      } as never,
      sessionId: 'taskboard-session',
      transcriptPath,
    });

    expect(updated).toBeNull();
  });
});
