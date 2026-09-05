/**
 * §3.2 安装密钥派生：
 * `HKDF-SHA-256(IKM = KY_INSTALLATION_KEY, salt = "ky-app-contract-v1", info ∈ {"attest","local-token"}, L = 32)`。
 * `kid` = 安装密钥 `keyVersion`；轮换时验证端 24 小时窗口内同时接受 current / previous。
 */
import { hkdfSync } from 'node:crypto';

import { INSTALLATION_KEY_HKDF, LOCAL_TOKEN_MAX_TTL_SECONDS } from '@kaiyan/ky-app-contract';

import type { KyAppConfig } from '../config/index.js';

/** 一个 keyVersion 派生出的两把子密钥。 */
export interface InstallationKeys {
  keyVersion: string;
  /** 安装证明（attest JWT）签名密钥。 */
  attest: Uint8Array;
  /** Local Token 签名密钥。 */
  localToken: Uint8Array;
}

function derive(ikm: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      'sha256',
      ikm,
      Buffer.from(INSTALLATION_KEY_HKDF.salt, 'utf8'),
      Buffer.from(info, 'utf8'),
      INSTALLATION_KEY_HKDF.length,
    ),
  );
}

/** 由 32 字节安装密钥派生 attest / local-token 两把子密钥。 */
export function deriveInstallationKeys(
  installationKey: Uint8Array,
  keyVersion: string,
): InstallationKeys {
  if (installationKey.length !== INSTALLATION_KEY_HKDF.length) {
    throw new Error(`安装密钥必须是 ${INSTALLATION_KEY_HKDF.length} 字节`);
  }
  if (keyVersion === '') throw new Error('安装密钥 keyVersion 不能为空');
  return {
    keyVersion,
    attest: derive(installationKey, INSTALLATION_KEY_HKDF.info.attest),
    localToken: derive(installationKey, INSTALLATION_KEY_HKDF.info.localToken),
  };
}

/** 轮换窗口（毫秒）：验证端 24 小时同时接受 current / previous（§3.2）。 */
export const KEY_ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 当前与上一版安装密钥。签发一律用 current，验证在窗口内接受 previous。 */
export interface LocalKeyRing {
  current: InstallationKeys;
  previous?: InstallationKeys;
  /** previous 的接受截止时刻（毫秒）；缺省 = 进程启动时刻 + 24 小时。 */
  previousAcceptUntil?: number;
}

export interface CreateLocalKeyRingOptions {
  /** 轮换发生的时刻（毫秒）；默认取当前时间，即从进程启动起算 24 小时窗口。 */
  rotatedAt?: number;
  now?: () => number;
}

/** 按部署配置构造密钥环。 */
export function createLocalKeyRing(
  config: KyAppConfig,
  options: CreateLocalKeyRingOptions = {},
): LocalKeyRing {
  const now = options.now ?? Date.now;
  const current = deriveInstallationKeys(config.installationKey, config.installationKeyVersion);
  if (config.previousInstallationKey === undefined) return { current };
  const rotatedAt = options.rotatedAt ?? now();
  return {
    current,
    previous: deriveInstallationKeys(
      config.previousInstallationKey,
      config.previousInstallationKeyVersion ?? '',
    ),
    previousAcceptUntil: rotatedAt + KEY_ROTATION_WINDOW_MS,
  };
}

/** 按 `kid` 选取验证密钥；previous 超出 24 小时窗口即不再接受。 */
export function selectVerificationKeys(
  ring: LocalKeyRing,
  kid: string,
  nowMs: number,
): InstallationKeys | null {
  if (ring.current.keyVersion === kid) return ring.current;
  const previous = ring.previous;
  if (previous === undefined || previous.keyVersion !== kid) return null;
  const until = ring.previousAcceptUntil;
  if (until !== undefined && nowMs > until) return null;
  return previous;
}

/** Local Token 的最长有效期（秒，§3.2）。 */
export const LOCAL_TOKEN_MAX_TTL = LOCAL_TOKEN_MAX_TTL_SECONDS;
