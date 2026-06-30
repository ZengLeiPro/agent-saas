/**
 * EMFILE regression：§22.5 现场暴露的 bug 防回归。
 *
 * 现场堆栈：
 *   EMFILE: too many open files
 *     at FileEventStore.list (server/src/runtime/fileEventStore.ts:30)
 *     at WebChannel.tryResumePersistedApproval (channel.ts:452)
 *
 * 诱因：多 session 短时间反复 readFile 同名 jsonl，每次开新 fd，
 * macOS 默认 fd 上限被打穿。
 *
 * 防线（§22.7 第一步落地）：
 * 1. readFileCoalesce: 同 filePath 并发 readFile 共享 in-flight promise，N→1 syscall。
 * 2. Semaphore: 跨文件并发兜底。
 *
 * 本文件三组用例：
 * - readFileCoalesce dedup 行为（spy 拦截 fs.promises.readFile）
 * - Semaphore acquire / release / 排队语义
 * - 端到端 stress：30 session × (eventStore.list + approvalStore.list) 同时跑，全 OK
 */

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import {
  __getReadFileCoalesceSyscallsForTests,
  __resetFileReadCoalesceForTests,
  Semaphore,
  readFileCoalesce,
} from '../runtime/fileReadCoalesce.js';

beforeEach(() => {
  __resetFileReadCoalesceForTests();
});

afterEach(() => {
  __resetFileReadCoalesceForTests();
});

describe('readFileCoalesce', () => {
  it('N concurrent reads on same filePath collapse to 1 syscall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emfile-coalesce-'));
    const file = join(dir, 'hot.jsonl');
    await writeFile(file, 'line-a\nline-b\n', 'utf-8');

    // ESM 下 vi.spyOn 不能 patch fs/promises namespace；改用 readFileCoalesce
    // 内部 syscall 计数器观察实际触发次数（生产路径上的开销 = 1 次 ++）。
    expect(__getReadFileCoalesceSyscallsForTests()).toBe(0);

    const results = await Promise.all(
      Array.from({ length: 32 }, () => readFileCoalesce(file)),
    );

    expect(results.every((r) => r === 'line-a\nline-b\n')).toBe(true);
    // N→1：32 并发只触发 1 次实际 fs.readFile。
    expect(__getReadFileCoalesceSyscallsForTests()).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  it('ENOENT → null (silent), not throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emfile-coalesce-'));
    const missing = join(dir, 'never-existed.jsonl');
    const result = await readFileCoalesce(missing);
    expect(result).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('after completion, next read goes back to disk (no stale cache)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emfile-coalesce-'));
    const file = join(dir, 'mutating.jsonl');
    await writeFile(file, 'v1', 'utf-8');

    const first = await readFileCoalesce(file);
    expect(first).toBe('v1');

    // append-after-list 场景：写入新内容后下一次读必须拿到新值，
    // 否则破坏 EventStore "事实源在磁盘" 的契约。
    await writeFile(file, 'v2', 'utf-8');
    const second = await readFileCoalesce(file);
    expect(second).toBe('v2');

    await rm(dir, { recursive: true, force: true });
  });
});

describe('Semaphore', () => {
  it('rejects non-positive max', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it('caps concurrent in-flight workers under cap', async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let peak = 0;
    // 50 个并发任务，每个 acquire → 做点事 → release。
    // 关键不变量：active 同时持有 permits 的瞬时数永远 ≤ cap=3。
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (async () => {
          const release = await sem.acquire();
          active++;
          peak = Math.max(peak, active);
          // 模拟工作；延迟散布以让 queue 有机会重叠。
          await new Promise<void>((r) => setTimeout(r, i % 4));
          active--;
          release();
        })(),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
    // 所有 release 后 permits 应回到 cap。
    expect(sem.available()).toBe(3);
  });

  it('release is idempotent', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release(); // 第二次 release 不应让 permits 翻倍
    expect(sem.available()).toBe(1);
  });

  it('FIFO: queued waiters resume in arrival order', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    const order: number[] = [];

    const w1 = sem.acquire().then((r) => {
      order.push(1);
      return r;
    });
    const w2 = sem.acquire().then((r) => {
      order.push(2);
      return r;
    });
    const w3 = sem.acquire().then((r) => {
      order.push(3);
      return r;
    });

    first();
    const r1 = await w1;
    r1();
    const r2 = await w2;
    r2();
    const r3 = await w3;
    r3();

    expect(order).toEqual([1, 2, 3]);
  });
});

describe('end-to-end EMFILE regression', () => {
  it('30 session × concurrent (eventStore.list + approvalStore.list) does not throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emfile-e2e-'));
    const N = 30;

    // 准备 30 个 session 的 event+approval 文件，模拟 §22.5 现场。
    const sessions = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const sessionId = `session-${i}`;
        const eventPath = join(dir, `${sessionId}.runtime-events.jsonl`);
        const approvalPath = join(dir, `${sessionId}.approvals.jsonl`);
        const eventLines = Array.from({ length: 50 }, (_, j) =>
          JSON.stringify({
            id: `evt-${i}-${j}`,
            timestamp: new Date(2026, 5, 7, 18, j).toISOString(),
            type: 'tool_audit',
            sessionId,
            runId: `run-${i}`,
            toolCallId: `call-${j}`,
            toolId: 'MemorySearch',
            toolName: 'MemorySearch',
            risk: 'safe',
            authorization: { source: 'policy_auto' },
            executionTarget: 'server-local',
            status: 'success',
            durationMs: 12,
          }),
        ).join('\n') + '\n';
        await writeFile(eventPath, eventLines, 'utf-8');
        await writeFile(approvalPath, '', 'utf-8'); // 空 approval 文件
        return { sessionId, eventPath, approvalPath };
      }),
    );

    // 30 个 session 同时 list eventStore + approvalStore（≈ tryResumePersistedApproval 读路径）。
    // 加上每个 session 多次 fan-out，制造更高瞬时并发。
    const FAN_OUT_PER_SESSION = 5;
    const tasks: Array<Promise<unknown>> = [];
    for (const { sessionId, eventPath, approvalPath } of sessions) {
      for (let k = 0; k < FAN_OUT_PER_SESSION; k++) {
        const eventStore = new FileEventStore(eventPath);
        const approvalStore = new FileApprovalStore(approvalPath);
        tasks.push(eventStore.list(sessionId));
        tasks.push(approvalStore.list(sessionId));
      }
    }

    // 全部 settle，任何抛错（含 EMFILE）会暴露。
    const results = await Promise.allSettled(tasks);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason : new Error(String(r.reason))));

    if (errors.length > 0) {
      throw new Error(
        `EMFILE regression: ${errors.length}/${results.length} reads failed. ` +
          `First error: ${errors[0].message}`,
      );
    }

    // 抽样校验内容也都读到了。
    const sampleEvents = await new FileEventStore(sessions[0].eventPath).list(sessions[0].sessionId);
    expect(sampleEvents.length).toBe(50);

    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it('readFileCoalesce dedup verified across FileEventStore.list calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emfile-store-dedup-'));
    const eventPath = join(dir, 'one.runtime-events.jsonl');
    await writeFile(
      eventPath,
      JSON.stringify({
        id: 'evt-1',
        timestamp: '2026-06-07T18:00:00.000Z',
        type: 'run_started',
        runId: 'run-x',
        sessionId: 'session-x',
        model: 'gpt-5.5',
        channel: 'web',
      }) + '\n',
      'utf-8',
    );

    // 同一文件路径并发 list 必须 dedup 到 1 次 syscall。
    expect(__getReadFileCoalesceSyscallsForTests()).toBe(0);

    const store = new FileEventStore(eventPath);
    const concurrent = 40;
    const results = await Promise.all(
      Array.from({ length: concurrent }, () => store.list('session-x')),
    );

    expect(results.length).toBe(concurrent);
    expect(results.every((r) => r.length === 1)).toBe(true);
    // 40 并发 list 同文件 → 1 次 syscall。
    expect(__getReadFileCoalesceSyscallsForTests()).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });
});
