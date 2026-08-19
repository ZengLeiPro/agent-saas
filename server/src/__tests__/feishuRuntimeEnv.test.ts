import { describe, expect, it, vi } from 'vitest';

import { resolveDwsConnectorRunEnv, resolveFeishuConnectorRunEnv } from '../runtime/connectorRunEnv.js';
import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { applyNativeConnectorRuntimeState } from '../connectors/runtimeState.js';
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

  it('keeps workspace credentials but isolates both CLIs while paused', async () => {
    const disabledStore = {
      isRuntimeEnabled: vi.fn(() => false),
    } as unknown as ConnectorConnectionStore;
    const identity = { tenantId: 'tenant-a', userId: 'user-a', username: 'alice' };
    const broker = { ensureFresh: vi.fn(), verify: vi.fn() };

    await expect(resolveFeishuConnectorRunEnv(broker, identity, undefined, disabledStore)).resolves.toEqual({
      LARKSUITE_CLI_CONFIG_DIR: '/tmp/agent-saas-paused/user-a/lark/config',
      LARKSUITE_CLI_DATA_DIR: '/tmp/agent-saas-paused/user-a/lark/data',
    });
    expect(broker.ensureFresh).not.toHaveBeenCalled();
    expect(resolveDwsConnectorRunEnv(disabledStore, identity)).toEqual({
      DWS_CONFIG_DIR: '/tmp/agent-saas-paused/user-a/dws/config',
    });
  });

  it('applies pause masks after tenant env so credentials cannot be merged back', () => {
    const enabled = new Set(['notion']);
    const store = {
      isRuntimeEnabled: vi.fn((_username: string, connectorId: string) => enabled.has(connectorId)),
    } as unknown as ConnectorConnectionStore;

    expect(applyNativeConnectorRuntimeState(store, { userId: 'user-a', username: 'alice' }, {
      GH_TOKEN: 'tenant-github',
      GITHUB_TOKEN: 'tenant-github',
      AUTH_TOKEN: 'tenant-x-auth',
      CT0: 'tenant-x-ct0',
      TWITTER_AUTH_TOKEN: 'tenant-x-auth',
      TWITTER_CT0: 'tenant-x-ct0',
      NOTION_API_TOKEN: 'tenant-notion',
      GOOGLE_WORKSPACE_CLI_TOKEN: 'tenant-google',
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'tenant-ak',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'tenant-sk',
      LARKSUITE_CLI_APP_ID: 'tenant-app',
      LARKSUITE_CLI_USER_ACCESS_TOKEN: 'tenant-user-token',
      DWS_CONFIG_DIR: '/workspace/.dws/config',
    })).toEqual({
      NOTION_API_TOKEN: 'tenant-notion',
      DWS_CONFIG_DIR: '/tmp/agent-saas-paused/user-a/dws/config',
      LARKSUITE_CLI_CONFIG_DIR: '/tmp/agent-saas-paused/user-a/lark/config',
      LARKSUITE_CLI_DATA_DIR: '/tmp/agent-saas-paused/user-a/lark/data',
    });
  });

  it('allowlists Lark runtime tokens and paused config overrides but rejects secrets', () => {
    expect(isHandEnvAllowed('LARKSUITE_CLI_APP_ID')).toBe(true);
    expect(isHandEnvAllowed('LARKSUITE_CLI_USER_ACCESS_TOKEN')).toBe(true);
    expect(isHandEnvAllowed('LARKSUITE_CLI_CONFIG_DIR')).toBe(true);
    expect(isHandEnvAllowed('LARKSUITE_CLI_DATA_DIR')).toBe(true);
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
