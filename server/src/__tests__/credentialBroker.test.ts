import { describe, expect, it } from 'vitest';

import { CredentialBroker, CredentialBrokerError } from '../runtime/credentialBroker.js';
import type { GovernanceCredential } from '../data/credentials/types.js';
import type { SecretVault, VaultCaller } from '../security/secretVault.js';

const NOW = '2026-08-08T00:00:00.000Z';

function credential(overrides: Partial<GovernanceCredential> = {}): GovernanceCredential {
  return {
    credentialId: 'cred-1',
    tenantId: 'acme',
    connectorId: 'github',
    kind: 'personal_grant',
    ownerUserId: 'user-1',
    ownerUsername: 'alice',
    purpose: 'GitHub API',
    scopeSummary: { repository: 'read' },
    secretRef: 'ref-1',
    generation: 1,
    status: 'active',
    source: 'governance',
    version: 1,
    createdAt: NOW,
    createdBy: 'system',
    updatedAt: NOW,
    updatedBy: 'system',
    ...overrides,
  };
}

function buildBroker(
  credentialValue: GovernanceCredential | null,
  vaultOverride?: Partial<SecretVault>,
  authorizeUse: () => Promise<boolean> = async () => true,
  auditUse: () => Promise<void> = async () => undefined,
) {
  const calls: VaultCaller[] = [];
  const audits: Array<{ result: string; reasonCode: string; credentialId?: string }> = [];
  const ref = { id: 'x', ownerId: 'user-1', kind: 'connector', metadata: {}, createdAt: NOW, updatedAt: NOW };
  const vault: SecretVault = {
    putSecret: async () => ref,
    getSecret: async (_ref, caller) => {
      calls.push(caller);
      return 'secret-value';
    },
    rotateSecret: async () => ref,
    revokeSecret: async () => undefined,
    ...vaultOverride,
  };
  const broker = new CredentialBroker({
    credentialStore: { get: async () => credentialValue },
    vault,
    authorizeUse,
    auditUse: async input => {
      audits.push({
        result: input.result,
        reasonCode: input.reasonCode,
        ...(input.credential ? { credentialId: input.credential.credentialId } : {}),
      });
      await auditUse();
    },
    now: () => new Date(NOW),
  });
  return { broker, calls, audits };
}

const baseRequest = {
  credentialId: 'cred-1',
  tenantId: 'acme',
  connectorId: 'github',
  channel: 'connector' as const,
  delegatedUserId: 'user-1',
  agentId: 'agent-1',
  expectedGeneration: 1,
  requiredScopes: ['repository:read'],
  correlationId: 'run-1:tool-1',
  purpose: 'tool_call',
};

describe('CredentialBroker', () => {
  it('active personal grant：重读并取一次 secret，返回 generation', async () => {
    const { broker, calls, audits } = buildBroker(credential());
    const resolved = await broker.resolve(baseRequest);
    expect(resolved).toMatchObject({ credentialId: 'cred-1', generation: 1, secret: 'secret-value' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ actor: 'connector_proxy', userId: 'user-1', tenantId: 'acme' });
    expect(calls[0].scopes).toEqual(['secret:connector:read']);
    expect(audits).toEqual([{ result: 'succeeded', reasonCode: 'CREDENTIAL_RESOLVED', credentialId: 'cred-1' }]);
  });

  it('execute 每次重验并只在 server-side callback 暂时提供 Secret，记录调用结果', async () => {
    const { broker, calls, audits } = buildBroker(credential());
    const result = await broker.execute(baseRequest, async resolved => ({
      credentialId: resolved.credentialId,
      receivedSecret: resolved.secret === 'secret-value',
    }));
    expect(result).toEqual({ credentialId: 'cred-1', receivedSecret: true });
    expect(calls).toHaveLength(1);
    expect(audits.map(item => item.reasonCode)).toEqual([
      'CREDENTIAL_RESOLVED',
      'CREDENTIAL_CALL_SUCCEEDED',
    ]);
  });

  it('MCP 是调用 channel，不是 Credential kind', async () => {
    const { broker, calls } = buildBroker(credential({ connectorId: 'internal-mcp' }));
    await broker.resolve({ ...baseRequest, connectorId: 'internal-mcp', channel: 'mcp' });
    expect(calls[0].actor).toBe('mcp_proxy');
    expect(calls[0].scopes).toEqual(['secret:mcp:read']);
  });

  it.each([
    ['revoked', 'CREDENTIAL_REVOKED'],
    ['suspended', 'CREDENTIAL_SUSPENDED'],
    ['expired', 'CREDENTIAL_EXPIRED'],
    ['validation_failed', 'CREDENTIAL_VALIDATION_FAILED'],
  ] as const)('%s 状态立即拒绝，不取 secret', async (status, code) => {
    const { broker, calls } = buildBroker(credential({ status }));
    await expect(broker.resolve(baseRequest)).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(0);
  });

  it('expiresAt 到期即使 status=active 也拒绝', async () => {
    const { broker } = buildBroker(credential({ expiresAt: '2026-08-07T00:00:00.000Z' }));
    await expect(broker.resolve(baseRequest)).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRED' });
  });

  it('rotation_due 可继续使用，但 generation 仍进入返回证据', async () => {
    const { broker } = buildBroker(credential({ status: 'rotation_due', generation: 4 }));
    await expect(broker.resolve({ ...baseRequest, expectedGeneration: 4 })).resolves.toMatchObject({ generation: 4 });
  });

  it('跨租户与 connector mismatch 均拒绝', async () => {
    const { broker: crossTenant } = buildBroker(credential({ tenantId: 'other' }));
    await expect(crossTenant.resolve(baseRequest)).rejects.toMatchObject({ code: 'CREDENTIAL_TENANT_MISMATCH' });
    const { broker: wrongConnector } = buildBroker(credential({ connectorId: 'notion' }));
    await expect(wrongConnector.resolve(baseRequest)).rejects.toMatchObject({ code: 'CREDENTIAL_CONNECTOR_MISMATCH' });
  });

  it('infrastructure Credential 禁止进入通用 Broker', async () => {
    const { broker, calls } = buildBroker(credential({ kind: 'infrastructure', ownerUserId: undefined }));
    await expect(broker.resolve(baseRequest)).rejects.toMatchObject({ code: 'CREDENTIAL_INFRASTRUCTURE_FORBIDDEN' });
    expect(calls).toHaveLength(0);
  });

  it('AccessEvaluator/Assignment 适配器拒绝时不取 secret', async () => {
    const { broker, calls } = buildBroker(credential(), undefined, async () => false);
    await expect(broker.resolve(baseRequest)).rejects.toMatchObject({ code: 'CREDENTIAL_ACCESS_DENIED' });
    expect(calls).toHaveLength(0);
  });

  it('generation 与 scope 每次调用重验，旧 Run/越权 scope 不取 Secret', async () => {
    const { broker: stale, calls: staleCalls } = buildBroker(credential({ generation: 2 }));
    await expect(stale.resolve(baseRequest)).rejects.toMatchObject({ code: 'CREDENTIAL_GENERATION_MISMATCH' });
    expect(staleCalls).toHaveLength(0);

    const { broker: scopeDenied, calls: scopeCalls } = buildBroker(credential());
    await expect(scopeDenied.resolve({ ...baseRequest, requiredScopes: ['repository:write'] }))
      .rejects.toMatchObject({ code: 'CREDENTIAL_SCOPE_DENIED' });
    expect(scopeCalls).toHaveLength(0);
  });

  it('脱敏 use audit 不可用时即使已取 Secret 也 fail closed，不向调用方返回', async () => {
    const { broker } = buildBroker(credential(), undefined, async () => true, async () => {
      throw new Error('audit down');
    });
    await expect(broker.resolve(baseRequest)).rejects.toMatchObject({ code: 'CREDENTIAL_AUDIT_UNAVAILABLE' });
  });

  it('credential 不存在与 Vault 故障均 fail closed', async () => {
    const { broker: missing } = buildBroker(null);
    await expect(missing.resolve(baseRequest)).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' });
    const { broker: vaultDown } = buildBroker(credential(), {
      getSecret: async () => { throw new Error('vault down'); },
    });
    await expect(vaultDown.resolve(baseRequest)).rejects.toMatchObject({ code: 'VAULT_UNAVAILABLE' });
  });

  it('错误类型携带稳定 code 与 credentialId', () => {
    const error = new CredentialBrokerError('CREDENTIAL_REVOKED', 'cred-1');
    expect(error).toMatchObject({ code: 'CREDENTIAL_REVOKED', credentialId: 'cred-1' });
  });
});
