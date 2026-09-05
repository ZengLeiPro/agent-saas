/**
 * mock 壳的签名材料：本地 ES256 密钥对（模拟 KY Agent 的 SAT 签发端）+ JWKS 端点内容，
 * 以及一致性测试要用到的**故意错误**的签名变体（`alg=none` / HS256 / 未知 kid）。
 */
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';

import { JWT_TYP } from '@kaiyan/ky-app-contract';

export interface MockSigner {
  /** 当前签发用 kid。 */
  kid: string;
  /** JWKS 文档（`/.well-known/ky-app-jwks.json` 的响应体）。 */
  jwks(): { keys: JWK[] };
  /** 正常签发一枚 SAT（ES256 + `typ: ky-sat+jwt`）。 */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  /** 负向：`alg=none`（无签名段）。 */
  signNone(claims: Record<string, unknown>): string;
  /** 负向：HS256 对称签名（用一段随便的密钥）。 */
  signHs256(claims: Record<string, unknown>): Promise<string>;
  /** 负向：用另一对合法密钥签，但 kid 指向 JWKS 里没有的值。 */
  signUnknownKid(claims: Record<string, unknown>): Promise<string>;
  /** 新增一个 kid（`jwks.rotated` 场景），返回新 kid。 */
  addKey(kid: string): Promise<string>;
  /** 用指定 kid 签（轮换 / probe 场景）。 */
  signWith(
    kid: string,
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ): Promise<string>;
  /** 从 JWKS 移除某个 kid（紧急撤销场景）。 */
  removeKey(kid: string): void;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

interface KeyEntry {
  kid: string;
  jwk: JWK;
  privateKey: CryptoKey;
}

async function createKeyEntry(kid: string): Promise<KeyEntry> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    kid,
    jwk: { ...jwk, kid, use: 'sig', alg: 'ES256' },
    privateKey: privateKey as CryptoKey,
  };
}

/** 生成 mock 壳的签发器。`kid` 默认 `k-doctor-1`。 */
export async function createMockSigner(kid = 'k-doctor-1'): Promise<MockSigner> {
  const keys = new Map<string, KeyEntry>();
  const primary = await createKeyEntry(kid);
  keys.set(kid, primary);
  // 未知 kid 用的密钥：合法 ES256，但公钥永远不进 JWKS。
  const orphan = await createKeyEntry('k-doctor-unknown');
  const hsSecret = new TextEncoder().encode('doctor-hs256-secret-not-in-jwks-0123456789');

  async function signBy(
    entry: KeyEntry,
    claims: Record<string, unknown>,
    header: Record<string, unknown>,
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', typ: JWT_TYP.sat, kid: entry.kid, ...header })
      .sign(entry.privateKey);
  }

  return {
    kid,
    jwks: () => ({ keys: [...keys.values()].map((entry) => entry.jwk) }),
    sign: (claims, header = {}) => signBy(primary, claims, header),
    signNone(claims) {
      const head = base64url(JSON.stringify({ alg: 'none', typ: JWT_TYP.sat, kid }));
      return `${head}.${base64url(JSON.stringify(claims))}.`;
    },
    signHs256: (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', typ: JWT_TYP.sat, kid })
        .sign(hsSecret),
    signUnknownKid: (claims) => signBy(orphan, claims, {}),
    async addKey(newKid) {
      keys.set(newKid, await createKeyEntry(newKid));
      return newKid;
    },
    async signWith(targetKid, claims, header = {}) {
      const entry = keys.get(targetKid);
      if (entry === undefined) throw new Error(`mock 壳没有 kid=${targetKid} 的密钥`);
      return signBy(entry, claims, header);
    },
    removeKey(targetKid) {
      keys.delete(targetKid);
    },
  };
}
