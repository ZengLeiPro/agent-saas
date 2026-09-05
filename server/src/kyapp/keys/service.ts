/**
 * WP2a SAT 签名密钥生命周期（规范 §3.1、§8.4）。
 *
 * ES256 独立密钥对，**私钥只存 SecretVault**（kind `ky_app_sat_signing_key`，owner global），
 * 公钥 JWK 与状态存治理库。JWKS 只出 active / next / retiring。
 * 轮换：`rotate()` 生成 next → `jwks.rotated` 事件 → 各安装实例 `jwks.probe` 回 `verifiedKid`
 * → `promote(kid, verifiedKid)` 切换签发 → 旧键 retiring 24 小时 → `retireExpired()` 下线。
 * 紧急撤销 `revoke(kid)` 立即移出 JWKS 并撤销 vault 中的私钥。
 */
import { randomBytes } from 'node:crypto';

import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, type CryptoKey } from 'jose';

import { GLOBAL_OWNER_ID, type SecretVault, type VaultCaller } from '../../security/secretVault.js';
import type { KyAppSigningKeyRecord, PgKyAppSigningKeyStore } from './store.js';

/** SAT 私钥在 SecretVault 里的 kind（已登记进基础设施白名单）。 */
export const KY_APP_SAT_SIGNING_KEY_KIND = 'ky_app_sat_signing_key';

/** 规范 §8.4：旧键进入 retiring 后 24 小时下线。 */
export const KY_APP_KEY_RETIRE_WINDOW_MS = 24 * 60 * 60 * 1000;

function vaultCaller(operation: 'read' | 'write' | 'rotate' | 'revoke'): VaultCaller {
  return {
    actor: 'system',
    userId: '__system__',
    scopes: [`secret:${KY_APP_SAT_SIGNING_KEY_KIND}:${operation}`],
  };
}

/** JWKS 文档形态（规范 §3.1：`kty=EC crv=P-256 use=sig kid`）。 */
export interface KyAppJwksDocument {
  keys: Array<Record<string, unknown>>;
}

export interface ActiveSigningKey {
  kid: string;
  privateKey: CryptoKey;
}

export class KyAppSigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KyAppSigningKeyError';
  }
}

export interface KyAppSigningKeyServiceOptions {
  store: PgKyAppSigningKeyStore;
  vault: SecretVault;
  /** 毫秒时钟，默认 `Date.now`。 */
  now?: () => number;
  /** 生成 kid 的方式，测试可注入以获得确定性。 */
  generateKid?: () => string;
  retireWindowMs?: number;
}

function defaultKid(now: number): string {
  const date = new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
  return `ky-${date}-${randomBytes(4).toString('hex')}`;
}

export class KyAppSigningKeyService {
  /** kid → 已导入的私钥。私钥只在进程内存里，绝不写日志、绝不出接口。 */
  private readonly privateKeys = new Map<string, CryptoKey>();
  private readonly now: () => number;
  private readonly retireWindowMs: number;

  constructor(private readonly options: KyAppSigningKeyServiceOptions) {
    this.now = options.now ?? Date.now;
    this.retireWindowMs = options.retireWindowMs ?? KY_APP_KEY_RETIRE_WINDOW_MS;
  }

  /** 首次调用生成并登记 active 密钥；之后返回既有 active。 */
  async ensureActive(): Promise<KyAppSigningKeyRecord> {
    const existing = await this.options.store.findByStatus('active');
    if (existing) return existing;
    return this.createKey('active');
  }

  /** JWKS 文档：只含 active / next / retiring 的公钥（规范 §8.4）。 */
  async jwks(): Promise<KyAppJwksDocument> {
    const keys = await this.options.store.listPublishable();
    return { keys: keys.map((key) => key.publicJwk) };
  }

  /** 取当前签发用密钥；缺失时先 `ensureActive()`。 */
  async getActiveSigningKey(): Promise<ActiveSigningKey> {
    const record = await this.ensureActive();
    return { kid: record.kid, privateKey: await this.loadPrivateKey(record) };
  }

  /**
   * 按 `kid` 取签发密钥。只服务 `jwks.probe`：探针 SAT 必须用**待切换的 next 密钥**签名，
   * 否则定制项目验的就不是那把新键，`verifiedKid` 也就不构成切换证据（§8.4）。
   * 已 `revoked` 的密钥一律不再签发。
   */
  async getSigningKeyByKid(kid: string): Promise<ActiveSigningKey> {
    const record = await this.options.store.get(kid);
    if (!record) throw new KyAppSigningKeyError(`未知签名密钥 kid ${kid}`);
    if (record.status === 'revoked') {
      throw new KyAppSigningKeyError(`签名密钥 ${kid} 已撤销，不能再签发`);
    }
    return { kid: record.kid, privateKey: await this.loadPrivateKey(record) };
  }

  /**
   * 生成下一把密钥并加入 JWKS（状态 `next`）。已存在 next 时幂等返回它的 kid，
   * 避免重复轮换把 JWKS 撑大。
   */
  async rotate(): Promise<{ newKid: string; created: boolean }> {
    const pending = await this.options.store.findByStatus('next');
    if (pending) return { newKid: pending.kid, created: false };
    const created = await this.createKey('next');
    return { newKid: created.kid, created: true };
  }

  /**
   * 切换签发密钥。**必须带外部验签证据**：`verifiedKid` 来自各安装实例对 `jwks.probe` 的应答，
   * 与目标 kid 不一致一律拒绝（规范 §8.4 的切换前置条件）。
   */
  async promote(newKid: string, verifiedKid: string): Promise<KyAppSigningKeyRecord> {
    if (verifiedKid !== newKid) {
      throw new KyAppSigningKeyError(
        `切换签发密钥需要安装实例回报的 verifiedKid 与目标一致（期望 ${newKid}，收到 ${verifiedKid}）`,
      );
    }
    return this.options.store.promote(newKid, this.retireWindowMs);
  }

  /** 紧急撤销：立即移出 JWKS，并撤销 vault 中的私钥。 */
  async revoke(kid: string): Promise<KyAppSigningKeyRecord> {
    const record = await this.options.store.revoke(kid);
    this.privateKeys.delete(kid);
    await this.options.vault
      .revokeSecret(record.secretRef, vaultCaller('revoke'))
      .catch(() => undefined);
    return record;
  }

  /** 到期下线 retiring 密钥（24 小时后），返回被下线的 kid。 */
  async retireExpired(now = new Date(this.now())): Promise<string[]> {
    const kids = await this.options.store.retireExpired(now);
    for (const kid of kids) this.privateKeys.delete(kid);
    return kids;
  }

  private async createKey(status: 'active' | 'next'): Promise<KyAppSigningKeyRecord> {
    const kid = (this.options.generateKid ?? (() => defaultKid(this.now())))();
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = {
      ...((await exportJWK(publicKey)) as Record<string, unknown>),
      kid,
      use: 'sig',
    };
    const pkcs8 = await exportPKCS8(privateKey);
    const ref = await this.options.vault.putSecret(
      GLOBAL_OWNER_ID,
      KY_APP_SAT_SIGNING_KEY_KIND,
      pkcs8,
      vaultCaller('write'),
      // metadata 只放非敏感的生命周期字段；键名不含 secret/token/password 等词。
      { kid, status, createdAt: new Date(this.now()).toISOString() },
    );
    const record = await this.options.store.insert({ kid, publicJwk, secretRef: ref.id, status });
    this.privateKeys.set(kid, privateKey);
    return record;
  }

  private async loadPrivateKey(record: KyAppSigningKeyRecord): Promise<CryptoKey> {
    const cached = this.privateKeys.get(record.kid);
    if (cached) return cached;
    const pkcs8 = await this.options.vault.getSecret(record.secretRef, vaultCaller('read'));
    const key = await importPKCS8(pkcs8, 'ES256');
    this.privateKeys.set(record.kid, key);
    return key;
  }
}
