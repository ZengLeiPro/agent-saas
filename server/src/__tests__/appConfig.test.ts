import { afterEach, describe, expect, it } from 'vitest';

import { getAppConfigPath, parseAppConfig } from '../app/config.js';

const baseConfig = {
  agent: {
    cwd: '/tmp/agent',
  },
  server: {
    port: 3200,
  },
};

afterEach(() => {
  delete process.env.AGENT_SAAS_CONFIG_PATH;
  delete process.env.CONFIG_JSON_PATH;
});

describe('getAppConfigPath', () => {
  it('uses explicit config path env for ECS/systemd deployments', () => {
    process.env.AGENT_SAAS_CONFIG_PATH = '/etc/agent-saas/config.json';

    expect(getAppConfigPath('/opt/agent-saas/current/server')).toBe('/etc/agent-saas/config.json');
  });

  it('keeps CONFIG_JSON_PATH as a compatibility fallback', () => {
    process.env.CONFIG_JSON_PATH = '/etc/agent-saas/config.compat.json';

    expect(getAppConfigPath('/opt/agent-saas/current/server')).toBe('/etc/agent-saas/config.compat.json');
  });
});

describe('parseAppConfig', () => {
  it('accepts platform tool controls', () => {
    const config = parseAppConfig({
      ...baseConfig,
      toolControls: {
        enabled: true,
        tools: {
          Shell: { enabled: false },
          WebFetch: { enabled: false },
        },
      },
    });

    expect(config.toolControls).toEqual({
      enabled: true,
      tools: {
        Shell: { enabled: false },
        WebFetch: { enabled: false },
      },
    });
  });

  it('defaults WebSearch provider to Volcengine', () => {
    const config = parseAppConfig({
      ...baseConfig,
      webTools: {
        enabled: true,
        search: {
          enabled: true,
          apiKey: 'volcengine-secret-token',
        },
      },
    });

    expect(config.webTools?.search?.provider).toBe('volcengine');
  });

  it('accepts tenantRemoteHands config for tenant ECS hand appliances', () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          description: 'Docker hand-server in tenant ECS',
          users: ['alice'],
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
          invokeTimeoutMs: 120000,
          networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
        }],
      },
    });

    expect(config.tenantRemoteHands?.hands[0]).toMatchObject({
      id: 'tenant-ecs',
      users: ['alice'],
      baseUrl: 'http://tenant-ecs-hand:3300',
      authToken: 'tenant-token-123',
      invokeTimeoutMs: 120000,
      networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
    });
  });

  it('defaults tenant remote hand networkPolicy to public-egress with private network deny', () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
        }],
      },
    });

    expect(config.tenantRemoteHands?.hands[0]?.networkPolicy).toEqual({
      mode: 'public-egress',
      denyPrivateNetworks: true,
    });
  });

  it('accepts private-egress networkPolicy allow-lists and rejects unsafe variants', () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
          networkPolicy: {
            mode: 'private-egress',
            denyPrivateNetworks: true,
            allowCidrs: ['10.8.0.0/16'],
            allowDomains: ['internal.example.com'],
            denyCidrs: ['100.100.100.200/32'],
          },
        }],
      },
    });

    expect(config.tenantRemoteHands?.hands[0]?.networkPolicy).toMatchObject({
      mode: 'private-egress',
      allowCidrs: ['10.8.0.0/16'],
      allowDomains: ['internal.example.com'],
    });

    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
          networkPolicy: { mode: 'public-egress', allowDomains: ['internal.example.com'] },
        }],
      },
    })).toThrow(/allowCidrs\/allowDomains 只允许 private-egress/);

    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
          networkPolicy: { mode: 'private-egress', allowCidrs: ['10.999.0.0/16'] },
        }],
      },
    })).toThrow(/CIDR 格式不合法|networkPolicy\.allowCidrs 非法/);
  });

  it('accepts explicit tenant remote hand rollout modes', () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [
          {
            id: 'tenant-disabled',
            rollout: { mode: 'disabled' },
            baseUrl: 'http://tenant-disabled-hand:3300',
            authToken: 'tenant-token-123',
          },
          {
            id: 'tenant-drain',
            rollout: { mode: 'drain' },
            baseUrl: 'http://tenant-drain-hand:3300',
            authToken: 'tenant-token-drain',
          },
          {
            id: 'tenant-allowlist',
            rollout: { mode: 'allowlist', userIds: ['ky50wfyptpafch'], usernames: ['leozeng'] },
            baseUrl: 'http://tenant-allowlist-hand:3300',
            authToken: 'tenant-token-456',
          },
          {
            id: 'tenant-scope',
            rollout: { mode: 'tenant', tenantIds: ['kaiyan'] },
            baseUrl: 'http://tenant-scope-hand:3300',
            authToken: 'tenant-token-789',
          },
          {
            id: 'tenant-all',
            rollout: { mode: 'all' },
            baseUrl: 'http://tenant-all-hand:3300',
            authToken: 'tenant-token-abc',
          },
        ],
      },
    });

    expect(config.tenantRemoteHands?.hands.map((hand) => hand.rollout?.mode)).toEqual([
      'disabled',
      'drain',
      'allowlist',
      'tenant',
      'all',
    ]);
    expect(config.tenantRemoteHands?.hands[2]?.rollout).toMatchObject({
      mode: 'allowlist',
      userIds: ['ky50wfyptpafch'],
      usernames: ['leozeng'],
    });
  });

  it('rejects allowlist rollout without userIds or usernames', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          rollout: { mode: 'allowlist' },
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
        }],
      },
    })).toThrow(/allowlist rollout requires userIds or usernames/);
  });

  it('rejects tenant rollout without tenantIds', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          rollout: { mode: 'tenant' },
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
        }],
      },
    })).toThrow(/tenant rollout requires tenantIds/);
  });

  it('rejects explicit rollout mixed with legacy users or tenantIds', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          users: ['leozeng'],
          rollout: { mode: 'allowlist', userIds: ['ky50wfyptpafch'] },
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
        }],
      },
    })).toThrow(/rollout cannot be combined with legacy users or tenantIds/);
  });

  it('rejects rollout allow-list fields on all or disabled modes', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          rollout: { mode: 'all', usernames: ['leozeng'] },
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
        }],
      },
    })).toThrow(/all rollout cannot include allow-list fields/);
  });

  it('rejects unsafe tenant remote hand ids', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: '../tenant',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
        }],
      },
    })).toThrow(/tenantRemoteHands\.hands\.0\.id/);
  });

  it('rejects duplicate tenant remote hand ids', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [
          { id: 'tenant-ecs', baseUrl: 'http://tenant-a:3300', authToken: 'tenant-token-123' },
          { id: 'tenant-ecs', baseUrl: 'http://tenant-b:3300', authToken: 'tenant-token-456' },
        ],
      },
    })).toThrow(/duplicate tenant remote hand id/);
  });

  it('requires PG runtime event store when tenant remote hands are configured', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
        }],
      },
    })).toThrow(/tenantRemoteHands requires runtimeEventStore\.backend="pg"/);
  });

  it('accepts tenant remote hand with authTokenRef instead of inline authToken', () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authTokenRef: 'tenant-hand-prod',
        }],
      },
    });

    expect(config.tenantRemoteHands?.hands[0]).toMatchObject({
      id: 'tenant-ecs',
      authTokenRef: 'tenant-hand-prod',
    });
    expect(config.tenantRemoteHands?.hands[0].authToken).toBeUndefined();
  });

  it('rejects tenant remote hand with neither authToken nor authTokenRef', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
        }],
      },
    })).toThrow(/one of authToken or authTokenRef is required/);
  });

  it('rejects tenant remote hand with both authToken and authTokenRef', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'tenant-token-123',
          authTokenRef: 'tenant-hand-prod',
        }],
      },
    })).toThrow(/authToken and authTokenRef are mutually exclusive/);
  });

  it('rejects authTokenRef values that look like real secrets', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authTokenRef: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa',
        }],
      },
    })).toThrow(/authTokenRef must be a vault ref id, not an actual secret value/);
  });

  it('keeps min(8) enforcement for inline authToken', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'http://tenant-ecs-hand:3300',
          authToken: 'short',
        }],
      },
    })).toThrow();
  });

  // A4: serverRemote 共享 bearerCredentialSchema 后，应支持 authTokenRef，
  // 互斥/必填/secret-like 校验与 tenantRemoteHand 一致。


  it('accepts serverRemote and tenantRemoteHands workspace recipes for hand re-provision', () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:pass@localhost:5432/runtime',
      },
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
        authToken: 'server-remote-token-xyz',
        recipe: {
          repo: { url: 'https://github.com/acme/repo.git', ref: 'main' },
          setupCommands: ['pnpm install --frozen-lockfile'],
          resources: { timeoutMs: 120_000 },
        },
      },
      tenantRemoteHands: {
        hands: [{
          id: 'tenant-ecs',
          baseUrl: 'https://tenant-hand.example.com',
          authToken: 'tenant-token-xyz',
          recipe: {
            files: [{ artifactId: 'artifact_1', path: 'seed/data.txt', signedUrl: 'https://artifacts.example.test/a?sig=1' }],
          },
        }],
      },
    });
    expect(config.serverRemote?.recipe).toMatchObject({ repo: { ref: 'main' }, setupCommands: ['pnpm install --frozen-lockfile'] });
    expect(config.tenantRemoteHands?.hands[0]?.recipe?.files?.[0]).toMatchObject({ artifactId: 'artifact_1', path: 'seed/data.txt' });
  });

  it('accepts serverRemote inline authToken (backward compatible)', () => {
    const config = parseAppConfig({
      ...baseConfig,
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
        authToken: 'server-remote-token-xyz',
        invokeTimeoutMs: 90_000,
      },
    });
    expect(config.serverRemote).toMatchObject({
      baseUrl: 'http://127.0.0.1:3300',
      authToken: 'server-remote-token-xyz',
      invokeTimeoutMs: 90_000,
    });
  });

  it('accepts serverRemote with authTokenRef instead of inline authToken', () => {
    const config = parseAppConfig({
      ...baseConfig,
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
        authTokenRef: 'server-remote-prod',
      },
    });
    expect(config.serverRemote).toMatchObject({
      baseUrl: 'http://127.0.0.1:3300',
      authTokenRef: 'server-remote-prod',
    });
    expect(config.serverRemote?.authToken).toBeUndefined();
  });

  it('rejects serverRemote with neither authToken nor authTokenRef', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
      },
    })).toThrow(/one of authToken or authTokenRef is required/);
  });

  it('rejects serverRemote with both authToken and authTokenRef', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
        authToken: 'server-remote-token-xyz',
        authTokenRef: 'server-remote-prod',
      },
    })).toThrow(/authToken and authTokenRef are mutually exclusive/);
  });

  it('rejects serverRemote authTokenRef that looks like a real secret', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
        authTokenRef: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa',
      },
    })).toThrow(/authTokenRef must be a vault ref id, not an actual secret value/);
  });

  it('keeps min(8) enforcement for serverRemote inline authToken', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
        authToken: 'short',
      },
    })).toThrow();
  });

  // A2: SecretVault backend 选择
  it('accepts secretVault backend "memory" (default-equivalent)', () => {
    const config = parseAppConfig({
      ...baseConfig,
      secretVault: { backend: 'memory' },
    });
    expect(config.secretVault).toMatchObject({ backend: 'memory' });
  });

  it('accepts secretVault backend "encrypted-file" with encryptionKey', () => {
    const config = parseAppConfig({
      ...baseConfig,
      secretVault: {
        backend: 'encrypted-file',
        filePath: './data/secrets.enc',
        encryptionKey: 'this-is-a-dev-key-1234',
      },
    });
    expect(config.secretVault).toMatchObject({
      backend: 'encrypted-file',
      filePath: './data/secrets.enc',
    });
  });

  it('accepts secretVault backend "encrypted-file" with encryptionKeyEnv', () => {
    const config = parseAppConfig({
      ...baseConfig,
      secretVault: {
        backend: 'encrypted-file',
        filePath: './data/secrets.enc',
        encryptionKeyEnv: 'AGENT_SECRET_VAULT_KEY',
      },
    });
    expect(config.secretVault).toMatchObject({
      backend: 'encrypted-file',
      encryptionKeyEnv: 'AGENT_SECRET_VAULT_KEY',
    });
  });

  it('rejects secretVault encrypted-file without encryptionKey or encryptionKeyEnv', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      secretVault: {
        backend: 'encrypted-file',
        filePath: './data/secrets.enc',
      },
    })).toThrow(/one of encryptionKey or encryptionKeyEnv is required/);
  });

  it('rejects secretVault encrypted-file with both encryptionKey and encryptionKeyEnv', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      secretVault: {
        backend: 'encrypted-file',
        filePath: './data/secrets.enc',
        encryptionKey: 'this-is-a-dev-key-1234',
        encryptionKeyEnv: 'AGENT_SECRET_VAULT_KEY',
      },
    })).toThrow(/encryptionKey and encryptionKeyEnv are mutually exclusive/);
  });

  it('accepts secretVault backend "http" with authToken', () => {
    const config = parseAppConfig({
      ...baseConfig,
      secretVault: {
        backend: 'http',
        baseUrl: 'https://kms.internal/v1',
        authToken: 'vault-http-token',
      },
    });
    expect(config.secretVault).toMatchObject({
      backend: 'http',
      baseUrl: 'https://kms.internal/v1',
      authToken: 'vault-http-token',
    });
  });

  it('accepts secretVault backend "http" with authTokenEnv', () => {
    const config = parseAppConfig({
      ...baseConfig,
      secretVault: {
        backend: 'http',
        baseUrl: 'https://kms.internal/v1',
        authTokenEnv: 'AGENT_SECRET_VAULT_HTTP_TOKEN',
      },
    });
    expect(config.secretVault).toMatchObject({
      backend: 'http',
      authTokenEnv: 'AGENT_SECRET_VAULT_HTTP_TOKEN',
    });
  });

  it('rejects secretVault http without authToken or authTokenEnv', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      secretVault: {
        backend: 'http',
        baseUrl: 'https://kms.internal/v1',
      },
    })).toThrow(/one of authToken or authTokenEnv is required/);
  });

  it('rejects secretVault http with both authToken and authTokenEnv', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      secretVault: {
        backend: 'http',
        baseUrl: 'https://kms.internal/v1',
        authToken: 'vault-http-token',
        authTokenEnv: 'AGENT_SECRET_VAULT_HTTP_TOKEN',
      },
    })).toThrow(/authToken and authTokenEnv are mutually exclusive/);
  });

  // A5: clientDaemon bearer 复用 bearerCredentialSchema，但 token 整体 optional
  // —— 两者都省略时接受（dev/受信网络无鉴权）；二者互斥；ref 不能 secret-like。
  it('accepts clientDaemon with no auth (dev/trusted)', () => {
    const config = parseAppConfig({
      ...baseConfig,
      clientDaemon: { path: '/daemon' },
    });
    expect(config.clientDaemon?.path).toBe('/daemon');
    expect(config.clientDaemon?.authToken).toBeUndefined();
    expect(config.clientDaemon?.authTokenRef).toBeUndefined();
  });

  it('accepts clientDaemon with inline authToken', () => {
    const config = parseAppConfig({
      ...baseConfig,
      clientDaemon: { authToken: 'daemon-token-xyz' },
    });
    expect(config.clientDaemon?.authToken).toBe('daemon-token-xyz');
  });

  it('accepts clientDaemon with authTokenRef', () => {
    const config = parseAppConfig({
      ...baseConfig,
      clientDaemon: { authTokenRef: 'client-daemon-prod' },
    });
    expect(config.clientDaemon?.authTokenRef).toBe('client-daemon-prod');
  });

  it('rejects clientDaemon with both authToken and authTokenRef', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      clientDaemon: {
        authToken: 'daemon-token-xyz',
        authTokenRef: 'client-daemon-prod',
      },
    })).toThrow(/authToken and authTokenRef are mutually exclusive/);
  });

  it('rejects clientDaemon authTokenRef that looks like a real secret', () => {
    expect(() => parseAppConfig({
      ...baseConfig,
      clientDaemon: { authTokenRef: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa' },
    })).toThrow(/authTokenRef must be a vault ref id, not an actual secret value/);
  });
});
