import { describe, expect, it } from 'vitest';

import { buildToolsResponse, parseProvisionRecipe, parseWireRequest } from './protocol.js';

describe('parseWireRequest', () => {
  it('requires workspace id and session id for ACS session-scoped sandboxing', () => {
    expect(parseWireRequest({ toolName: 'Shell', input: {}, context: { workspace: { id: 'ws_1' } } }).ok).toBe(false);
    const parsed = parseWireRequest({
      toolName: 'Shell',
      input: { command: 'pwd' },
      context: {
        invocationId: 'run-1:tool-1',
        workspace: { id: 'ws_1', sessionId: 'session-1', userId: 'u-1', username: 'alice', mountSubPath: 'workspaces/kaiyan/u-1' },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.context.workspace.id).toBe('ws_1');
      expect(parsed.value.context.workspace.sessionId).toBe('session-1');
      expect(parsed.value.context.workspace.mountSubPath).toBe('workspaces/kaiyan/u-1');
      expect(parsed.value.context.invocationId).toBe('run-1:tool-1');
    }
  });

  it('rejects unsafe mountSubPath', () => {
    expect(parseWireRequest({
      toolName: 'Read',
      input: { path: 'MEMORY.md' },
      context: { workspace: { id: 'ws_1', sessionId: 'session-1', mountSubPath: '../kaiyan/u-1' } },
    })).toMatchObject({ ok: false });
  });
});

describe('parseProvisionRecipe', () => {
  it('reads workspaceId and sessionId from top-level or nested recipe', () => {
    expect(parseProvisionRecipe({ workspaceId: 'ws', recipe: { sessionId: 's' } })).toMatchObject({
      ok: true,
      value: { workspaceId: 'ws', sessionId: 's' },
    });
    expect(parseProvisionRecipe({ recipe: { workspaceId: 'ws2', sessionId: 's2' } })).toMatchObject({
      ok: true,
      value: { workspaceId: 'ws2', sessionId: 's2' },
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
      'List',
      'Shell',
      'Edit',
      'Glob',
      'Grep',
      'CreateArtifact',
    ]));
  });
});
