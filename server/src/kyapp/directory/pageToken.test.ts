import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DIRECTORY_PAGE_TOKEN_HKDF_INFO,
  DIRECTORY_PAGE_TOKEN_TTL_MS,
  DirectoryPageTokenError,
  deriveDirectoryPageTokenKey,
  signDirectoryPageToken,
  verifyDirectoryPageToken,
  type DirectoryPageTokenKeyMaterial,
} from './pageToken.js';
import { deriveAttestKey } from '../attest/verify.js';

const NOW = Date.parse('2026-09-06T10:00:00.000Z');

function material(seed = 7): DirectoryPageTokenKeyMaterial {
  return { keyVersion: `v${String(seed)}`, installationKey: new Uint8Array(32).fill(seed) };
}

function sign(overrides: Partial<Parameters<typeof signDirectoryPageToken>[0]> = {}): string {
  return signDirectoryPageToken({
    tid: 't_demo',
    seq: 42,
    page: 1,
    nowMs: NOW,
    key: material(),
    ...overrides,
  });
}

describe('快照分页 pageToken（§3.6 签名 opaque）', () => {
  it('签发后可验回同一份载荷，exp 恰好是 10 分钟', () => {
    const token = sign();
    const claims = verifyDirectoryPageToken({ token, keys: [material()], nowMs: NOW });
    expect(claims).toEqual({
      tid: 't_demo',
      seq: 42,
      page: 1,
      exp: NOW + DIRECTORY_PAGE_TOKEN_TTL_MS,
    });
    expect(DIRECTORY_PAGE_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('载荷只有 tid/seq/page/exp 四个键，不含任何用户数据或组织名称', () => {
    const token = sign();
    const payload: unknown = JSON.parse(
      Buffer.from(token.split('.')[0]!, 'base64url').toString('utf-8'),
    );
    expect(Object.keys(payload as object).sort()).toEqual(['exp', 'page', 'seq', 'tid']);
    // 整串 token 解开后不含任何 PII 迹象。
    const decoded = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf-8');
    expect(decoded).not.toMatch(/(phone|mobile|email|displayName|employeeNo|userId|name)/iu);
  });

  it('过期即拒（判据是 exp <= now，边界上就算过期）', () => {
    const token = sign();
    expect(() =>
      verifyDirectoryPageToken({
        token,
        keys: [material()],
        nowMs: NOW + DIRECTORY_PAGE_TOKEN_TTL_MS,
      }),
    ).toThrow(DirectoryPageTokenError);
    expect(
      verifyDirectoryPageToken({
        token,
        keys: [material()],
        nowMs: NOW + DIRECTORY_PAGE_TOKEN_TTL_MS - 1,
      }).page,
    ).toBe(1);
  });

  it('换一把安装密钥就验不过——token 按安装实例隔离', () => {
    const token = sign();
    expect(() => verifyDirectoryPageToken({ token, keys: [material(9)], nowMs: NOW })).toThrow(
      /签名不匹配/u,
    );
    // 轮换窗口内 current + previous 同时给，只要有一把对得上就放行。
    expect(
      verifyDirectoryPageToken({ token, keys: [material(9), material()], nowMs: NOW }).seq,
    ).toBe(42);
  });

  it('篡改载荷（改 seq / 改 tid）签名立刻失配', () => {
    const token = sign();
    const [, signature] = token.split('.') as [string, string];
    for (const forged of [
      { tid: 't_demo', seq: 999, page: 1, exp: NOW + 1000 },
      { tid: 't_other', seq: 42, page: 1, exp: NOW + 1000 },
    ]) {
      const payload = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');
      expect(() =>
        verifyDirectoryPageToken({
          token: `${payload}.${signature}`,
          keys: [material()],
          nowMs: NOW,
        }),
      ).toThrow(/签名不匹配/u);
    }
  });

  it('形态非法、无密钥、字段集合不合法都抛 DirectoryPageTokenError', () => {
    const keys = [material()];
    for (const token of ['', 'nodot', 'a.b.c', '.sig', 'payload.']) {
      expect(() => verifyDirectoryPageToken({ token, keys, nowMs: NOW })).toThrow(
        DirectoryPageTokenError,
      );
    }
    expect(() => verifyDirectoryPageToken({ token: sign(), keys: [], nowMs: NOW })).toThrow(
      /没有可用的安装密钥/u,
    );
    // 签名对得上、但载荷多带一个键 → 仍然拒绝（不做宽松反序列化）。
    const key = deriveDirectoryPageTokenKey(material().installationKey);
    const payload = Buffer.from(
      JSON.stringify({ tid: 't_demo', seq: 1, page: 1, exp: NOW + 1000, extra: 'x' }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', key).update(payload).digest('base64url');
    expect(() =>
      verifyDirectoryPageToken({ token: `${payload}.${signature}`, keys, nowMs: NOW }),
    ).toThrow(/字段集合不合法/u);
  });

  it('page 必须 ≥1、seq 必须 ≥0：越界载荷即使签名合法也拒', () => {
    const key = deriveDirectoryPageTokenKey(material().installationKey);
    for (const claims of [
      { tid: 't_demo', seq: 1, page: 0, exp: NOW + 1000 },
      { tid: 't_demo', seq: -1, page: 1, exp: NOW + 1000 },
      { tid: '', seq: 1, page: 1, exp: NOW + 1000 },
    ]) {
      const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      const signature = createHmac('sha256', key).update(payload).digest('base64url');
      expect(() =>
        verifyDirectoryPageToken({
          token: `${payload}.${signature}`,
          keys: [material()],
          nowMs: NOW,
        }),
      ).toThrow(DirectoryPageTokenError);
    }
  });

  it('子密钥与 attest 子密钥不同——同一把安装密钥的两种用途互不串味', () => {
    const installationKey = randomBytes(32);
    expect(Buffer.from(deriveDirectoryPageTokenKey(installationKey)).toString('hex')).not.toBe(
      Buffer.from(deriveAttestKey(new Uint8Array(installationKey))).toString('hex'),
    );
    expect(DIRECTORY_PAGE_TOKEN_HKDF_INFO).toBe('directory-page-token');
    // 密钥长度不对直接拒，不静默用短密钥签。
    expect(() => deriveDirectoryPageTokenKey(new Uint8Array(16))).toThrow(DirectoryPageTokenError);
  });
});
