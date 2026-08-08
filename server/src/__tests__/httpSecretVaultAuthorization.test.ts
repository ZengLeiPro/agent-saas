import { describe, expect, it, vi } from 'vitest';

import { HttpSecretVault, type SecretRef, type VaultCaller } from '../security/secretVault.js';

const aliceRead: VaultCaller = {
  actor: 'mcp_proxy',
  userId: 'alice',
  tenantId: 'tenant-a',
  scopes: ['secret:mcp:read'],
};
const aliceWrite: VaultCaller = {
  ...aliceRead,
  scopes: ['secret:mcp:write'],
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ref(ownerId: string): SecretRef {
  return {
    id: 'ref-1',
    ownerId,
    kind: 'mcp',
    metadata: {},
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  };
}

describe('HttpSecretVault authorization boundary', () => {
  it('已知 ref 在发出远端请求前执行 owner/kind ACL', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(ref('alice')));
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'service-token',
      fetchImpl,
    });
    const created = await vault.putSecret('alice', 'mcp', 'secret', aliceWrite);

    await expect(vault.getSecret(created.id, {
      ...aliceRead,
      userId: 'bob',
    })).rejects.toThrow(/user owner mismatch/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('旧未知 ref 仅允许精确 operation scope，并把 caller 交给远端权威校验', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ value: 'resolved' }));
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'service-token',
      fetchImpl,
    });

    await expect(vault.getSecret('legacy-ref', aliceRead)).resolves.toBe('resolved');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'legacy-ref', caller: aliceRead });
  });

  it('未知 ref 的 admin、wildcard scope 与错误 system Service Principal 均在本地拒绝', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'service-token',
      fetchImpl,
    });

    await expect(vault.getSecret('legacy-ref', {
      actor: 'admin',
      scopes: ['secret:mcp:read'],
    } as never)).rejects.toThrow(/unknown actor/);
    await expect(vault.getSecret('legacy-ref', {
      actor: 'mcp_proxy',
      userId: 'alice',
      scopes: ['secret:*:read'],
    })).rejects.toThrow(/exact operation scope required/);
    await expect(vault.getSecret('legacy-ref', {
      actor: 'system',
      userId: 'tool_controls_admin',
      scopes: ['secret:web_tools:read'],
    })).rejects.toThrow(/service principal mismatch/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('远端返回 ref 元数据时再次执行 ACL，不向错误 owner 泄露明文', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      value: 'must-not-return',
      ref: ref('bob'),
    }));
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'service-token',
      fetchImpl,
    });

    await expect(vault.getSecret('legacy-ref', aliceRead)).rejects.toThrow(/user owner mismatch/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
