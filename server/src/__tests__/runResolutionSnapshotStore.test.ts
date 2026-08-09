import { describe, expect, it } from 'vitest';

import { PgRunResolutionSnapshotStore } from '../runtime/runResolutionSnapshotStore.js';

function draft(modelId: string) {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    tenantId: 'tenant-a',
    enforcementMode: 'enforce',
    actor: { subjectType: 'human', subjectId: 'user-1', tenantId: 'tenant-a' },
    accessDecision: {
      id: 'decision-1', verdict: 'allow', action: 'agent.run', resourceType: 'org_agent',
      resourceId: 'agent-1', subjectType: 'human', subjectId: 'user-1', accessState: 'allowed',
      reasonCode: 'ALLOWED', decisiveLayer: 'assignment', chain: [], policySnapshot: {},
      nextActions: [], evaluatedAt: '2026-08-08T00:00:00.000Z',
    },
    readiness: { ready: true, blockers: [], checkedAt: '2026-08-08T00:00:00.000Z' },
    agent: { id: 'agent-1', type: 'org_agent', revision: 1 },
    skills: [], connectors: [], credentialBindings: [], memoryScopes: [],
    model: { id: modelId, revision: 1 },
    resolvedAt: '2026-08-08T00:00:00.000Z',
  } as never;
}

describe('Run Resolution Snapshot immutable append', () => {
  it('同一 run 可追加不同 digest，同 digest 幂等，get 返回最新阶段', async () => {
    const rows: Array<{ snapshot_json: unknown; snapshot_digest: string; created_at: string }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO')) {
        const digest = String(params?.[9]);
        if (rows.some(row => row.snapshot_digest === digest)) return { rows: [], rowCount: 0 };
        const createdAt = `2026-08-08T00:00:0${rows.length + 1}.000Z`;
        rows.push({ snapshot_json: JSON.parse(String(params?.[10])), snapshot_digest: digest, created_at: createdAt });
        return { rows: [{ created_at: createdAt }], rowCount: 1 };
      }
      if (sql.includes('snapshot_digest=$2')) {
        return { rows: rows.filter(row => row.snapshot_digest === params?.[1]), rowCount: 1 };
      }
      if (sql.includes('ORDER BY snapshot_sequence DESC')) {
        return { rows: rows.length ? [rows[rows.length - 1]] : [], rowCount: rows.length ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    const store = new PgRunResolutionSnapshotStore({ query } as never, 'test');
    const first = await store.append(draft('model-v1'));
    const second = await store.append(draft('model-v2'));
    const duplicate = await store.append(draft('model-v2'));

    expect(rows).toHaveLength(2);
    expect(first.digest).not.toBe(second.digest);
    expect(duplicate.digest).toBe(second.digest);
    await expect(store.get('run-1')).resolves.toMatchObject({ model: { id: 'model-v2' } });
  });
});
