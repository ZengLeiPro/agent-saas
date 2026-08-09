import { describe, expect, it } from 'vitest';

import { PgHandStore } from '../runtime/handStore.js';

const NOW = '2026-08-08T00:00:00.000Z';

describe('Environment Instance → HandStore 映射', () => {
  it('init 补齐 provider/template/run/recipe/terminated 字段与索引', async () => {
    const queries: string[] = [];
    const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; } };
    const store = new PgHandStore({ pool: pool as never, tablePrefix: 'test' });
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('provider_id TEXT');
    expect(sql).toContain('template_version_id TEXT');
    expect(sql).toContain('run_id TEXT');
    expect(sql).toContain('recipe_digest TEXT');
    expect(sql).toContain('terminated_at TIMESTAMPTZ');
    expect(sql).toContain('test_hands_provider_idx');
    expect(sql).toContain('test_hands_template_idx');
    expect(sql).toContain('test_hands_run_idx');
  });

  it('register 持久化 Environment Instance 引用并归一返回', async () => {
    let params: unknown[] = [];
    const pool = {
      query: async (sql: string, input: unknown[] = []) => {
        params = input;
        return {
          rows: [{
            row_json: {
              hand_id: 'hand-1', session_id: 'session-1', workspace_id: 'ws_acme__user1',
              tenant_id: 'acme', user_id: 'user1', type: 'server-remote', status: 'ready',
              endpoint: 'https://provider.example', capabilities: [], created_at: NOW, updated_at: NOW,
              lease_expires_at: null, provider_id: 'acs', template_version_id: 'env-v2', run_id: 'run-1',
              recipe_digest: 'digest-1', terminated_at: null, metadata: {},
            },
          }],
          rowCount: 1,
        };
      },
    };
    const store = new PgHandStore({ pool: pool as never, tablePrefix: 'test' });
    const record = await store.register({
      handId: 'hand-1', sessionId: 'session-1', workspaceId: 'ws_acme__user1',
      type: 'server-remote', endpoint: 'https://provider.example', providerId: 'acs',
      templateVersionId: 'env-v2', runId: 'run-1', recipeDigest: 'digest-1',
    });
    expect(record).toMatchObject({
      providerId: 'acs', templateVersionId: 'env-v2', runId: 'run-1', recipeDigest: 'digest-1',
    });
    expect(params.slice(10, 15)).toEqual(['acs', 'env-v2', 'run-1', 'digest-1', null]);
  });
});
