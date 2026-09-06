/**
 * WP2a 握手 nonce 存储（规范 §5.4、§4.6）。
 *
 * nonce ≥ 128 bit，绑定「壳会话 + 用户 + 安装实例」，**原子消费**：
 * 同一 nonce 只能兑换一次安装证明校验，重复消费一律失败。
 * PG 实现用条件 UPDATE 保证跨进程原子性；内存实现供纯函数测试与 local 单进程用。
 */
import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';

export interface KyAppNonceBinding {
  nonce: string;
  installationId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  expiresAt: Date;
}

export interface KyAppNonceStore {
  issue(binding: KyAppNonceBinding): Promise<void>;
  /** 原子消费；成功返回绑定信息，重复 / 过期 / 未知一律返回 null。 */
  consume(nonce: string, now: Date): Promise<Omit<KyAppNonceBinding, 'expiresAt'> | null>;
  /** 清理过期记录，返回删除条数。 */
  purgeExpired(now: Date): Promise<number>;
}

type Row = Record<string, unknown>;

export interface PgKyAppNonceStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

export class PgKyAppNonceStore implements KyAppNonceStore {
  readonly table: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgKyAppNonceStoreOptions) {
    this.tablePrefix = options.tablePrefix;
    this.table = `${governanceTablePrefix(options.tablePrefix)}_ky_app_handshake_nonces`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async issue(binding: KyAppNonceBinding): Promise<void> {
    await this.options.pool.query(
      `INSERT INTO ${this.table}
         (nonce,installation_id,tenant_id,user_id,session_id,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        binding.nonce,
        binding.installationId,
        binding.tenantId,
        binding.userId,
        binding.sessionId,
        binding.expiresAt,
      ],
    );
  }

  async consume(nonce: string, now: Date): Promise<Omit<KyAppNonceBinding, 'expiresAt'> | null> {
    const result = await this.options.pool.query(
      `UPDATE ${this.table}
       SET consumed_at = $2
       WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2
       RETURNING installation_id, tenant_id, user_id, session_id`,
      [nonce, now],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return {
      nonce,
      installationId: String(row.installation_id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      sessionId: String(row.session_id),
    };
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.table} WHERE expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }
}

/** 进程内实现：语义与 PG 版一致（含原子消费），供单测与单进程本地环境使用。 */
export class InMemoryKyAppNonceStore implements KyAppNonceStore {
  private readonly records = new Map<string, KyAppNonceBinding & { consumed: boolean }>();

  async issue(binding: KyAppNonceBinding): Promise<void> {
    if (this.records.has(binding.nonce)) throw new Error(`nonce 重复：${binding.nonce}`);
    this.records.set(binding.nonce, { ...binding, consumed: false });
  }

  async consume(nonce: string, now: Date): Promise<Omit<KyAppNonceBinding, 'expiresAt'> | null> {
    const record = this.records.get(nonce);
    if (!record || record.consumed || record.expiresAt.getTime() <= now.getTime()) return null;
    record.consumed = true;
    return {
      nonce: record.nonce,
      installationId: record.installationId,
      tenantId: record.tenantId,
      userId: record.userId,
      sessionId: record.sessionId,
    };
  }

  async purgeExpired(now: Date): Promise<number> {
    let removed = 0;
    for (const [nonce, record] of this.records) {
      if (record.expiresAt.getTime() <= now.getTime()) {
        this.records.delete(nonce);
        removed += 1;
      }
    }
    return removed;
  }
}
