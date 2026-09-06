/**
 * WP2b 快照分页的签名 opaque `pageToken`（规范 §3.6）。
 *
 * 形态照 `server/src/security/capabilityToken.ts:25-78`：`base64url(JSON) + '.' + HMAC-SHA256`，
 * 校验用 `timingSafeEqual`。**不引 JWT/jose**——这是平台自用的短命游标，不是身份令牌。
 *
 * 三条硬约束：
 * 1. **载荷只有 `{tid, seq, page, exp}` 四个键**（§3.6 原文的 `{tid, snapshotSeq, page, exp=10min}`）。
 *    `tid` 是组织的不透明 id，**不是组织名称**；载荷里没有任何用户数据、没有任何显示名。
 *    多一个键、少一个键、类型不对，一律判为无效 token（见 `parseClaims`）。
 * 2. **签名材料复用已在 vault 的安装密钥**，零新 vault kind、零新 env。用 HKDF 派生一把
 *    用途独立的子密钥（salt 与 attest 同源，info 换成 `directory-page-token`），
 *    避免和 attest 的 HS256 子密钥交叉复用同一把字节。
 *    子密钥的 info 值**刻意不进 `@kaiyan/ky-app-contract`**：pageToken 对定制项目完全不透明，
 *    消费端永远不需要派生它，放进共享契约反而会让它看起来像是双方约定。
 * 3. **按安装实例隔离**：密钥来自该实例的安装密钥，A 实例的 token 在 B 实例验不过。
 *    轮换窗口内 current / previous 都试（口径同 `attest/verify.ts`），
 *    token 只活 10 分钟，轮换不会打断正在翻页的消费端。
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { INSTALLATION_KEY_HKDF } from '@kaiyan/ky-app-contract';

/** §3.6：`exp = 10min`。 */
export const DIRECTORY_PAGE_TOKEN_TTL_MS = 10 * 60 * 1000;

/** HKDF 的 info；与 attest / local-token 分开，防止子密钥交叉复用。 */
export const DIRECTORY_PAGE_TOKEN_HKDF_INFO = 'directory-page-token';

/** 载荷允许出现的全部键，多一个都算无效。 */
const CLAIM_KEYS = ['tid', 'seq', 'page', 'exp'] as const;

/**
 * pageToken 的全部内容。命名沿用 §3.6 原文；`seq` 即 `snapshotSeq`
 * （键名取短是为了让 token 尽量短，语义完全一致）。
 */
export interface DirectoryPageTokenClaims {
  /** 组织的不透明 id。 */
  tid: string;
  /** 本份快照的水位；任一页对不上即整份重拉（410 `snapshot_expired`）。 */
  seq: number;
  /** 页码，从 1 开始；第 0 页是「不带 pageToken」的首次请求。 */
  page: number;
  /** 过期时刻（epoch ms）。 */
  exp: number;
}

/** 一代安装密钥。形状与 `attest/verify.ts` 的 `KyAppInstallationKeyMaterial` 一致。 */
export interface DirectoryPageTokenKeyMaterial {
  keyVersion: string;
  installationKey: Uint8Array;
}

/** token 无效的统一异常；调用方一律翻译成 410 `snapshot_expired`，不区分原因。 */
export class DirectoryPageTokenError extends Error {
  constructor(
    message: string,
    readonly reason: 'malformed' | 'bad_signature' | 'expired' | 'no_key',
  ) {
    super(message);
    this.name = 'DirectoryPageTokenError';
  }
}

/** 由安装密钥派生 pageToken 专用子密钥。 */
export function deriveDirectoryPageTokenKey(installationKey: Uint8Array): Buffer {
  if (installationKey.length !== INSTALLATION_KEY_HKDF.length) {
    throw new DirectoryPageTokenError(
      `安装密钥必须是 ${INSTALLATION_KEY_HKDF.length} 字节`,
      'no_key',
    );
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      installationKey,
      Buffer.from(INSTALLATION_KEY_HKDF.salt, 'utf8'),
      Buffer.from(DIRECTORY_PAGE_TOKEN_HKDF_INFO, 'utf8'),
      INSTALLATION_KEY_HKDF.length,
    ),
  );
}

function hmac(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 严格解析载荷：键集合必须**恰好**是 `CLAIM_KEYS`，且类型与取值范围都合法。
 * 宽松解析会让「篡改后仍能被接受的 token」有可乘之机——虽然签名已经挡住了篡改，
 * 但这里再挡一层，保证即使将来签名口径变了也不会退化成任意 JSON 反序列化。
 */
function parseClaims(raw: string): DirectoryPageTokenClaims {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
  } catch {
    throw new DirectoryPageTokenError('pageToken 载荷不是合法 JSON', 'malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DirectoryPageTokenError('pageToken 载荷不是对象', 'malformed');
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== CLAIM_KEYS.length || !CLAIM_KEYS.every((key) => keys.includes(key))) {
    throw new DirectoryPageTokenError('pageToken 载荷字段集合不合法', 'malformed');
  }
  const claims = parsed as Record<string, unknown>;
  const { tid, seq, page, exp } = claims;
  if (typeof tid !== 'string' || tid.length === 0 || tid.length > 128) {
    throw new DirectoryPageTokenError('pageToken 的 tid 不合法', 'malformed');
  }
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) {
    throw new DirectoryPageTokenError('pageToken 的 seq 不合法', 'malformed');
  }
  if (!Number.isSafeInteger(page) || (page as number) < 1) {
    throw new DirectoryPageTokenError('pageToken 的 page 不合法', 'malformed');
  }
  if (!Number.isSafeInteger(exp) || (exp as number) <= 0) {
    throw new DirectoryPageTokenError('pageToken 的 exp 不合法', 'malformed');
  }
  return { tid, seq: seq as number, page: page as number, exp: exp as number };
}

export interface SignDirectoryPageTokenInput {
  tid: string;
  seq: number;
  page: number;
  /** 当前时刻（epoch ms）；`exp = nowMs + DIRECTORY_PAGE_TOKEN_TTL_MS`。 */
  nowMs: number;
  key: DirectoryPageTokenKeyMaterial;
  ttlMs?: number;
}

export function signDirectoryPageToken(input: SignDirectoryPageTokenInput): string {
  const claims: DirectoryPageTokenClaims = {
    tid: input.tid,
    seq: input.seq,
    page: input.page,
    exp: input.nowMs + (input.ttlMs ?? DIRECTORY_PAGE_TOKEN_TTL_MS),
  };
  // 键序固定：先 JSON 再 base64url，签名材料就是这串 base64url 本身。
  const payload = Buffer.from(
    JSON.stringify({ tid: claims.tid, seq: claims.seq, page: claims.page, exp: claims.exp }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${hmac(payload, deriveDirectoryPageTokenKey(input.key.installationKey))}`;
}

export interface VerifyDirectoryPageTokenInput {
  token: string;
  /** 该安装实例当前可接受的全部密钥（current + 轮换窗口内的 previous）。 */
  keys: readonly DirectoryPageTokenKeyMaterial[];
  nowMs: number;
}

/**
 * 校验并解出载荷。任何一步失败都抛 `DirectoryPageTokenError`，
 * 路由层统一翻译成 410 `snapshot_expired`（§3.6：token 过期即整份重拉）。
 */
export function verifyDirectoryPageToken(
  input: VerifyDirectoryPageTokenInput,
): DirectoryPageTokenClaims {
  if (input.keys.length === 0) {
    throw new DirectoryPageTokenError('该安装实例没有可用的安装密钥', 'no_key');
  }
  const parts = input.token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new DirectoryPageTokenError('pageToken 形态不合法', 'malformed');
  }
  const [payload, signature] = parts as [string, string];
  // 逐把试：轮换窗口内 current / previous 都要认，口径同 attest 校验。
  const matched = input.keys.some((material) => {
    try {
      return safeEqual(
        signature,
        hmac(payload, deriveDirectoryPageTokenKey(material.installationKey)),
      );
    } catch {
      return false;
    }
  });
  if (!matched) throw new DirectoryPageTokenError('pageToken 签名不匹配', 'bad_signature');
  const claims = parseClaims(payload);
  if (claims.exp <= input.nowMs) {
    throw new DirectoryPageTokenError('pageToken 已过期', 'expired');
  }
  return claims;
}
