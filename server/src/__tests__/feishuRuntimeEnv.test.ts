import { describe, expect, it, vi } from 'vitest';

import { resolveFeishuConnectorRunEnv } from '../runtime/connectorRunEnv.js';
import { isHandEnvAllowed, pickHandEnv } from '../runtime/handEnvAllowlist.js';

describe('Feishu broker runtime env', () => {
  it('resolves on every run and injects only app id plus user access token', async () => {
    const ensureFresh = vi.fn(async () => ({
      version: 1 as const,
      secretId: 'feishu-token-id',
      connector: 'feishu' as const,
      tenantId: 'tenant-a',
      userId: 'user-a',
      username: 'alice',
      appId: 'cli_app',
      accessToken: 'uat-runtime',
      refreshToken: 'refresh-must-not-leak',
      expiresAt: '2026-08-01T02:00:00.000Z',
      refreshExpiresAt: '2026-08-08T00:00:00.000Z',
      scope: 'offline_access',
      tokenType: 'Bearer',
      user: { openId: 'ou-alice' },
    }));
    const broker = { ensureFresh, verify: vi.fn() };
    const identity = { tenantId: 'tenant-a', userId: 'user-a', username: 'alice' };

    const first = await resolveFeishuConnectorRunEnv(broker, identity);
    const second = await resolveFeishuConnectorRunEnv(broker, identity);
    expect(ensureFresh).toHaveBeenCalledTimes(2);
    expect(first).toEqual({
      LARKSUITE_CLI_APP_ID: 'cli_app',
      LARKSUITE_CLI_USER_ACCESS_TOKEN: 'uat-runtime',
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('refresh-must-not-leak');
    expect(first).not.toHaveProperty('FEISHU_CONNECTOR_APP_SECRET');
    expect(first).not.toHaveProperty('LARKSUITE_CLI_APP_SECRET');
  });

  it('allowlists only the two Lark runtime variables and rejects secrets', () => {
    expect(isHandEnvAllowed('LARKSUITE_CLI_APP_ID')).toBe(true);
    expect(isHandEnvAllowed('LARKSUITE_CLI_USER_ACCESS_TOKEN')).toBe(true);
    for (const key of [
      'LARKSUITE_CLI_APP_SECRET',
      'LARKSUITE_CLI_REFRESH_TOKEN',
      'LARKSUITE_CLI_PROFILE',
      'FEISHU_CONNECTOR_APP_SECRET',
      'FEISHU_REFRESH_TOKEN',
    ]) {
      expect(isHandEnvAllowed(key)).toBe(false);
    }
    expect(pickHandEnv({
      LARKSUITE_CLI_APP_ID: 'cli_app',
      LARKSUITE_CLI_USER_ACCESS_TOKEN: 'uat-runtime',
      LARKSUITE_CLI_APP_SECRET: 'must-not-leak',
      FEISHU_CONNECTOR_APP_SECRET: 'must-not-leak',
      LARKSUITE_CLI_REFRESH_TOKEN: 'must-not-leak',
    })).toEqual({
      LARKSUITE_CLI_APP_ID: 'cli_app',
      LARKSUITE_CLI_USER_ACCESS_TOKEN: 'uat-runtime',
    });
  });
});
