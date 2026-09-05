import { describe, expect, it } from 'vitest';

import { aph, isDigestHex, manifestDigest, sha256Hex, timingSafeEqualHex } from './hash.js';
import { parseIJson } from './jcs.js';
import { APH_VECTORS, EXAMPLE_MANIFEST } from './vectors.js';

describe('附录 I 的六个 aph 向量', () => {
  for (const vector of APH_VECTORS) {
    it(`${vector.name} 逐字节一致`, () => {
      const parsed = parseIJson(vector.json) as { cap: string; input: unknown };
      expect(aph({ cap: parsed.cap, input: parsed.input })).toBe(vector.aph);
    });
  }

  it('全部六个向量都被覆盖', () => {
    expect(APH_VECTORS).toHaveLength(6);
  });
});

describe('sha256Hex / manifestDigest', () => {
  it('sha256Hex 返回 64 位小写 hex', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(isDigestHex(sha256Hex('x'))).toBe(true);
  });

  it('manifestDigest 与键序无关', () => {
    const digest = manifestDigest(EXAMPLE_MANIFEST);
    expect(isDigestHex(digest)).toBe(true);
    const entries = Object.entries(EXAMPLE_MANIFEST).reverse();
    const reordered = Object.fromEntries(entries);
    expect(Object.keys(reordered)).not.toEqual(Object.keys(EXAMPLE_MANIFEST));
    expect(manifestDigest(reordered)).toBe(digest);
  });

  it('manifest 任一字段变化都会改变 digest', () => {
    const changed = { ...EXAMPLE_MANIFEST, name: '演示 ERP（改）' };
    expect(manifestDigest(changed)).not.toBe(manifestDigest(EXAMPLE_MANIFEST));
  });
});

describe('timingSafeEqualHex', () => {
  const digest = 'ce4fb584cb7e1e50362f109ac42b140a55514ffd32683df207bb86bd10f31e89';

  it('相等返回 true', () => {
    expect(timingSafeEqualHex(digest, digest)).toBe(true);
  });

  it('长度不等、非 hex、空串一律 false', () => {
    expect(timingSafeEqualHex(digest, `${digest}00`)).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(false);
    expect(timingSafeEqualHex('zz', 'zz')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
  });

  it('大小写不同的同一摘要按字节比较仍相等', () => {
    expect(timingSafeEqualHex(digest, digest.toUpperCase())).toBe(true);
  });
});
