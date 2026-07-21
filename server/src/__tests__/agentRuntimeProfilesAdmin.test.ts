import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBuiltinAgentProfileRecords } from '../data/agentProfiles/builtins.js';
import type { AgentRuntimeProfileStore } from '../data/agentProfiles/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createAgentRuntimeProfilesAdminRouter } from '../routes/agentRuntimeProfilesAdmin.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

function fakeStore(): AgentRuntimeProfileStore {
  const records = createBuiltinAgentProfileRecords();
  return {
    durable: true,
    init: vi.fn(async () => undefined),
    listProfiles: vi.fn(async () => records.profiles),
    getProfile: vi.fn(async (id) => records.profiles.find((item) => item.profileId === id) ?? null),
    createProfile: vi.fn(async (input) => ({ ...records.profiles[0]!, profileId: 'created', profileKey: input.profileKey, name: input.name, status: 'draft' as const, systemProfile: false })),
    copyProfile: vi.fn(async (_id, input) => ({ ...records.profiles[0]!, profileId: 'copied', profileKey: input.profileKey, name: input.name, status: 'draft' as const, systemProfile: false })),
    updateDraft: vi.fn(async (id) => ({ ...records.profiles[0]!, profileId: id })),
    publish: vi.fn(async () => records.versions[0]!),
    archive: vi.fn(async (id) => ({ ...records.profiles[0]!, profileId: id, status: 'archived' as const })),
    listVersions: vi.fn(async () => records.versions),
    getVersion: vi.fn(async (id) => records.versions.find((item) => item.profileVersionId === id) ?? null),
    listBindings: vi.fn(async () => records.bindings),
    updateBinding: vi.fn(async (key, profileId) => ({ bindingKey: key, profileId, updatedBy: 'admin', updatedAt: new Date().toISOString() })),
    resolveBinding: vi.fn(async () => null),
  };
}

async function withApp(username: string, tenantId: string, run: (baseUrl: string, store: AgentRuntimeProfileStore) => Promise<void>) {
  const store = fakeStore();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { sub: username, username, role: 'admin', tenantId };
    next();
  });
  app.use('/api/admin/agent-profiles', createAgentRuntimeProfilesAdminRouter({ store }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  await run(`http://127.0.0.1:${address.port}`, store);
}

describe('Agent Runtime Profiles admin authorization', () => {
  it('allows delegated platform admins to read but rejects every write server-side', async () => {
    await withApp('operator', DEFAULT_TENANT_ID, async (baseUrl, store) => {
      expect((await fetch(`${baseUrl}/api/admin/agent-profiles`)).status).toBe(200);
      const mutations = [
        ['POST', '/api/admin/agent-profiles', { profileKey: 'custom_profile', name: '测试' }],
        ['PATCH', '/api/admin/agent-profiles/profile-1/draft', { expectedRevision: 1, name: '测试' }],
        ['POST', '/api/admin/agent-profiles/profile-1/copy', { profileKey: 'custom_copy', name: '副本' }],
        ['POST', '/api/admin/agent-profiles/profile-1/publish', { expectedRevision: 1 }],
        ['POST', '/api/admin/agent-profiles/profile-1/archive', { expectedRevision: 1 }],
        ['PUT', '/api/admin/agent-profiles/bindings/main', { profileId: 'profile-1' }],
      ] as const;
      for (const [method, path, body] of mutations) {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await response.json() as any).code).toBe('SUPER_ADMIN_REQUIRED');
      }
      expect(store.createProfile).not.toHaveBeenCalled();
      expect(store.updateDraft).not.toHaveBeenCalled();
      expect(store.copyProfile).not.toHaveBeenCalled();
      expect(store.publish).not.toHaveBeenCalled();
      expect(store.archive).not.toHaveBeenCalled();
      expect(store.updateBinding).not.toHaveBeenCalled();
    });
  });

  it('allows @admin to create and bind while organization admins cannot read', async () => {
    await withApp('admin', DEFAULT_TENANT_ID, async (baseUrl, store) => {
      const created = await fetch(`${baseUrl}/api/admin/agent-profiles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileKey: 'custom_profile', name: '测试' }),
      });
      expect(created.status, await created.clone().text()).toBe(201);
      expect(store.createProfile).toHaveBeenCalledOnce();
      const bound = await fetch(`${baseUrl}/api/admin/agent-profiles/bindings/main`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: 'created' }),
      });
      expect(bound.status).toBe(200);
    });

    await withApp('org-admin', 'customer-tenant', async (baseUrl) => {
      expect((await fetch(`${baseUrl}/api/admin/agent-profiles`)).status).toBe(403);
    });
  });
});
