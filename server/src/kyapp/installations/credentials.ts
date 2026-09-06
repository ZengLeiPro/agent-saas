/**
 * WP2a 服务凭据与安装密钥的签发 / 领取 / 确认 / 轮换（规范 §3.2、§3.6、§8.4）。
 *
 * 三条不可动摇的纪律：
 * 1. **明文只在 SecretVault**。PG 里服务凭据只留 sha256，安装密钥只留 keyVersion 与 vault ref；
 *    明文既不回写库、也不进日志、也不进治理审计 metadata。
 * 2. **一次性领取**：领取票据本身 ≥192 bit 随机、24 小时有效，
 *    领取用 `markClaimed` 的条件 UPDATE 做原子闸门，成功后立刻把服务凭据明文从 vault 抹掉
 *    （安装密钥明文必须保留——平台侧校验安装证明要用它派生 HS256 子密钥）。
 * 3. **双凭据重叠轮换**（§8.4）：create-new → `credential-ack` → 切换 → revoke-old；
 *    有效期 90 天，最后 14 天进告警项；新凭据 24 小时未确认自动失效。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { GLOBAL_OWNER_ID, type SecretVault, type VaultCaller } from '../../security/secretVault.js';
import { KY_APP_INSTALLATION_KEY_BYTES } from '../attest/verify.js';
import {
  KY_APP_CREDENTIAL_SCOPES,
  KyAppCredentialConflictError,
  serviceCredentialDigest,
  type KyAppCredentialScope,
  type KyAppInstallationKeyRecord,
  type KyAppServiceCredentialRecord,
  type PgKyAppCredentialStore,
} from './credentialStore.js';

/** 服务凭据明文在 vault 里的 kind（已登记进基础设施白名单）。 */
export const KY_APP_SERVICE_CREDENTIAL_KIND = 'ky_app_service_credential';
/** 安装密钥明文在 vault 里的 kind。 */
export const KY_APP_INSTALLATION_KEY_KIND = 'ky_app_installation_key';

/** §3.6：签发后 24 小时内未 `credential-ack` 即失效。 */
export const KY_APP_CREDENTIAL_ACK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** §8.4：服务凭据 90 天轮换。 */
export const KY_APP_CREDENTIAL_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** §8.4：到期前 14 天进告警项。 */
export const KY_APP_CREDENTIAL_ALERT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** 一次性领取票据的有效期。 */
export const KY_APP_CLAIM_TICKET_TTL_MS = 24 * 60 * 60 * 1000;
/** §3.2：安装密钥轮换后 previous 仍被接受 24 小时。 */
export const KY_APP_INSTALLATION_KEY_ACCEPT_MS = 24 * 60 * 60 * 1000;

type VaultOperation = 'read' | 'write' | 'rotate' | 'revoke';

function caller(kind: string, operation: VaultOperation): VaultCaller {
  return { actor: 'system', userId: '__system__', scopes: [`secret:${kind}:${operation}`] };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** vault 里服务凭据的载荷形态。领取后被替换成墓碑（`claimed`）。 */
interface ServiceCredentialPayload {
  token?: string;
  ticketSha256?: string;
  ticketExpiresAt?: string;
  claimed?: true;
}

export interface KyAppIssuedCredentialTicket {
  credentialId: string;
  keyVersion: string;
  /** 一次性领取票据明文，只在签发响应里出现这一次。 */
  ticket: string;
  ticketExpiresAt: string;
  ackDeadlineAt: string;
  expiresAt: string;
}

export interface KyAppClaimedCredential {
  credentialId: string;
  /** 服务凭据明文，只在领取响应里出现这一次。 */
  serviceCredential: string;
  keyVersion: string;
  /** 安装密钥明文（base64），定制项目写进自己的密钥管理。 */
  installationKey: string;
  scopes: KyAppCredentialScope[];
  ackDeadlineAt: string;
  expiresAt: string;
}

export interface KyAppCredentialManagerOptions {
  store: PgKyAppCredentialStore;
  vault: SecretVault;
  now?: () => number;
  /** 测试注入：生成随机串。 */
  randomToken?: (bytes: number) => string;
}

export class KyAppCredentialManager {
  private readonly now: () => number;
  private readonly randomToken: (bytes: number) => string;

  constructor(private readonly options: KyAppCredentialManagerOptions) {
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? ((bytes) => randomBytes(bytes).toString('base64url'));
  }

  /**
   * 签发一套新的服务凭据 + 安装密钥，返回一次性领取票据。
   * 旧凭据**不在这里撤销**：双凭据重叠期由 `credential-ack` 之后的 `revokeSupersededCredentials` 收口。
   */
  async issue(input: {
    installationId: string;
    scopes?: readonly KyAppCredentialScope[];
  }): Promise<KyAppIssuedCredentialTicket> {
    const nowMs = this.now();
    const credentialId = randomUUID();
    // 服务凭据 32 字节随机；库里只留 sha256。
    const token = this.randomToken(32);
    // 领取票据 24 字节（192 bit）随机，独立于凭据本身。
    const ticket = this.randomToken(24);
    const ticketExpiresAt = new Date(nowMs + KY_APP_CLAIM_TICKET_TTL_MS);
    const payload: ServiceCredentialPayload = {
      token,
      ticketSha256: sha256(ticket),
      ticketExpiresAt: ticketExpiresAt.toISOString(),
    };
    const secretRef = await this.options.vault.putSecret(
      GLOBAL_OWNER_ID,
      KY_APP_SERVICE_CREDENTIAL_KIND,
      JSON.stringify(payload),
      caller(KY_APP_SERVICE_CREDENTIAL_KIND, 'write'),
      // metadata 只放非敏感生命周期字段；键名不含 secret/token/password 等词。
      {
        installationId: input.installationId,
        credentialId,
        issuedAt: new Date(nowMs).toISOString(),
      },
    );
    const ackDeadlineAt = new Date(nowMs + KY_APP_CREDENTIAL_ACK_WINDOW_MS);
    const expiresAt = new Date(nowMs + KY_APP_CREDENTIAL_LIFETIME_MS);
    await this.options.store.issueCredential({
      credentialId,
      installationId: input.installationId,
      tokenSha256: serviceCredentialDigest(token),
      scopes: input.scopes ?? KY_APP_CREDENTIAL_SCOPES,
      secretRef: secretRef.id,
      ackDeadlineAt,
      expiresAt,
    });

    const keyVersion = `v${new Date(nowMs).toISOString().slice(0, 10).replaceAll('-', '')}-${this.randomToken(4)}`;
    const installationKey = randomBytes(KY_APP_INSTALLATION_KEY_BYTES).toString('base64');
    const keyRef = await this.options.vault.putSecret(
      GLOBAL_OWNER_ID,
      KY_APP_INSTALLATION_KEY_KIND,
      installationKey,
      caller(KY_APP_INSTALLATION_KEY_KIND, 'write'),
      { installationId: input.installationId, keyVersion, issuedAt: new Date(nowMs).toISOString() },
    );
    await this.options.store.rotateInstallationKey({
      installationId: input.installationId,
      keyVersion,
      secretRef: keyRef.id,
      acceptPreviousMs: KY_APP_INSTALLATION_KEY_ACCEPT_MS,
    });

    return {
      credentialId,
      keyVersion,
      ticket,
      ticketExpiresAt: ticketExpiresAt.toISOString(),
      ackDeadlineAt: ackDeadlineAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * 一次性领取。票据校验通过后先走 `markClaimed` 的原子闸门，
   * 成功者才拿到明文，并立刻把 vault 里的服务凭据明文替换成墓碑。
   */
  async claim(input: { installationId: string; ticket: string }): Promise<KyAppClaimedCredential> {
    const nowMs = this.now();
    const ticketDigest = sha256(input.ticket);
    const candidates = (await this.options.store.listCredentials(input.installationId)).filter(
      (record) => record.claimedAt === null && record.status === 'pending_ack',
    );
    for (const record of candidates) {
      const payload = await this.readPayload(record);
      if (!payload?.token || payload.ticketSha256 !== ticketDigest) continue;
      if (!payload.ticketExpiresAt || Date.parse(payload.ticketExpiresAt) <= nowMs) {
        throw new KyAppCredentialConflictError('领取票据已过期，请重新签发');
      }
      const claimed = await this.options.store.markClaimed(record.credentialId);
      if (!claimed) throw new KyAppCredentialConflictError('该凭据已被领取，明文只发放一次');

      const key = await this.currentInstallationKey(input.installationId);
      if (!key) throw new KyAppCredentialConflictError('该安装实例没有可用的安装密钥');
      const installationKey = await this.options.vault.getSecret(
        key.secretRef,
        caller(KY_APP_INSTALLATION_KEY_KIND, 'read'),
      );
      // 明文交付后立刻销毁 vault 中的服务凭据副本；后续鉴权只靠库里的 sha256。
      await this.options.vault.rotateSecret(
        record.secretRef,
        JSON.stringify({ claimed: true } satisfies ServiceCredentialPayload),
        caller(KY_APP_SERVICE_CREDENTIAL_KIND, 'rotate'),
      );
      return {
        credentialId: record.credentialId,
        serviceCredential: payload.token,
        keyVersion: key.keyVersion,
        installationKey,
        scopes: record.scopes,
        ackDeadlineAt: record.ackDeadlineAt,
        expiresAt: record.expiresAt,
      };
    }
    throw new KyAppCredentialConflictError('领取票据无效或已使用');
  }

  /**
   * `credential-ack`：定制项目用新凭据自证已装配。
   * 24 小时窗口外一律拒绝；确认成功后把同实例更早的 active 凭据 revoke（重叠轮换收尾）。
   */
  async acknowledge(token: string): Promise<KyAppServiceCredentialRecord> {
    const now = new Date(this.now());
    const record = await this.options.store.findByToken(token);
    if (!record) throw new KyAppCredentialConflictError('未知服务凭据');
    if (record.status === 'active') return record;
    const acked = await this.options.store.acknowledge(record.credentialId, now);
    if (!acked)
      throw new KyAppCredentialConflictError('凭据不在可确认状态或已超过 24 小时确认窗口');
    await this.revokeSuperseded(record.installationId, acked.credentialId);
    return acked;
  }

  /** 鉴权入口：按明文查 active 且未过期的凭据，并校验 scope。 */
  async authenticate(
    token: string,
    scope: KyAppCredentialScope,
  ): Promise<KyAppServiceCredentialRecord | null> {
    const record = await this.options.store.findByToken(token);
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= this.now()) return null;
    if (!record.scopes.includes(scope)) return null;
    // `credential-ack` 允许 pending_ack 状态使用——它正是用来把凭据转成 active 的那一次调用。
    if (record.status === 'active') return record;
    if (record.status === 'pending_ack' && scope === 'credential-ack') return record;
    return null;
  }

  /** 把同实例其余 active/pending_ack 凭据撤销，只保留刚确认的那把。 */
  async revokeSuperseded(installationId: string, keepCredentialId: string): Promise<number> {
    const records = await this.options.store.listCredentials(installationId);
    let revoked = 0;
    for (const record of records) {
      if (record.credentialId === keepCredentialId) continue;
      if (record.status !== 'active' && record.status !== 'pending_ack') continue;
      await this.options.store.revokeCredential(record.credentialId);
      await this.destroyPlaintext(record);
      revoked += 1;
    }
    return revoked;
  }

  async revoke(credentialId: string, installationId: string): Promise<void> {
    const record = (await this.options.store.listCredentials(installationId)).find(
      (item) => item.credentialId === credentialId,
    );
    if (!record) throw new KyAppCredentialConflictError('未知凭据');
    await this.options.store.revokeCredential(credentialId);
    await this.destroyPlaintext(record);
  }

  /** 后台循环调用：把超过确认窗口与到期的凭据统一置为 expired。 */
  async expireStale(): Promise<number> {
    return this.options.store.expireStale(new Date(this.now()));
  }

  /** §8.4：到期前 14 天进告警项。返回需要提醒轮换的凭据。 */
  async listRotationDue(installationId: string): Promise<KyAppServiceCredentialRecord[]> {
    const threshold = this.now() + KY_APP_CREDENTIAL_ALERT_WINDOW_MS;
    return (await this.options.store.listCredentials(installationId)).filter(
      (record) => record.status === 'active' && Date.parse(record.expiresAt) <= threshold,
    );
  }

  /**
   * 取平台侧校验安装证明所需的密钥材料：current + 仍在 24 小时窗口内的 previous。
   * 返回明文密钥字节，调用方用后即弃，不缓存、不落日志。
   */
  async listAcceptableInstallationKeys(
    installationId: string,
  ): Promise<Array<{ keyVersion: string; installationKey: Uint8Array }>> {
    const nowMs = this.now();
    const records = await this.options.store.getInstallationKeys(installationId);
    const usable = records.filter(
      (record) =>
        record.status === 'current' ||
        (record.status === 'previous' &&
          record.acceptUntil !== null &&
          Date.parse(record.acceptUntil) > nowMs),
    );
    const materials: Array<{ keyVersion: string; installationKey: Uint8Array }> = [];
    for (const record of usable) {
      const plaintext = await this.options.vault.getSecret(
        record.secretRef,
        caller(KY_APP_INSTALLATION_KEY_KIND, 'read'),
      );
      materials.push({
        keyVersion: record.keyVersion,
        installationKey: new Uint8Array(Buffer.from(plaintext, 'base64')),
      });
    }
    return materials;
  }

  private async currentInstallationKey(
    installationId: string,
  ): Promise<KyAppInstallationKeyRecord | null> {
    const records = await this.options.store.getInstallationKeys(installationId);
    return records.find((record) => record.status === 'current') ?? null;
  }

  private async readPayload(
    record: KyAppServiceCredentialRecord,
  ): Promise<ServiceCredentialPayload | null> {
    try {
      const raw = await this.options.vault.getSecret(
        record.secretRef,
        caller(KY_APP_SERVICE_CREDENTIAL_KIND, 'read'),
      );
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as ServiceCredentialPayload)
        : null;
    } catch {
      return null;
    }
  }

  private async destroyPlaintext(record: KyAppServiceCredentialRecord): Promise<void> {
    await this.options.vault
      .revokeSecret(record.secretRef, caller(KY_APP_SERVICE_CREDENTIAL_KIND, 'revoke'))
      .catch(() => undefined);
  }
}
