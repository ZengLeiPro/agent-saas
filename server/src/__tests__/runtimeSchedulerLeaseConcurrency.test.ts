import { describe, expect, it } from 'vitest';

import { RuntimeScheduler } from '../runtime/scheduler.js';
import { deferred, MemoryEventStore, MemoryRunStore } from './runtimeScheduler.testHelpers.js';

  // P0-1 回归：pgRunStore.acquireLease 原子 CAS 互斥（核实-runtime-cron并发.md 闭合层 1）。
  // 锁死"两 worker 并发 acquire 同一 runId 恰好一个成功"——防未来把真 CAS mock 退化成假绿。
  describe('P0-1 acquireLease CAS mutual exclusion', () => {
    it('lets only one of two concurrent workers acquire the same runId', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-cas', sessionId: 'session-cas' });

      // 两个不同 workerId 并发 CAS 同一 runId（模拟蓝绿两实例竞争 lease）。
      const [a, b] = await Promise.all([
        runStore.acquireLease('run-cas', 'worker-A', 60_000),
        runStore.acquireLease('run-cas', 'worker-B', 60_000),
      ]);

      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      // 记录里的 lease 归属于唯一赢家，输家拿到 null。
      const persisted = await runStore.get('run-cas');
      expect(persisted?.status).toBe('running');
      expect(['worker-A', 'worker-B']).toContain(persisted?.workerId);
      expect(winners[0]?.workerId).toBe(persisted?.workerId);
    });

    it('rejects a second acquire while the lease is still valid', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-held', sessionId: 'session-held' });

      const first = await runStore.acquireLease('run-held', 'worker-A', 60_000);
      expect(first?.workerId).toBe('worker-A');

      // lease 未过期 → 第二个 worker 的 CAS 不匹配 WHERE 守卫 → null。
      const second = await runStore.acquireLease('run-held', 'worker-B', 60_000);
      expect(second).toBeNull();
      await expect(runStore.get('run-held')).resolves.toMatchObject({ workerId: 'worker-A' });
    });

    it('lets a new worker take over after the previous lease expires, and the old worker renewLease fails triggering abort', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-takeover', sessionId: 'session-takeover' });

      // worker-A 先拿到一个短 lease。
      const baseNow = new Date('2026-07-18T00:00:00.000Z');
      const leaseA = await runStore.acquireLease('run-takeover', 'worker-A', 1_000, baseNow);
      expect(leaseA?.workerId).toBe('worker-A');

      // lease 未过期时 worker-B 抢不到。
      const beforeExpiry = new Date(baseNow.getTime() + 500);
      expect(await runStore.acquireLease('run-takeover', 'worker-B', 60_000, beforeExpiry)).toBeNull();

      // lease 过期后 worker-B CAS 成功，改写 worker_id。
      const afterExpiry = new Date(baseNow.getTime() + 2_000);
      const leaseB = await runStore.acquireLease('run-takeover', 'worker-B', 60_000, afterExpiry);
      expect(leaseB?.workerId).toBe('worker-B');

      // 旧 worker-A 的续租链路：renewLease 因 worker_id 已被改写而返回 null。
      const renewedA = await runStore.renewLease('run-takeover', 'worker-A', 60_000);
      expect(renewedA).toBeNull();

      // 对照核实文件"续租失败链路 abortController.abort()"：续租失败即触发旧 in-flight run 中止。
      const abortController = new AbortController();
      if (renewedA === null) abortController.abort();
      expect(abortController.signal.aborted).toBe(true);
    });

    it('aborts the preempted old run through the wake lease.renew() failure path', async () => {
      // 端到端串起 scheduler：worker-A 在 wake 中执行，被 worker-B 抢占 lease 后
      // lease.renew() 抛错，wake 内的 abortController 被 abort（旧 run 主动中止，而非双跑）。
      const runStore = new MemoryRunStore();
      const eventStore = new MemoryEventStore();
      await runStore.upsertPending({ runId: 'run-preempt', sessionId: 'session-preempt' });

      const wakeEntered = deferred();
      const preempted = deferred();
      const abortController = new AbortController();
      let renewError: unknown;

      const scheduler = new RuntimeScheduler({
        runStore,
        eventStore,
        workerId: 'worker-A',
        autoWake: true,
        wake: async (record, lease) => {
          wakeEntered.resolve();
          // 等待外部把 lease 抢占（模拟 worker-B 接管 + lease 过期）。
          await preempted.promise;
          try {
            await lease.renew();
          } catch (err) {
            // 复刻 startWakeLeaseRenewal 的 catch：续租失败 → 中止旧 run。
            renewError = err;
            abortController.abort();
          }
          await lease.release('cancelled', 'preempted');
        },
      });

      const tick = scheduler.tick();
      await wakeEntered.promise;

      // worker-B 抢占：手动过期 worker-A 的 lease 后由 worker-B CAS 接管。
      const current = await runStore.get('run-preempt');
      runStore.records.set('run-preempt', { ...current!, leaseExpiresAt: new Date(Date.now() - 1).toISOString() });
      const takeover = await runStore.acquireLease('run-preempt', 'worker-B', 60_000);
      expect(takeover?.workerId).toBe('worker-B');

      preempted.resolve();
      await tick;
      await scheduler.stop();

      expect(renewError).toBeInstanceOf(Error);
      expect(abortController.signal.aborted).toBe(true);
    });
  });
