/**
 * 签名密钥 store 的进程内替身，语义与 `PgKyAppSigningKeyStore` 一致
 * （active/next 各唯一、promote 让旧 active 转 retiring、retireExpired 到期下线）。
 * PG 侧的真实合约见 `kyAppStores.pg.test.ts`；这里给纯逻辑与交叉测试用。
 */
import type { KyAppSigningKeyRecord, KyAppSigningKeyStatus } from '../keys/store.js';

export class FakeSigningKeyStore {
  readonly records = new Map<string, KyAppSigningKeyRecord>();

  async get(kid: string): Promise<KyAppSigningKeyRecord | null> {
    return this.records.get(kid) ?? null;
  }

  async findByStatus(status: KyAppSigningKeyStatus): Promise<KyAppSigningKeyRecord | null> {
    for (const record of this.records.values()) if (record.status === status) return record;
    return null;
  }

  async listPublishable(): Promise<KyAppSigningKeyRecord[]> {
    return [...this.records.values()].filter((record) =>
      ['active', 'next', 'retiring'].includes(record.status),
    );
  }

  async insert(input: {
    kid: string;
    publicJwk: Record<string, unknown>;
    secretRef: string;
    status: 'active' | 'next';
  }): Promise<KyAppSigningKeyRecord> {
    if (await this.findByStatus(input.status)) throw new Error(`已存在 ${input.status} 密钥`);
    const now = new Date().toISOString();
    const record: KyAppSigningKeyRecord = {
      ...input,
      createdAt: now,
      activatedAt: input.status === 'active' ? now : null,
      retiringAt: null,
      retireAfter: null,
      revokedAt: null,
    };
    this.records.set(input.kid, record);
    return record;
  }

  async promote(kid: string, retireAfterMs: number): Promise<KyAppSigningKeyRecord> {
    const target = this.records.get(kid);
    if (!target || target.status !== 'next') throw new Error('只有 next 状态的密钥可以提升');
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.status !== 'active') continue;
      record.status = 'retiring';
      record.retiringAt = new Date(now).toISOString();
      record.retireAfter = new Date(now + retireAfterMs).toISOString();
    }
    target.status = 'active';
    target.activatedAt = new Date(now).toISOString();
    return target;
  }

  async revoke(kid: string): Promise<KyAppSigningKeyRecord> {
    const record = this.records.get(kid);
    if (!record) throw new Error(`未知 kid ${kid}`);
    record.status = 'revoked';
    record.revokedAt = new Date().toISOString();
    return record;
  }

  async retireExpired(now: Date): Promise<string[]> {
    const kids: string[] = [];
    for (const record of this.records.values()) {
      if (record.status !== 'retiring' || !record.retireAfter) continue;
      if (new Date(record.retireAfter).getTime() > now.getTime()) continue;
      record.status = 'revoked';
      record.revokedAt = now.toISOString();
      kids.push(record.kid);
    }
    return kids;
  }
}
