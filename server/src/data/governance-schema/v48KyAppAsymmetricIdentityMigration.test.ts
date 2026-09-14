import { describe, expect, it } from 'vitest';

import { governanceLatestMigrations } from './latestMigrations.js';
import { governanceV48KyAppAsymmetricIdentityStatements } from './v48KyAppAsymmetricIdentityMigration.js';

describe('V48 KY App 非对称身份 expand migration', () => {
  it('只追加 V2 表列且版本连续', () => {
    const statements = governanceV48KyAppAsymmetricIdentityStatements('safe');
    expect(governanceLatestMigrations('safe').at(-1)).toEqual({ version: 48, statements });
    const sql = statements.join('\n');
    expect(sql).toContain('safe_ky_app_enrollment_operations');
    expect(sql).toContain('safe_ky_app_deployment_keys');
    expect(sql).toContain('safe_ky_app_dpop_replays');
    expect(sql).toContain("DEFAULT 'v1_symmetric'");
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/iu);
  });

  it('数据库不保存 code 明文、token 或私钥', () => {
    const sql = governanceV48KyAppAsymmetricIdentityStatements('safe').join('\n');
    expect(sql).toContain('code_sha256');
    expect(sql).not.toMatch(/\bcode_plaintext\b|access_token|private_jwk|private_key/iu);
  });
});
