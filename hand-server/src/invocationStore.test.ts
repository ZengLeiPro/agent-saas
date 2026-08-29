import { mkdtemp, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileHandInvocationStore, interruptedResponse } from './invocationStore.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hand-invocation-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(retentionMs = 24 * 60 * 60_000): FileHandInvocationStore {
  return new FileHandInvocationStore(dir, { retentionMs });
}

describe('FileHandInvocationStore', () => {
  it('registerRunning 首次创建 running 记录，重复登记返回既有结果', async () => {
    const s = store();
    const first = await s.registerRunning('inv-1');
    expect(first.outcome).toBe('created');
    expect(first.record.state).toBe('running');

    // 新实例模拟重启：内存态清零，仅磁盘可查
    const second = await store().registerRunning('inv-1');
    expect(second.outcome).toBe('already_running');
    expect(second.record.createdAt).toBe(first.record.createdAt);
  });

  it('complete 落终态结果；重复 complete 首个终态胜出', async () => {
    const s = store();
    await s.registerRunning('inv-2');
    const response = { status: 'success' as const, content: 'executed' };
    await s.complete('inv-2', response);

    const reloaded = await store().get('inv-2');
    expect(reloaded?.state).toBe('completed');
    expect(reloaded?.response).toEqual(response);

    await s.complete('inv-2', { status: 'error', error: 'late' });
    expect((await store().get('inv-2'))?.response).toEqual(response);
  });

  it('markCancelled 创建 tombstone；对已完成 invocation 不覆盖结果', async () => {
    const s = store();
    const tombstone = await s.markCancelled('inv-3');
    expect(tombstone?.state).toBe('cancelled');
    expect(tombstone?.cancelledAt).toBeTruthy();

    const afterRestart = await store().registerRunning('inv-3');
    expect(afterRestart.outcome).toBe('cancelled_tombstone');

    const other = store();
    await other.registerRunning('inv-4');
    await other.complete('inv-4', { status: 'success', content: 'done' });
    const cancelled = await other.markCancelled('inv-4');
    expect(cancelled?.response).toEqual({ status: 'success', content: 'done' });
    expect(cancelled?.cancelledAt).toBeUndefined();
  });
  it('cancel 后完成的记录保留 cancelledAt 供结果对账', async () => {
    const s = store();
    await s.registerRunning('inv-5');
    await s.markCancelled('inv-5');
    await s.complete('inv-5', { status: 'error', error: 'aborted' });

    const record = await store().get('inv-5');
    expect(record?.state).toBe('completed');
    expect(record?.response?.status).toBe('error');
    expect(record?.cancelledAt).toBeTruthy();
  });

  it('reconcileStartup 把遗留 running 对账为 interrupted/indeterminate 终态', async () => {
    const s = store();
    await s.registerRunning('inv-running');
    await s.registerRunning('inv-done');
    await s.complete('inv-done', { status: 'success', content: 'done' });

    // 模拟重启后的新实例
    const restarted = store();
    const result = await restarted.reconcileStartup();
    expect(result.interrupted).toBe(1);
    expect(result.loaded).toBe(2);

    const interrupted = await restarted.get('inv-running');
    expect(interrupted?.state).toBe('completed');
    expect(interrupted?.response?.status).toBe('error');
    expect(interrupted?.response?.metadata).toMatchObject({
      interrupted: true,
      indeterminate: true,
    });
    expect(interrupted?.interruptedAt).toBeTruthy();
    // 已终态记录不被对账改写
    expect((await restarted.get('inv-done'))?.response).toEqual({
      status: 'success',
      content: 'done',
    });
  });

  it('sweep 按 mtime 清理过期记录', async () => {
    const s = store(60_000);
    await s.registerRunning('inv-old');
    await s.registerRunning('inv-fresh');
    const file = join(dir, 'inv-old.json');
    const stale = new Date(Date.now() - 120_000);
    await utimes(file, stale, stale);

    const result = await s.sweep();
    expect(result.deleted).toBe(1);
    expect(await s.get('inv-old')).toBeUndefined();
    expect(await s.get('inv-fresh')).toBeDefined();
  });

  it('损坏的 journal 文件不会阻断启动对账', async () => {
    await writeFile(join(dir, 'corrupt.json'), '{not json', 'utf-8');
    const s = store();
    const result = await s.reconcileStartup();
    expect(result.loaded).toBe(0);
    expect(result.interrupted).toBe(0);
  });

  it('超长 invocationId 退化为哈希文件名，记录本体仍可查询', async () => {
    const longId = `x`.repeat(400);
    const s = store();
    await s.registerRunning(longId);
    await s.complete(longId, { status: 'success', content: 'ok' });
    const persisted = (await store().get(longId))?.response;
    expect(persisted && persisted.status === 'success' ? persisted.content : undefined).toBe('ok');
  });

  it('interruptedResponse 描述副作用不确定性', () => {
    const response = interruptedResponse('2026-08-29T00:00:00.000Z');
    expect(response.status).toBe('error');
    if (response.status !== 'error') throw new Error('unreachable');
    expect(response.error).toContain('indeterminate');
    expect(response.metadata).toEqual({
      interrupted: true,
      indeterminate: true,
      interruptedAt: '2026-08-29T00:00:00.000Z',
    });
  });

  it('journal 文件为原子写（无残留 tmp 文件）', async () => {
    const s = store();
    await s.registerRunning('inv-6');
    await s.complete('inv-6', { status: 'success', content: 'ok' });
    const stats = await stat(dir);
    // 目录下只有一个 journal 文件；tmp 文件在 rename 后不应存在
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    expect(files).toEqual(['inv-6.json']);
    expect(stats.isDirectory()).toBe(true);
  });
});
