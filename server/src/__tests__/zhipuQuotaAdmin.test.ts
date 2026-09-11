import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelGroup, ModelsConfig } from '../app/config.js';
import { modelGroupQuotaSourceSchema } from '../app/modelQuotaSourceSchema.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createProviderQuotaAdminRouter } from '../routes/providerQuotaAdmin.js';
import {
  assertQuotaSourcesComplete, persistSubmittedQuotaSecrets, redactGroupQuotaSource,
  restoreGroupQuotaSourceSecret, submittedQuotaSecretGroups, type QuotaSecretRef,
} from '../routes/modelsAdminQuotaSource.js';

const servers: Server[] = [];
function setup(role: 'admin' | 'user' = 'admin') {
  const service = {
    overview: vi.fn(async () => ({ items: [], collector: { enabled: false, intervalMs: 300_000, lastRunAt: null, lastError: null }, generatedAt: 'now' })),
    history: vi.fn(async () => ({ hours: 24, points: [], generatedAt: 'now' })),
    refresh: vi.fn(async () => []), setPlanExpiry: vi.fn(async () => {}),
    test: vi.fn(async () => ({ windows: [], limitReached: false })),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'test-admin', username: 'test-admin', role, tenantId: DEFAULT_TENANT_ID } as NonNullable<typeof req.user>;
    next();
  });
  app.use('/quota', createProviderQuotaAdminRouter({ service }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind failed');
  const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/quota/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { service, post };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('Zhipu quota admin request boundary', () => {
  it('accepts a saved group or draft key without disclosing the credential in the response', async () => {
    const { service, post } = setup();
    const saved = await post({ provider: 'zhipu_coding_plan', groupId: 'glm' });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(service.test).toHaveBeenLastCalledWith({ provider: 'zhipu_coding_plan', groupId: 'glm' });
    const draft = await post({ provider: 'zhipu_coding_plan', apiKey: ' dummy-draft-key ' });
    expect(draft.status).toBe(200);
    expect(service.test).toHaveBeenLastCalledWith({ provider: 'zhipu_coding_plan', apiKey: 'dummy-draft-key' });
    expect(await draft.text()).not.toContain('dummy-draft-key');
  });

  it.each([
    { provider: 'zhipu_coding_plan' },
    { provider: 'zhipu_coding_plan', apiKey: ' ' },
    { provider: 'zhipu_coding_plan', apiKey: 'dummy\nkey' },
    { provider: 'zhipu_coding_plan', groupId: 'glm', apiKeyRef: 'untrusted-ref' },
    { provider: 'zhipu_coding_plan', groupId: 'glm', baseUrl: 'http://127.0.0.1' },
    { provider: 'none' },
  ])('rejects invalid or client-supplied secret references/monitor destinations', async (body) => {
    const { service, post } = setup();
    expect((await post(body)).status).toBe(400);
    expect(service.test).not.toHaveBeenCalled();
  });

  it('does not let an ordinary user query any saved model-group credential', async () => {
    const { service, post } = setup('user');
    expect((await post({ provider: 'zhipu_coding_plan', groupId: 'glm' })).status).toBeGreaterThanOrEqual(401);
    expect(service.test).not.toHaveBeenCalled();
  });
});

const oldGroup = {
  id: 'glm', name: 'Test group', apiKeyRef: 'model-key-ref', models: [],
  quotaSource: { provider: 'volcengine_ark_plan', accessKeyId: 'AK', secretAccessKeyRef: 'old-quota-ref', region: 'cn-beijing' },
} as ModelGroup;
function models(group: ModelGroup): ModelsConfig {
  return { default: 'glm/glm', allowCrossGroupSwitch: true, groups: [group] } as ModelsConfig;
}

describe('quota provider credential transitions', () => {
  it('allows Zhipu and explicit none without separate secrets but rejects injected secrets', () => {
    expect(modelGroupQuotaSourceSchema.parse({ provider: 'zhipu_coding_plan' })).toEqual({ provider: 'zhipu_coding_plan' });
    expect(modelGroupQuotaSourceSchema.parse({ provider: 'none' })).toEqual({ provider: 'none' });
    expect(modelGroupQuotaSourceSchema.safeParse({ provider: 'zhipu_coding_plan', secretAccessKey: 'dummy' }).success).toBe(false);
    expect(modelGroupQuotaSourceSchema.safeParse({ provider: 'none', secretAccessKeyRef: 'dummy' }).success).toBe(false);
  });

  it('does not restore old volcano secrets when switching to Zhipu or none', () => {
    for (const provider of ['zhipu_coding_plan', 'none']) {
      const next = restoreGroupQuotaSourceSecret({ id: 'glm', quotaSource: { provider, secretAccessKeyRef: 'client-ref', hasQuotaSecret: true } }, oldGroup);
      expect(next.quotaSource).toEqual({ provider });
    }
    const group = { ...oldGroup, quotaSource: { provider: 'zhipu_coding_plan' as const } };
    expect(redactGroupQuotaSource(group).quotaSource).toEqual({ provider: 'zhipu_coding_plan' });
    expect(() => assertQuotaSourcesComplete(models(group))).not.toThrow();
    expect(() => assertQuotaSourcesComplete(models({ ...group, apiKeyRef: undefined }))).toThrow('API Key');
  });

  it('reclaims only the old separate quota ref without creating or replacing the model key', async () => {
    const createdRefs: QuotaSecretRef[] = [];
    const replacedRefs: QuotaSecretRef[] = [];
    const next = await persistSubmittedQuotaSecrets({
      models: models({ ...oldGroup, quotaSource: { provider: 'zhipu_coding_plan' } }),
      submittedGroups: new Set(), createdRefs, replacedRefs,
      previousRefs: new Map([['glm', 'old-quota-ref']]),
    });
    expect(createdRefs).toEqual([]);
    expect(replacedRefs).toEqual([{ ref: 'old-quota-ref', kind: 'models' }]);
    expect(next.groups[0]?.apiKeyRef).toBe('model-key-ref');
    expect(submittedQuotaSecretGroups({ models: { groups: [{ id: 'glm', quotaSource: { provider: 'zhipu_coding_plan', secretAccessKey: 'ignored' } }] } }, undefined).size).toBe(0);
  });
});
