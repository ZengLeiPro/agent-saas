import { describe, expect, it } from 'vitest';

import { buildToolsResponse, parseProvisionRecipe, parseWireRequest } from './protocol.js';

describe('parseWireRequest', () => {
  it('requires workspace id and session id, and preserves sandbox scope', () => {
    expect(parseWireRequest({ toolName: 'Shell', input: {}, context: { workspace: { id: 'ws_1' } } }).ok).toBe(false);
    const parsed = parseWireRequest({
      toolName: 'Shell',
      input: { command: 'pwd' },
      context: {
        invocationId: 'run-1:tool-1',
        workspace: { id: 'ws_1', sessionId: 'session-1', sandboxScopeId: 'ws_1', userId: 'u-1', username: 'alice', mountSubPath: 'workspaces/kaiyan/u-1' },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.context.workspace.id).toBe('ws_1');
      expect(parsed.value.context.workspace.sessionId).toBe('session-1');
      expect(parsed.value.context.workspace.sandboxScopeId).toBe('ws_1');
      expect(parsed.value.context.workspace.mountSubPath).toBe('workspaces/kaiyan/u-1');
      expect(parsed.value.context.invocationId).toBe('run-1:tool-1');
    }
  });

  it('保留 wire.context.env 中 allowlist 内的 key（AZEROTH_TOKEN / AZEROTH_API_URL）', () => {
    const parsed = parseWireRequest({
      toolName: 'Shell',
      input: { command: 'env' },
      context: {
        workspace: { id: 'ws_1', sessionId: 'session-1', username: 'admin' },
        env: {
          AZEROTH_TOKEN: 'pat_admin_test',
          AZEROTH_API_URL: 'https://fc.kaiyan.net/ky-azeroth',
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.context.env).toEqual({
        AZEROTH_TOKEN: 'pat_admin_test',
        AZEROTH_API_URL: 'https://fc.kaiyan.net/ky-azeroth',
      });
    }
  });

  it('剥离 wire.context.env 中不在 allowlist 内的敏感 key（防御纵深）', () => {
    const parsed = parseWireRequest({
      toolName: 'Shell',
      input: { command: 'env' },
      context: {
        workspace: { id: 'ws_1', sessionId: 'session-1' },
        env: {
          AZEROTH_TOKEN: 'pat_x',
          ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
          GH_TOKEN: 'ghp-should-not-leak',
          RANDOM: 'noise',
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.context.env).toEqual({ AZEROTH_TOKEN: 'pat_x' });
    }
  });

  it('wire.context.env 缺失时 parsed.env 为 undefined（不写字段）', () => {
    const parsed = parseWireRequest({
      toolName: 'Shell',
      input: {},
      context: { workspace: { id: 'ws_1', sessionId: 'session-1' } },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.context.env).toBeUndefined();
    }
  });

  it('rejects unsafe mountSubPath', () => {
    expect(parseWireRequest({
      toolName: 'Read',
      input: { path: 'MEMORY.md' },
      context: { workspace: { id: 'ws_1', sessionId: 'session-1', mountSubPath: '../kaiyan/u-1' } },
    })).toMatchObject({ ok: false });
    expect(parseWireRequest({
      toolName: 'Read',
      input: { path: 'MEMORY.md' },
      context: { workspace: { id: 'ws_1', sessionId: 'session-1', sandboxScopeId: '../other' } },
    })).toMatchObject({ ok: false });
  });
});

describe('parseProvisionRecipe', () => {
  it('reads workspaceId, sessionId and sandboxScopeId from top-level or nested recipe', () => {
    expect(parseProvisionRecipe({ workspaceId: 'ws', sandboxScopeId: 'ws', recipe: { sessionId: 's' } })).toMatchObject({
      ok: true,
      value: { workspaceId: 'ws', sessionId: 's', sandboxScopeId: 'ws' },
    });
    expect(parseProvisionRecipe({ recipe: { workspaceId: 'ws2', sessionId: 's2', sandboxScopeId: 'ws2' } })).toMatchObject({
      ok: true,
      value: { workspaceId: 'ws2', sessionId: 's2', sandboxScopeId: 'ws2' },
    });
  });

  it('rejects missing sessionId', () => {
    expect(parseProvisionRecipe({ workspaceId: 'ws' })).toMatchObject({ ok: false });
  });

  it('preserves safe mountSubPath and rejects unsafe values', () => {
    expect(parseProvisionRecipe({
      workspaceId: 'ws',
      recipe: { sessionId: 's', mountSubPath: 'workspaces/kaiyan/u-1' },
    })).toMatchObject({
      ok: true,
      value: { workspaceId: 'ws', sessionId: 's', mountSubPath: 'workspaces/kaiyan/u-1' },
    });
    expect(parseProvisionRecipe({
      workspaceId: 'ws',
      recipe: { sessionId: 's', mountSubPath: '/mnt/agent-saas/workspaces/kaiyan/u-1' },
    })).toMatchObject({ ok: false });
  });
});

describe('buildToolsResponse', () => {
  it('advertises only existing workspace hand tools', () => {
    const response = buildToolsResponse();
    const names = (response.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'Read',
      'Write',
      'Shell',
      'Edit',
      'CreateArtifact',
    ]));
    expect(names).not.toEqual(expect.arrayContaining(['List', 'Glob', 'Grep']));
  });
});
