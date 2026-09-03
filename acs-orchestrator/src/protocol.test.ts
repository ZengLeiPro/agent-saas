import { describe, expect, it } from 'vitest';

import { buildToolsResponse, parseProvisionRecipe, parseWarmupResources, parseWireRequest } from './protocol.js';

describe('parseWireRequest', () => {
  it('requires workspace id and session id, and preserves sandbox scope', () => {
    expect(parseWireRequest({ toolName: 'Shell', input: {}, context: { workspace: { id: 'ws_1' } } }).ok).toBe(false);
    const parsed = parseWireRequest({
      toolName: 'Shell',
      input: { command: 'pwd' },
      context: {
        invocationId: 'run-1:tool-1',
        workspace: { id: 'ws_1', sessionId: 'session-1', sandboxScopeId: 'ws_1', userId: 'u-1', username: 'alice', mountSubPath: 'workspaces/kaiyan/u-1/work/task-a', sharedReadOnlySubPath: 'workspaces/kaiyan/u-1' },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.context.workspace.id).toBe('ws_1');
      expect(parsed.value.context.workspace.sessionId).toBe('session-1');
      expect(parsed.value.context.workspace.sandboxScopeId).toBe('ws_1');
      expect(parsed.value.context.workspace.mountSubPath).toBe('workspaces/kaiyan/u-1/work/task-a');
      expect(parsed.value.context.workspace.sharedReadOnlySubPath).toBe('workspaces/kaiyan/u-1');
      expect(parsed.value.context.invocationId).toBe('run-1:tool-1');
    }
  });

  it('validates versioned correlation and legacy identity agreement', () => {
    const parsed = parseWireRequest({
      toolName: 'Shell', input: {},
      context: {
        invocationId: 'run-1:call-1',
        correlation: { version: 1, invocationId: 'run-1:call-1', attemptId: 'attempt-1' },
        workspace: { id: 'ws_1', sessionId: 'session-1' },
      },
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: { context: { correlation: { version: 1, attemptId: 'attempt-1' } } },
    });
    expect(parseWireRequest({
      toolName: 'Shell', input: {},
      context: {
        invocationId: 'legacy-a',
        correlation: { version: 1, invocationId: 'contract-b' },
        workspace: { id: 'ws_1', sessionId: 'session-1' },
      },
    })).toMatchObject({ ok: false });
    expect(parseWireRequest({
      toolName: 'Shell', input: {},
      context: {
        correlation: { version: 2 },
        workspace: { id: 'ws_1', sessionId: 'session-1' },
      },
    })).toMatchObject({ ok: false });
  });

  it('rejects non-string legacy invocation and hand identities at the wire boundary', () => {
    for (const invalid of [123, null, { nested: true }]) {
      expect(parseWireRequest({
        toolName: 'Shell', input: {},
        context: { invocationId: invalid, workspace: { id: 'ws_1', sessionId: 'session-1' } },
      })).toMatchObject({ ok: false });
      expect(parseWireRequest({
        toolName: 'Shell', input: {},
        context: { handId: invalid, workspace: { id: 'ws_1', sessionId: 'session-1' } },
      })).toMatchObject({ ok: false });
    }
  });

  it('uses correlation-only invocation identity for ACS cancel/single-flight', () => {
    expect(parseWireRequest({
      toolName: 'Shell', input: {},
      context: {
        correlation: { version: 1, invocationId: 'correlation-only', attemptId: 'attempt-1' },
        workspace: { id: 'ws_1', sessionId: 'session-1' },
      },
    })).toMatchObject({
      ok: true,
      value: { context: { invocationId: 'correlation-only' } },
    });
  });

  it('strictly parses an optional sandbox resource override', () => {
    expect(parseWireRequest({
      toolName: 'Shell',
      input: {},
      context: {
        workspace: {
          id: 'ws_1', sessionId: 'session-1',
          sandboxResources: { cpu: '1', memoryMb: 2048 },
        },
      },
    })).toMatchObject({
      ok: true,
      value: { context: { workspace: { sandboxResources: { cpu: '1', memoryMb: 2048 } } } },
    });
    for (const sandboxResources of [
      { cpu: '0', memoryMb: 2048 },
      { cpu: '1', memoryMb: 0 },
      { cpu: '1', memoryMb: 2048, timeoutMs: 1 },
      'daily',
    ]) {
      expect(parseWireRequest({
        toolName: 'Shell', input: {},
        context: { workspace: { id: 'ws_1', sessionId: 'session-1', sandboxResources } },
      })).toMatchObject({ ok: false });
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

  it('保留标准连接器 env，并剥离危险或非法 key（防御纵深）', () => {
    const parsed = parseWireRequest({
      toolName: 'Shell',
      input: { command: 'env' },
      context: {
        workspace: { id: 'ws_1', sessionId: 'session-1' },
        env: {
          AZEROTH_TOKEN: 'pat_x',
          GH_TOKEN: 'ghp_x',
          NOTION_TOKEN: 'notion_x',
          PATH: '/tmp/evil',
          NODE_OPTIONS: '--require /tmp/evil.js',
          lowercase: 'invalid-name',
          'BAD-NAME': 'invalid-name',
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.context.env).toEqual({
        AZEROTH_TOKEN: 'pat_x',
        GH_TOKEN: 'ghp_x',
        NOTION_TOKEN: 'notion_x',
      });
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

  it('preserves a complete runtime isolation binding and rejects recipe identity mismatch', () => {
    const requirement = {
      tenantId: 'tenant-1', taskId: 'task-1', runId: 'run-1', sessionId: 's', workspaceId: 'ws',
      policyDigest: 'a'.repeat(64),
    };
    expect(parseProvisionRecipe({
      workspaceId: 'ws', recipe: { sessionId: 's', runtimeIsolationRequirement: requirement },
    })).toMatchObject({ ok: true, value: { runtimeIsolationRequirement: requirement } });
    expect(parseProvisionRecipe({
      workspaceId: 'ws', recipe: { sessionId: 's', runtimeIsolationRequirement: { ...requirement, sessionId: 'other' } },
    })).toMatchObject({ ok: false });
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
