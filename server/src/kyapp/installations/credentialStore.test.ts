import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { serviceCredentialDigest } from './credentialStore.js';

describe('服务凭据摘要（规范 §8.4：库里只存 sha256）', () => {
  it('等于明文 utf8 的 sha256 小写 hex，且长度恒为 64', () => {
    const token = '随机-32-byte-token';
    expect(serviceCredentialDigest(token)).toBe(
      createHash('sha256').update(token, 'utf8').digest('hex'),
    );
    expect(serviceCredentialDigest(token)).toMatch(/^[0-9a-f]{64}$/u);
    expect(serviceCredentialDigest('a')).not.toBe(serviceCredentialDigest('b'));
  });
});
