import pg from 'pg';
import { serverLogger } from '../utils/logger.js';

const { Client } = pg;

/**
 * Cron 单例 leadership（2026-07-15 零停机部署批次）。
 *
 * 背景：蓝绿部署下新旧两个 server 进程会短暂并存。CronService 是
 * 「进程内 setTimeout + 共享 jobs.json」的调度器，没有跨进程互斥——
 * 两实例同时跑 cron 会导致同一任务双触发（双 LLM run / 双扣费 / 双通知）。
 *
 * 机制：基于 PG session 级 advisory lock 的 leader 选举。
 * - 持有 `pg_try_advisory_lock(hashtext(lockName))` 的实例才启动 cron；
 * - 落选实例按 retryMs 轮询重试（旧实例 drain 退出 / 崩溃时 PG session
 *   断开自动释放锁，新实例在一个重试周期内接管）；
 * - leader 的 PG 连接意外断开 → 立即回调 onLost 停掉本地 cron（锁已随
 *   session 释放，其他实例可能已接管），随后重连重新竞选；
 * - 自愿 stop()（drain / 关停）不触发 onLost，由调用方自行按顺序 quiesce。
 *
 * 单实例开发环境（runtimeEventStore 非 pg backend）没有连接串：直接视为
 * leader，行为与历史版本一致。
 *
 * 已知边界（接受并记录于 docs/zero-downtime-deployment.md）：
 * - 网络分区且 TCP 未 RST 时，旧 leader 感知断连有延迟，存在秒级双跑窗口，
 *   最坏后果是单个到期任务重复执行一次；
 * - leadership 切换间隙（≤retryMs）到期的任务会延迟到新 leader 接管后按
 *   catch-up 逻辑补跑。
 */

export interface LeadershipPgClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface CronLeadershipOptions {
  /** PG 连接串；未提供（file backend / 开发环境）→ 单实例假设，立即成为 leader */
  connectionString?: string | undefined;
  /** 锁名（advisory lock key 哈希源）。须含 tablePrefix，避免共库多环境互相抢锁 */
  lockName: string;
  /** 成为 leader 时回调（启动 cron service / reconcile） */
  onAcquired: () => void | Promise<void>;
  /** 非自愿失去 leadership（连接断开）时回调；自愿 stop() 不触发 */
  onLost: (reason: string) => void | Promise<void>;
  /** 竞选/重连重试间隔，默认 15s */
  retryMs?: number;
  /** 测试注入用 client 工厂 */
  createClient?: (connectionString: string) => LeadershipPgClient;
}

const DEFAULT_RETRY_MS = 15_000;

export class CronLeadership {
  private leader = false;
  private stopped = false;
  private started = false;
  private client: LeadershipPgClient | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly logger = serverLogger.child('CronLeadership');

  constructor(private readonly options: CronLeadershipOptions) {}

  isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.options.connectionString) {
      // 单实例模式：无跨进程互斥需求，直接成为 leader
      this.leader = true;
      this.logger.info('No PG connection configured; assuming single-instance leadership');
      void this.fireAcquired();
      return;
    }
    void this.connectAndCampaign();
  }

  /** 自愿放弃 leadership（drain / 关停）。不触发 onLost，调用方自行 quiesce。 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearRetry();
    const client = this.client;
    this.client = null;
    if (client) {
      if (this.leader) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [this.options.lockName]);
        } catch {
          // session 结束时锁必然释放；unlock 失败无需处理
        }
      }
      try {
        await client.end();
      } catch {
        // 连接可能已断
      }
    }
    if (this.leader) {
      this.leader = false;
      this.logger.info('Leadership released (voluntary stop)');
    }
  }

  private async fireAcquired(): Promise<void> {
    try {
      await this.options.onAcquired();
    } catch (err) {
      // 保持 leadership（释放锁并不能修复启动失败），大声记录等待人工介入
      this.logger.error('onAcquired callback failed (leadership retained):', err);
    }
  }

  private async fireLost(reason: string): Promise<void> {
    try {
      await this.options.onLost(reason);
    } catch (err) {
      this.logger.error('onLost callback failed:', err);
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(fn: () => void): void {
    if (this.stopped) return;
    this.clearRetry();
    this.retryTimer = setTimeout(fn, this.options.retryMs ?? DEFAULT_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private createClient(): LeadershipPgClient {
    const connectionString = this.options.connectionString!;
    if (this.options.createClient) return this.options.createClient(connectionString);
    return new Client({ connectionString, connectionTimeoutMillis: 10_000 }) as unknown as LeadershipPgClient;
  }

  private async connectAndCampaign(): Promise<void> {
    if (this.stopped) return;
    const client = this.createClient();
    let lossHandled = false;
    const onConnectionLoss = (err?: unknown) => {
      if (lossHandled) return;
      lossHandled = true;
      void this.handleConnectionLoss(client, err);
    };
    client.on('error', (err) => onConnectionLoss(err));
    client.on('end', () => onConnectionLoss());
    try {
      await client.connect();
    } catch (err) {
      this.logger.warn(`PG connect failed: ${err instanceof Error ? err.message : String(err)}; retrying`);
      lossHandled = true; // connect 失败后 end 事件不应再次触发重连
      try { await client.end(); } catch { /* noop */ }
      this.scheduleRetry(() => void this.connectAndCampaign());
      return;
    }
    if (this.stopped) {
      lossHandled = true;
      try { await client.end(); } catch { /* noop */ }
      return;
    }
    this.client = client;
    await this.tryAcquire(client);
  }

  private async tryAcquire(client: LeadershipPgClient): Promise<void> {
    if (this.stopped || this.client !== client) return;
    let acquired = false;
    try {
      const result = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired',
        [this.options.lockName],
      );
      acquired = result.rows[0]?.acquired === true;
    } catch (err) {
      // query 失败视为连接损坏，交给 error/end handler 或主动触发
      this.logger.warn(`Advisory lock query failed: ${err instanceof Error ? err.message : String(err)}`);
      void this.handleConnectionLoss(client, err);
      return;
    }
    if (this.stopped || this.client !== client) return;
    if (acquired) {
      this.leader = true;
      this.logger.info(`Cron leadership acquired (lock="${this.options.lockName}")`);
      await this.fireAcquired();
    } else {
      this.scheduleRetry(() => void this.tryAcquire(client));
    }
  }

  private async handleConnectionLoss(client: LeadershipPgClient, err?: unknown): Promise<void> {
    if (this.stopped || this.client !== client) return;
    this.client = null;
    this.clearRetry();
    const wasLeader = this.leader;
    this.leader = false;
    const reason = err instanceof Error ? err.message : 'connection closed';
    this.logger.warn(`PG connection lost (${reason})${wasLeader ? '; leadership lost' : ''}`);
    try { await client.end(); } catch { /* noop */ }
    if (wasLeader) {
      await this.fireLost(reason);
    }
    this.scheduleRetry(() => void this.connectAndCampaign());
  }
}
