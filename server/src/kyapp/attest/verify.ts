/**
 * WP2a 平台侧安装证明校验（规范 §3.2、§5.4）。
 *
 * 定制项目用安装密钥派生的 HS256 子密钥签 attest JWT，平台按同一 HKDF 参数派生后验签：
 * `HKDF-SHA-256(IKM = 安装密钥, salt = "ky-app-contract-v1", info = "attest", L = 32)`。
 * `kid` = 安装密钥 `keyVersion`，轮换窗口内同时接受 current / previous。
 * `iid` / `origin` 必须与登记一致；`dig` 只记录、不作为拒绝条件（§5.4-3）。
 *
 * 本阶段是纯函数版：密钥与 nonce 都由调用方注入，方便 Phase B 换成 vault + PG nonce 存储。
 */
import { hkdfSync } from 'node:crypto';

import { jwtVerify } from 'jose';

import { INSTALLATION_KEY_HKDF, JWT_TYP, type AttestClaims } from '@kaiyan/ky-app-contract';

/** 安装密钥字节数（规范 §3.2：32 字节随机）。 */
export const KY_APP_INSTALLATION_KEY_BYTES = INSTALLATION_KEY_HKDF.length;

export class KyAppAttestationError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'KyAppAttestationError';
  }
}

/**
 * 由安装密钥派生 attest 子密钥。参数与 `@kaiyan/ky-app-server` 的 `deriveInstallationKeys`
 * 完全相同，交叉测试逐字节对齐（否则壳侧永远握手失败）。
 */
export function deriveAttestKey(installationKey: Uint8Array): Uint8Array {
  if (installationKey.length !== INSTALLATION_KEY_HKDF.length) {
    throw new KyAppAttestationError(
      `安装密钥必须是 ${INSTALLATION_KEY_HKDF.length} 字节`,
      'invalid_key',
    );
  }
  return new Uint8Array(
    hkdfSync(
      'sha256',
      installationKey,
      Buffer.from(INSTALLATION_KEY_HKDF.salt, 'utf8'),
      Buffer.from(INSTALLATION_KEY_HKDF.info.attest, 'utf8'),
      INSTALLATION_KEY_HKDF.length,
    ),
  );
}

/** 一代安装密钥（current 或轮换窗口内的 previous）。 */
export interface KyAppInstallationKeyMaterial {
  keyVersion: string;
  installationKey: Uint8Array;
}

export interface VerifyKyAppAttestationInput {
  token: string;
  /** 登记的安装实例 id；attest 的 `iss` 必须是 `local:<iid>`。 */
  installationId: string;
  /** 登记的前端 origin。 */
  expectedOrigin: string;
  /** 环境 `iss`（= attest 的 `aud`，规范 §3.2）。 */
  audience: string;
  /** 本次握手签发的 nonce，必须逐字匹配。 */
  nonce: string;
  /** 可接受的安装密钥（current + 窗口内 previous）。 */
  keys: readonly KyAppInstallationKeyMaterial[];
  nowMs?: number;
}

/** 校验安装证明；任何不符都抛 `KyAppAttestationError`，`reason` 供审计与告警归类。 */
export async function verifyKyAppAttestation(
  input: VerifyKyAppAttestationInput,
): Promise<AttestClaims> {
  const nowMs = input.nowMs ?? Date.now();
  const header = decodeHeader(input.token);
  if (header.alg !== 'HS256') {
    throw new KyAppAttestationError(
      `安装证明 alg 必须是 HS256，收到 ${String(header.alg)}`,
      'bad_alg',
    );
  }
  if (header.typ !== JWT_TYP.attest) {
    throw new KyAppAttestationError(`安装证明 typ 必须是 ${JWT_TYP.attest}`, 'bad_typ');
  }
  const kid = header.kid;
  if (typeof kid !== 'string' || kid === '') {
    throw new KyAppAttestationError('安装证明缺少 kid', 'missing_kid');
  }
  const material = input.keys.find((candidate) => candidate.keyVersion === kid);
  if (!material) throw new KyAppAttestationError(`安装证明 kid 未知：${kid}`, 'unknown_kid');

  let payload: AttestClaims;
  try {
    const verified = await jwtVerify(input.token, deriveAttestKey(material.installationKey), {
      algorithms: ['HS256'],
      typ: JWT_TYP.attest,
      currentDate: new Date(nowMs),
      clockTolerance: 0,
    });
    payload = verified.payload as unknown as AttestClaims;
  } catch (error) {
    throw new KyAppAttestationError(
      `安装证明验签失败：${error instanceof Error ? error.message : String(error)}`,
      'signature_invalid',
    );
  }

  if (payload.iss !== `local:${input.installationId}`) {
    throw new KyAppAttestationError('安装证明 iss 与安装实例不符', 'iss_mismatch');
  }
  if (payload.iid !== input.installationId) {
    throw new KyAppAttestationError('安装证明 iid 与安装实例不符', 'iid_mismatch');
  }
  if (payload.aud !== input.audience) {
    throw new KyAppAttestationError('安装证明 aud 与环境 iss 不符', 'aud_mismatch');
  }
  if (payload.origin !== input.expectedOrigin) {
    throw new KyAppAttestationError('安装证明 origin 与登记不符', 'origin_mismatch');
  }
  if (payload.nonce !== input.nonce) {
    throw new KyAppAttestationError('安装证明 nonce 与本次握手不符', 'nonce_mismatch');
  }
  return payload;
}

function decodeHeader(token: string): Record<string, unknown> {
  const dot = token.indexOf('.');
  if (dot <= 0) throw new KyAppAttestationError('安装证明不是合法 JWT', 'malformed');
  try {
    const decoded = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('header 不是对象');
    }
    return decoded as Record<string, unknown>;
  } catch {
    throw new KyAppAttestationError('安装证明 header 不可解析', 'malformed');
  }
}
