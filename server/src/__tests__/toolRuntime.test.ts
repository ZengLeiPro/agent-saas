import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { MemoryIndexService } from '../memory/index/service.js';
import type { ChannelContext } from '../types/index.js';
import {
  applyToolDescriptionOverride,
  LocalWorkspaceProvider,
  MAX_FILE_BYTES,
  PlatformToolRuntime,
  readFileToolDescriptor,
  runShellToolDescriptor,
  ServerLocalExecutionProvider,
  WORKSPACE_HAND_TOOLS,
  type AuthorizedToolCall,
  type WorkspaceRef,
} from '../agent/toolRuntime.js';
import { WebToolProvider } from '../agent/webToolProvider.js';
import type { ExecutionTransport } from '../runtime/executionTransport.js';
import { DefaultExecutionTransportRegistry } from '../runtime/inProcessTransport.js';
import type { ToolInvocationResponse } from '../runtime/handProtocol.js';
import type { HandRecord, HandStore, RegisterHandInput, HandStatus } from '../runtime/handStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import {
  DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS,
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_BACKGROUND_SHELL_TIMEOUT_MS,
  MAX_SHELL_TIMEOUT_MS,
} from '../agent/toolOutput.js';

function successResponse(content: string): ToolInvocationResponse {
  return { status: 'success', content };
}

function mockExecutionTransport(invoke: ExecutionTransport['invoke']): ExecutionTransport {
  return {
    invoke,
    listInternalTools: () => WORKSPACE_HAND_TOOLS,
  };
}

class MemoryHandStore implements HandStore {
  constructor(private readonly hands: HandRecord[]) {}
  async register(_input: RegisterHandInput): Promise<HandRecord> { throw new Error('not implemented'); }
  async updateStatus(handId: string, status: HandStatus): Promise<HandRecord | null> {
    const hand = this.hands.find((item) => item.handId === handId);
    if (!hand) return null;
    hand.status = status;
    hand.updatedAt = new Date().toISOString();
    return hand;
  }
  async get(handId: string): Promise<HandRecord | null> { return this.hands.find((hand) => hand.handId === handId) ?? null; }
  async listBySession(sessionId: string): Promise<HandRecord[]> { return this.hands.filter((hand) => hand.sessionId === sessionId); }
  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> { return this.hands.filter((hand) => hand.workspaceId === workspaceId); }
}

const adminContext: ChannelContext = {
  channel: 'web',
  user: {
    id: 'admin-1',
    username: 'admin',
    role: 'admin',
    // 平台 admin fixture：server-local Shell 仍允许（需 approval）。
    tenantId: DEFAULT_TENANT_ID,
  },
};

function workspace(root = '/tmp/workspace'): WorkspaceRef {
  return {
    root,
    userId: 'admin-1',
    username: 'admin',
    sessionId: 'session-1',
    executionTarget: 'server-local',
  };
}

describe('PlatformToolRuntime', () => {
  it('allows shell execution up to ten minutes and rejects longer requests', () => {
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(600_000);
    expect(runShellToolDescriptor.schema.parse({ command: 'sleep 1', timeoutMs: MAX_SHELL_TIMEOUT_MS }))
      .toEqual({ command: 'sleep 1', timeoutMs: 600_000 });
    expect(() => runShellToolDescriptor.schema.parse({ command: 'sleep 1', timeoutMs: MAX_SHELL_TIMEOUT_MS + 1 }))
      .toThrow();
    expect(runShellToolDescriptor.schema.parse({
      command: 'sleep 3600',
      mode: 'background',
      timeoutMs: MAX_BACKGROUND_SHELL_TIMEOUT_MS,
    })).toEqual({ command: 'sleep 3600', mode: 'background', timeoutMs: MAX_BACKGROUND_SHELL_TIMEOUT_MS });
    expect(DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS).toBe(3_600_000);
  });

  it('resolves workspace identity from sessionOwner on scheduler wake paths', () => {
    const provider = new LocalWorkspaceProvider('server-container');
    const workspace = provider.resolve({
      channel: 'web',
      sessionOwner: {
        id: 'admin-1',
        username: 'admin',
        role: 'admin',
        tenantId: DEFAULT_TENANT_ID,
      },
    }, {
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    });

    expect(workspace.userId).toBe('admin-1');
    expect(workspace.username).toBe('admin');
    expect(workspace.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(workspace.executionTarget).toBe('server-container');
  });

  it('exposes stable platform tool descriptors and risk levels', () => {
    const runtime = new PlatformToolRuntime();
    const descriptors = runtime.list();

    expect(descriptors.map((descriptor) => [descriptor.id, descriptor.risk])).toEqual([
      ['WaitForWorkspaceReady', 'safe'],
      ['Read', 'safe'],
      ['Write', 'workspace_write'],
      ['List', 'safe'],
      ['Shell', 'dangerous'],
      ['BashOutput', 'safe'],
      ['KillBash', 'safe'],
      ['Edit', 'workspace_write'],
      ['Glob', 'safe'],
      ['Grep', 'safe'],
    ]);
  });

  it('exposes CreateArtifact only when artifact service is configured', () => {
    expect(new PlatformToolRuntime().list().map((tool) => tool.id)).not.toContain('CreateArtifact');
    expect(new PlatformToolRuntime({ artifactService: {} as never }).list().map((tool) => tool.id))
      .toContain('CreateArtifact');
  });

  it('only exposes MemorySearch when a memory index service is configured', () => {
    const memoryIndexService = {
      getIndexer: () => ({ search: async () => ({ results: [], meta: { totalCandidates: 0, filteredOut: 0, bestFilteredScore: 0 } }) }),
    } as unknown as MemoryIndexService;

    expect(new PlatformToolRuntime().list().map((tool) => tool.id))
      .not.toContain('MemorySearch');
    expect(new PlatformToolRuntime({ memoryIndexService }).list().map((tool) => tool.id))
      .toContain('MemorySearch');
  });

  it('exposes provider-injected platform tools', () => {
    const runtime = new PlatformToolRuntime({
      providers: [new WebToolProvider({ fetch: {} })],
    });

    expect(runtime.list().map((tool) => tool.id)).toContain('WebFetch');
  });

  it('reads large files by prefix and explicit line ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-read-range-'));
    try {
      const provider = new ServerLocalExecutionProvider();
      const lines = Array.from({ length: 2_500 }, (_, index) => `line-${index + 1} ${'x'.repeat(80)}`);
      await writeFile(join(root, 'big.txt'), lines.join('\n'), 'utf-8');

      const defaultResp = await provider.execute({
        toolName: 'Read',
        input: { path: 'big.txt' },
        context: { workspace: workspace(root) },
      });
      expect(defaultResp.status).toBe('success');
      if (defaultResp.status === 'success') {
        expect(defaultResp.content).toContain('line-1 ');
        expect(defaultResp.content).toContain(`showing first ${MAX_FILE_BYTES} bytes`);
        expect(defaultResp.content).toContain('"offset":1');
      }

      const rangeResp = await provider.execute({
        toolName: 'Read',
        input: { path: 'big.txt', offset: 10, limit: 3 },
        context: { workspace: workspace(root) },
      });
      expect(rangeResp.status).toBe('success');
      if (rangeResp.status === 'success') {
        expect(rangeResp.content).toContain('line-10 ');
        expect(rangeResp.content).toContain('line-11 ');
        expect(rangeResp.content).toContain('line-12 ');
        expect(rangeResp.content).not.toContain('line-9 ');
        expect(rangeResp.content).toContain('next Read offset=13');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a truncated successful shell result for output over the model-visible budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-shell-output-'));
    try {
      const provider = new ServerLocalExecutionProvider();
      const response = await provider.execute({
        toolName: 'Shell',
        input: { command: 'node -e "process.stdout.write(\\"x\\".repeat(70 * 1024))"', timeoutMs: 10_000 },
        context: { workspace: workspace(root) },
      });

      expect(response.status).toBe('success');
      if (response.status === 'success') {
        expect(response.content).toContain('Exit code: 0');
        expect(response.content).toContain('Output bytes: stdout=');
        expect(response.content).toContain('Full output files: stdout=tmp/tool-results/');
        expect(response.content).toContain('[stdout]');
        expect(response.content).toContain('truncated');
        expect(response.content.length).toBeLessThan(70 * 1024);
        const match = /stdout=(tmp\/tool-results\/[^ ]+\.txt)/.exec(response.content);
        expect(match?.[1]).toBeTruthy();
        const saved = await readFile(join(root, match![1]!), 'utf-8');
        expect(saved).toHaveLength(70 * 1024);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('filters disabled platform tools and rejects disabled invocations', async () => {
    const runtime = new PlatformToolRuntime({
      toolControls: {
        tools: {
          Shell: { enabled: false },
          WebFetch: { enabled: false },
        },
      },
      providers: [new WebToolProvider({ fetch: {} })],
    });

    const toolIds = runtime.list().map((tool) => tool.id);
    expect(toolIds).not.toContain('Shell');
    expect(toolIds).not.toContain('WebFetch');
    expect(toolIds).toContain('Read');

    await expect(runtime.invoke(
      {
        toolId: 'Shell',
        input: { command: 'pwd' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        channelContext: adminContext,
        workspace: workspace('/tmp/project'),
        signal: new AbortController().signal,
      },
    )).rejects.toThrow(/disabled by platform config/);
  });

  it('hides all platform tools when tool controls are globally disabled', () => {
    const runtime = new PlatformToolRuntime({
      toolControls: { enabled: false },
      providers: [new WebToolProvider({ fetch: {} })],
    });

    expect(runtime.list()).toEqual([]);
  });

  it('delegates shell execution through the execution transport with workspace context', async () => {
    const invoke = vi.fn(async () => successResponse('shell result'));
    const executionTransport = mockExecutionTransport(invoke);
    const runtime = new PlatformToolRuntime({ executionTransport });
    const signal = new AbortController().signal;

    const result = await runtime.invoke(
      {
        toolId: 'Shell',
        input: { command: 'pwd', timeoutMs: 123 },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        channelContext: adminContext,
        workspace: workspace('/tmp/project'),
        signal,
      },
    );

    expect(result.content).toBe('shell result');
    expect(invoke).toHaveBeenCalledWith({
      toolName: 'Shell',
      input: { command: 'pwd', timeoutMs: 123 },
      context: {
        workspace: expect.objectContaining({ root: '/tmp/project', executionTarget: 'server-local' }),
        signal,
      },
    });
  });

  it('reserves a durable task before starting Shell(mode=background), then activates it after ACS accepts', async () => {
    const invoke = vi.fn(async () => successResponse(JSON.stringify({ taskId: 'shell-bg-task-1', status: 'starting' })));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-remote', mockExecutionTransport(invoke)],
    ]);
    const reserveCommand = vi.fn(async () => ({ taskId: 'shell-bg-task-1', status: 'starting' as const }));
    const activateCommand = vi.fn(async () => undefined);
    const failCommandStart = vi.fn(async () => undefined);
    const runtime = new PlatformToolRuntime({
      executionTransportRegistry: registry,
      backgroundTasks: {
        reserveCommand,
        activateCommand,
        failCommandStart,
      } as never,
    });
    const context = {
      channelContext: {
        channel: 'web' as const,
        sessionOwner: { id: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'tenant-1' },
      },
      workspace: {
        ...workspace('/tmp/project'),
        id: 'workspace-1',
        tenantId: 'tenant-1',
        executionTarget: 'server-remote' as const,
      },
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
    };

    const result = await runtime.invoke({
      toolId: 'Shell',
      input: { command: 'pnpm build', mode: 'background', timeoutMs: 3_600_000 },
      authorization: { approved: true, source: 'human_approval' },
    }, context);

    expect(result.content).toContain('shell-bg-task-1');
    expect(reserveCommand).toHaveBeenCalledWith(context, { command: 'pnpm build', timeoutMs: 3_600_000 });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'Shell',
      input: { command: 'pnpm build', mode: 'background', timeoutMs: 3_600_000, taskId: 'shell-bg-task-1' },
    }));
    expect(activateCommand).toHaveBeenCalledWith(context, 'shell-bg-task-1');
    expect(failCommandStart).not.toHaveBeenCalled();
  });

  it('kills the reserved command when ACS start returns an error', async () => {
    const invoke = vi.fn(async (request: Parameters<ExecutionTransport['invoke']>[0]) => request.toolName === 'Shell'
      ? { status: 'error' as const, error: 'ACS start failed' }
      : successResponse('{}'));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-remote', mockExecutionTransport(invoke)],
    ]);
    const failCommandStart = vi.fn(async () => undefined);
    const runtime = new PlatformToolRuntime({
      executionTransportRegistry: registry,
      backgroundTasks: {
        reserveCommand: vi.fn(async () => ({ taskId: 'shell-bg-task-2', status: 'starting' as const })),
        activateCommand: vi.fn(async () => undefined),
        failCommandStart,
      } as never,
    });
    const context = {
      channelContext: {
        channel: 'web' as const,
        sessionOwner: { id: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'tenant-1' },
      },
      workspace: {
        ...workspace('/tmp/project'),
        id: 'workspace-1',
        tenantId: 'tenant-1',
        executionTarget: 'server-remote' as const,
      },
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
    };

    await expect(runtime.invoke({
      toolId: 'Shell',
      input: { command: 'pnpm build', mode: 'background' },
      authorization: { approved: true, source: 'human_approval' },
    }, context)).rejects.toThrow('ACS start failed');

    expect(invoke.mock.calls.map(([request]) => request.toolName)).toEqual(['Shell', 'KillBash']);
    expect(invoke.mock.calls[1]?.[0].context).not.toHaveProperty('signal');
    expect(invoke.mock.calls[1]?.[0].context).not.toHaveProperty('invocationId');
    expect(failCommandStart).toHaveBeenCalledWith(context, 'shell-bg-task-2', 'ACS start failed');
  });

  it('allows approved shell execution for admin-owned resumed sessions without an authenticated user context', async () => {
    const invoke = vi.fn(async () => successResponse('shell result'));
    const executionTransport = mockExecutionTransport(invoke);
    const runtime = new PlatformToolRuntime({ executionTransport });

    const result = await runtime.invoke(
      {
        toolId: 'Shell',
        input: { command: 'pwd', timeoutMs: 123 },
        authorization: { approved: true, source: 'human_approval' },
      },
      {
        channelContext: {
          channel: 'web',
          // 修 P1 BUG #3：sessionOwner 也要带平台 tenantId 才被 isPlatformAdmin 通过
          sessionOwner: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
        },
        workspace: workspace('/tmp/project'),
      },
    );

    expect(result.content).toBe('shell result');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('rejects approved shell execution for non-admin resumed sessions on unsafe server-local', async () => {
    const invoke = vi.fn(async () => successResponse('shell result'));
    const executionTransport = mockExecutionTransport(invoke);
    const runtime = new PlatformToolRuntime({ executionTransport });

    await expect(runtime.invoke(
      {
        toolId: 'Shell',
        input: { command: 'pwd', timeoutMs: 123 },
        authorization: { approved: true, source: 'human_approval' },
      },
      {
        channelContext: {
          channel: 'web',
          sessionOwner: { id: 'user-1', username: 'alice', role: 'user' },
        },
        workspace: workspace('/tmp/project'),
      },
    )).rejects.toThrow('Shell requires an isolated hand/container for non-platform users');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects Shell for tenant admin on unsafe server-local (修 P1 BUG #3 关键回归)', async () => {
    // 任意客户组织 admin (role=admin + 非默认 tenant) 不能在 server-local/raw host
    // 路径运行 shell。实测背景：之前 wain_admin 用 Shell cat
    // /Users/admin/workspace-openai-runtime/kaiyan/admin/MEMORY.md EXIT=0 直接读到开沿数据。
    const invoke = vi.fn(async () => successResponse('shell result'));
    const executionTransport = mockExecutionTransport(invoke);
    const runtime = new PlatformToolRuntime({ executionTransport });

    await expect(runtime.invoke(
      {
        toolId: 'Shell',
        input: { command: 'pwd', timeoutMs: 123 },
        authorization: { approved: true, source: 'human_approval' },
      },
      {
        channelContext: {
          channel: 'web',
          // role=admin + 非默认 tenant = 组织 admin（不是平台 admin）
          sessionOwner: { id: 'wain-admin-1', username: 'wain_admin', role: 'admin', tenantId: 'wain-test' },
        },
        workspace: workspace('/tmp/project'),
      },
    )).rejects.toThrow('Shell requires an isolated hand/container for non-platform users');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects Shell on server-local when admin lacks tenantId (fail-closed)', async () => {
    // 防 fail-open：缺少 tenantId 字段时也应拒绝，不应静默放行
    const invoke = vi.fn(async () => successResponse('shell result'));
    const executionTransport = mockExecutionTransport(invoke);
    const runtime = new PlatformToolRuntime({ executionTransport });

    await expect(runtime.invoke(
      {
        toolId: 'Shell',
        input: { command: 'pwd', timeoutMs: 123 },
        authorization: { approved: true, source: 'human_approval' },
      },
      {
        channelContext: {
          channel: 'web',
          // 无 tenantId
          sessionOwner: { id: 'admin-x', username: 'admin', role: 'admin' },
        },
        workspace: workspace('/tmp/project'),
      },
    )).rejects.toThrow('Shell requires an isolated hand/container for non-platform users');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('allows Shell for tenant users when routed to an isolated execution target', async () => {
    const localInvoke = vi.fn(async () => successResponse('local result'));
    const containerInvoke = vi.fn(async () => successResponse('container shell result'));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-local', mockExecutionTransport(localInvoke)],
      ['server-container', mockExecutionTransport(containerInvoke)],
    ]);
    const runtime = new PlatformToolRuntime({ executionTransportRegistry: registry });

    const result = await runtime.invoke(
      {
        toolId: 'Shell',
        input: { command: 'pwd', timeoutMs: 123 },
        authorization: { approved: true, source: 'human_approval' },
      },
      {
        channelContext: {
          channel: 'web',
          sessionOwner: { id: 'wain-user-1', username: 'wain_user', role: 'user', tenantId: 'wain-test' },
        },
        workspace: { ...workspace('/tmp/project'), executionTarget: 'server-container' },
      },
    );

    expect(result.content).toBe('container shell result');
    expect(containerInvoke).toHaveBeenCalledWith({
      toolName: 'Shell',
      input: { command: 'pwd', timeoutMs: 123 },
      context: {
        workspace: expect.objectContaining({ root: '/tmp/project', executionTarget: 'server-container' }),
        signal: undefined,
      },
    });
    expect(localInvoke).not.toHaveBeenCalled();
  });

  it('allows Shell for tenant admin through the automatic tenant remote hand', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      status: 'success',
      content: 'remote shell result',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);
    const localInvoke = vi.fn(async () => successResponse('local result'));
    try {
      const registry = new DefaultExecutionTransportRegistry([
        ['server-local', mockExecutionTransport(localInvoke)],
      ]);
      const handStore = new MemoryHandStore([{
        handId: 'session-1:tenant-acs',
        sessionId: 'session-1',
        workspaceId: 'workspace-tenant',
        type: 'server-remote',
        status: 'ready',
        endpoint: 'http://tenant-hand.example',
        capabilities: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: { tenantRemoteHandId: 'tenant-acs' },
      }]);
      const runtime = new PlatformToolRuntime({
        executionTransportRegistry: registry,
        handStore,
        resolveHandAuthToken: () => 'tenant-token-123',
      });

      const result = await runtime.invoke(
        {
          toolId: 'Shell',
          input: { command: 'pwd', timeoutMs: 123 },
          authorization: { approved: true, source: 'human_approval' },
        },
        {
          channelContext: {
            channel: 'web',
            sessionOwner: { id: 'wain-admin-1', username: 'wain_admin', role: 'admin', tenantId: 'wain-test' },
          },
          sessionId: 'session-1',
          workspace: { ...workspace('/tmp/project'), id: 'workspace-tenant', sessionId: 'session-1' },
        },
      );

      expect(result.content).toBe('remote shell result');
      expect(localInvoke).not.toHaveBeenCalled();
      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.toolName).toBe('Shell');
      expect(body.input).toEqual({ command: 'pwd', timeoutMs: 123 });
      expect(body.context.handId).toBe('session-1:tenant-acs');
      expect(body.context.workspace).toMatchObject({
        id: 'workspace-tenant',
        executionTarget: 'server-remote',
      });
      expect(body.context.workspace.root).toBeUndefined();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('routes workspace tools through the transport selected by executionTarget', async () => {
    const localInvoke = vi.fn(async () => successResponse('local result'));
    const containerInvoke = vi.fn(async () => successResponse('container result'));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-local', mockExecutionTransport(localInvoke)],
      ['server-container', mockExecutionTransport(containerInvoke)],
    ]);
    const runtime = new PlatformToolRuntime({ executionTransportRegistry: registry });

    const result = await runtime.invoke(
      {
        toolId: 'Read',
        input: { path: 'hello.txt' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        channelContext: adminContext,
        workspace: { ...workspace('/tmp/project'), executionTarget: 'server-container' },
      },
    );

    expect(result.content).toBe('container result');
    expect(containerInvoke).toHaveBeenCalledWith({
      toolName: 'Read',
      input: { path: 'hello.txt' },
      context: {
        workspace: expect.objectContaining({ root: '/tmp/project', executionTarget: 'server-container' }),
        signal: undefined,
      },
    });
    expect(localInvoke).not.toHaveBeenCalled();
  });

  it('routes hand-backed Edit through the selected workspace transport', async () => {
    const localInvoke = vi.fn(async () => successResponse('local result'));
    const containerInvoke = vi.fn(async () => successResponse('edited in container'));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-local', mockExecutionTransport(localInvoke)],
      ['server-container', mockExecutionTransport(containerInvoke)],
    ]);
    const runtime = new PlatformToolRuntime({ executionTransportRegistry: registry });

    const result = await runtime.invoke(
      {
        toolId: 'Edit',
        input: { file_path: 'hello.txt', old_string: 'a', new_string: 'b' },
        authorization: { approved: true, source: 'human_approval' },
      },
      {
        channelContext: adminContext,
        workspace: { ...workspace('/tmp/project'), executionTarget: 'server-container' },
      },
    );

    expect(result.content).toBe('edited in container');
    expect(containerInvoke).toHaveBeenCalledWith({
      toolName: 'Edit',
      input: { file_path: 'hello.txt', old_string: 'a', new_string: 'b' },
      context: {
        workspace: expect.objectContaining({ root: '/tmp/project', executionTarget: 'server-container' }),
        signal: undefined,
      },
    });
    expect(localInvoke).not.toHaveBeenCalled();
  });

  it('ignores model-supplied handId and uses the default execution target when no tenant default exists', async () => {
    const localInvoke = vi.fn(async () => successResponse('local result'));
    const clientInvoke = vi.fn(async () => successResponse('client result'));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-local', mockExecutionTransport(localInvoke)],
      ['client', mockExecutionTransport(clientInvoke)],
    ]);
    const handStore = new MemoryHandStore([{
      handId: 'client-laptop',
      sessionId: 'session-1',
      workspaceId: 'workspace-client',
      type: 'client',
      status: 'ready',
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: {},
    }]);
    const runtime = new PlatformToolRuntime({ executionTransportRegistry: registry, handStore });

    const result = await runtime.invoke(
      {
        toolId: 'Read',
        input: { path: 'hello.txt', handId: 'client-laptop' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        channelContext: adminContext,
        workspace: { ...workspace('/tmp/project'), executionTarget: 'server-local' },
      },
    );

    expect(result.content).toBe('local result');
    expect(localInvoke).toHaveBeenCalledWith({
      toolName: 'Read',
      input: { path: 'hello.txt' },
      context: {
        workspace: expect.objectContaining({ root: '/tmp/project', executionTarget: 'server-local' }),
        signal: undefined,
      },
    });
    expect(clientInvoke).not.toHaveBeenCalled();
  });

  it('automatically routes workspace tools to the sole ready tenant remote hand', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      status: 'success',
      content: 'remote result',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const registry = new DefaultExecutionTransportRegistry([
        ['server-local', mockExecutionTransport(vi.fn(async () => successResponse('local result')))],
      ]);
      const handStore = new MemoryHandStore([{
        handId: 'session-1:tenant-ecs',
        sessionId: 'session-1',
        workspaceId: 'workspace-tenant',
        type: 'server-remote',
        status: 'ready',
        endpoint: 'http://tenant-hand.example',
        capabilities: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: { tenantRemoteHandId: 'tenant-ecs' },
      }]);
      const runtime = new PlatformToolRuntime({
        executionTransportRegistry: registry,
        handStore,
        resolveHandAuthToken: (hand) => hand.metadata.tenantRemoteHandId === 'tenant-ecs' ? 'tenant-token-123' : undefined,
      });

      const result = await runtime.invoke(
        {
          toolId: 'Read',
          input: { path: 'hello.txt' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        {
          channelContext: adminContext,
          workspace: { ...workspace('/tmp/project'), id: 'workspace-tenant', executionTarget: 'server-local' },
        },
      );

      expect(result.content).toBe('remote result');
      expect(fetchMock).toHaveBeenCalledWith('http://tenant-hand.example/execute', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer tenant-token-123' }),
      }));
      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.input).toEqual({ path: 'hello.txt' });
      expect(body.context.handId).toBe('session-1:tenant-ecs');
      expect(body.context.workspace).toMatchObject({
        id: 'workspace-tenant',
        executionTarget: 'server-remote',
      });
      expect(body.context.workspace.root).toBeUndefined();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('WaitForWorkspaceReady reports the current runtime status without exposing hand details', async () => {
    const localInvoke = vi.fn(async () => successResponse('local result'));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-local', mockExecutionTransport(localInvoke)],
    ]);
    const handStore = new MemoryHandStore([{
      handId: 'session-1:agent-saas-acs',
      sessionId: 'session-1',
      workspaceId: 'workspace-tenant',
      type: 'server-remote',
      status: 'provisioning',
      endpoint: 'http://tenant-hand.example',
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    }]);
    const runtime = new PlatformToolRuntime({ executionTransportRegistry: registry, handStore });

    const result = await runtime.invoke(
      {
        toolId: 'WaitForWorkspaceReady',
        input: { timeoutMs: 0 },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        channelContext: adminContext,
        sessionId: 'session-1',
        workspace: { ...workspace('/tmp/project'), id: 'workspace-tenant', sessionId: 'session-1', executionTarget: 'server-local' },
      },
    );

    const parsed = JSON.parse(result.content);
    expect(parsed).toMatchObject({
      status: 'provisioning',
      workspaceId: 'workspace-tenant',
      executionTarget: 'server-remote',
    });
    expect(parsed).not.toHaveProperty('handId');
    expect(parsed).not.toHaveProperty('hands');
    expect(localInvoke).not.toHaveBeenCalled();
  });

  it('WaitForWorkspaceReady waits until the tenant remote hand becomes ready', async () => {
    const handStore = new MemoryHandStore([{
      handId: 'session-1:agent-saas-acs',
      sessionId: 'session-1',
      workspaceId: 'workspace-tenant',
      type: 'server-remote',
      status: 'provisioning',
      endpoint: 'http://tenant-hand.example',
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    }]);
    const runtime = new PlatformToolRuntime({ handStore });
    setTimeout(() => {
      void handStore.updateStatus('session-1:agent-saas-acs', 'ready');
    }, 20);

    const result = await runtime.invoke(
      {
        toolId: 'WaitForWorkspaceReady',
        input: { timeoutMs: 2_000 },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        channelContext: adminContext,
        sessionId: 'session-1',
        workspace: { ...workspace('/tmp/project'), id: 'workspace-tenant', sessionId: 'session-1' },
      },
    );

    const parsed = JSON.parse(result.content);
    expect(parsed).toMatchObject({
      status: 'ready',
      workspaceId: 'workspace-tenant',
    });
    expect(parsed).not.toHaveProperty('handId');
    expect(parsed).not.toHaveProperty('hands');
  });

  it('blocks workspace tool fallback while a tenant remote hand is still provisioning', async () => {
    const localInvoke = vi.fn(async () => successResponse('local result'));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-local', mockExecutionTransport(localInvoke)],
    ]);
    const handStore = new MemoryHandStore([{
      handId: 'session-1:agent-saas-acs',
      sessionId: 'session-1',
      workspaceId: 'workspace-tenant',
      type: 'server-remote',
      status: 'provisioning',
      endpoint: 'http://tenant-hand.example',
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    }]);
    const runtime = new PlatformToolRuntime({ executionTransportRegistry: registry, handStore });

    await expect(runtime.invoke(
      {
        toolId: 'Read',
        input: { path: 'assets/example.txt' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        channelContext: adminContext,
        sessionId: 'session-1',
        workspace: { ...workspace('/tmp/project'), id: 'workspace-tenant', sessionId: 'session-1', executionTarget: 'server-local' },
      },
    )).rejects.toThrow('Current workspace runtime is still preparing');
    expect(localInvoke).not.toHaveBeenCalled();
  });

  it('prefers the tenant remote default over the internal server-container fallback', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      status: 'success',
      content: 'remote listing',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);
    const containerInvoke = vi.fn(async () => successResponse('container result'));
    try {
      const registry = new DefaultExecutionTransportRegistry([
        ['server-container', mockExecutionTransport(containerInvoke)],
      ]);
      const handStore = new MemoryHandStore([
        {
          handId: 'session-1:agent-saas-acs',
          sessionId: 'session-1',
          workspaceId: 'workspace-tenant',
          type: 'server-remote',
          status: 'ready',
          endpoint: 'http://tenant-hand.example',
          capabilities: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          metadata: { tenantRemoteHandId: 'agent-saas-acs' },
        },
        {
          handId: 'workspace-tenant:server-container',
          sessionId: 'session-1',
          workspaceId: 'workspace-tenant',
          type: 'server-container',
          status: 'ready',
          capabilities: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          metadata: {},
        },
      ]);
      const runtime = new PlatformToolRuntime({
        executionTransportRegistry: registry,
        handStore,
        resolveHandAuthToken: () => 'tenant-token-123',
      });

      const result = await runtime.invoke(
        {
          toolId: 'List',
          input: { path: '.' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        {
          channelContext: adminContext,
          sessionId: 'session-1',
          workspace: { ...workspace('/tmp/project'), id: 'workspace-tenant', sessionId: 'session-1', executionTarget: 'server-container' },
        },
      );

      expect(result.content).toBe('remote listing');
      expect(containerInvoke).not.toHaveBeenCalled();
      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.input).toEqual({ path: '.', recursive: false });
      expect(body.context.handId).toBe('session-1:agent-saas-acs');
      expect(body.context.workspace.executionTarget).toBe('server-remote');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('does not route across session boundaries from a hidden handId input field', async () => {
    const localInvoke = vi.fn(async () => successResponse('local result'));
    const registry = new DefaultExecutionTransportRegistry([
      ['server-local', mockExecutionTransport(localInvoke)],
    ]);
    const handStore = new MemoryHandStore([{
      handId: 'session-2:tenant-ecs',
      sessionId: 'session-2',
      workspaceId: 'workspace-tenant',
      type: 'server-remote',
      status: 'ready',
      endpoint: 'http://tenant-hand.example',
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: { tenantRemoteHandId: 'tenant-ecs' },
    }]);
    const runtime = new PlatformToolRuntime({
      executionTransportRegistry: registry,
      handStore,
      resolveHandAuthToken: () => 'tenant-token-123',
    });

    const result = await runtime.invoke(
      {
        toolId: 'Read',
        input: { path: 'hello.txt', handId: 'session-2:tenant-ecs' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        channelContext: adminContext,
        sessionId: 'session-1',
        workspace: { ...workspace('/tmp/project'), id: 'workspace-tenant', sessionId: 'session-1', executionTarget: 'server-local' },
      },
    );

    expect(result.content).toBe('local result');
    expect(localInvoke).toHaveBeenCalledWith({
      toolName: 'Read',
      input: { path: 'hello.txt' },
      context: {
        workspace: expect.objectContaining({ id: 'workspace-tenant', executionTarget: 'server-local' }),
        signal: undefined,
      },
    });
  });

  it('rejects workspace write tools without explicit authorization', async () => {
    const invoke = vi.fn(async () => successResponse(''));
    const executionTransport = mockExecutionTransport(invoke);
    const runtime = new PlatformToolRuntime({ executionTransport });
    const unauthorizedCall = {
      toolId: 'Edit',
      input: { file_path: 'blocked.txt', old_string: 'a', new_string: 'b' },
    } as unknown as AuthorizedToolCall<{ file_path: string; old_string: string; new_string: string }>;

    await expect(runtime.invoke(
      unauthorizedCall,
      {
        channelContext: adminContext,
        workspace: workspace('/tmp/project'),
      },
    )).rejects.toThrow('requires prior authorization');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('blocks server-local reads and shell commands that reference raw runtime sandbox deny paths', async () => {
    const provider = new ServerLocalExecutionProvider();
    const protectedRoot = '/tmp/project/secret';
    const guardedWorkspace = {
      ...workspace('/tmp/project'),
      sandboxPolicy: { denyRead: [protectedRoot] },
    };

    await expect(provider.execute({
      toolName: 'Read',
      input: { path: 'secret/MEMORY.md' },
      context: { workspace: guardedWorkspace },
    })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('server-local sandbox denied path'),
    });

    await expect(provider.execute({
      toolName: 'Shell',
      input: { command: `cat ${protectedRoot}/MEMORY.md` },
      context: { workspace: guardedWorkspace },
    })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('server-local sandbox denied command'),
    });
  });

  // P5 升级（2026-06-22）：findDeniedPathMention 加路径变形 bypass 覆盖。
  // 历史只挡字面完整路径命中；本次扩展覆盖双斜杠 // 和单点 /./ 这两类
  // shell normalize 后等价但字面不同的 bypass。symlink / 动态构造（$VAR, $()）
  // 仍未挡（honest limitations，详见 findDeniedPathMention 注释）。
  describe('findDeniedPathMention path bypass variants (P5)', () => {
    const protectedRoot = '/tmp/project/secret';
    const guardedWorkspace = {
      ...workspace('/tmp/project'),
      sandboxPolicy: { denyRead: [protectedRoot] },
    };
    const provider = new ServerLocalExecutionProvider();

    async function expectDeniedRunShell(command: string): Promise<void> {
      await expect(provider.execute({
        toolName: 'Shell',
        input: { command },
        context: { workspace: guardedWorkspace },
      })).resolves.toMatchObject({
        status: 'error',
        error: expect.stringContaining('server-local sandbox denied command'),
      });
    }

    async function expectNotDeniedRunShell(command: string): Promise<void> {
      // 这里不验证执行成功（命令本身可能 exit non-zero），只验证 guard **没**拦下来。
      // 通过断言 error 不含 sandbox denied 字样区分 guard 拦截 vs 其他错误（如 ENOENT）。
      const result = await provider.execute({
        toolName: 'Shell',
        input: { command },
        context: { workspace: guardedWorkspace },
      });
      if (result.status === 'error') {
        expect(result.error).not.toContain('server-local sandbox denied');
      }
    }

    it('denies double-slash variant: cat /tmp//project//secret/MEMORY.md', async () => {
      await expectDeniedRunShell(`cat ${protectedRoot.replace(/\//g, '//')}/MEMORY.md`);
    });

    it('denies single-dot variant: cat /tmp/./project/./secret/MEMORY.md', async () => {
      const dotted = protectedRoot.split('/').filter(Boolean).map((s) => `./${s}`).join('/');
      await expectDeniedRunShell(`cat /${dotted}/MEMORY.md`);
    });

    it('denies trailing-slash variant: cat /tmp/project/secret/', async () => {
      await expectDeniedRunShell(`cat ${protectedRoot}/`);
    });

    it('denies literal full path (baseline regression)', async () => {
      await expectDeniedRunShell(`cat ${protectedRoot}/MEMORY.md`);
    });

    // ---- 以下为 honest limitations 文档化测试：标记当前 guard **挡不住**的 bypass，
    // ---- 让未来读代码者明确知道边界。如果未来加更深防御（shell-quote + realpath），
    // ---- 这些 case 应该改成 expectDenied，让回归被门禁拦下。

    it('LIMITATION: does NOT deny env-var path: cat $HOME/../project/secret/MEMORY.md (shell expansion bypass)', async () => {
      await expectNotDeniedRunShell('cat $HOME/../project/secret/MEMORY.md');
    });

    it('LIMITATION: does NOT deny indirect var-assignment: P=/tmp/project; cat $P/secret/MEMORY.md', async () => {
      // 注意：var 赋值如果字面写了完整 denied path（如 P=/tmp/project/secret），
      // 仍会被 baseline includes 命中（happy accident）。这条用"间接拼接"形式：
      // P 只到 /tmp/project，靠 $P/secret/... 拼出真实 denied path —— guard 看不见。
      await expectNotDeniedRunShell('P=/tmp/project; cat $P/secret/MEMORY.md');
    });

    it('LIMITATION: does NOT deny sub-shell path: cat $(echo /tmp/project)/secret/MEMORY.md', async () => {
      await expectNotDeniedRunShell('cat $(echo /tmp/project)/secret/MEMORY.md');
    });
  });

  it('replays hand-produced audit records back to the brain-side recorder', async () => {
    const invoke = vi.fn(async (): Promise<ToolInvocationResponse> => ({
      status: 'success',
      content: 'ok',
      audit: [{
        provider: 'server-container',
        operation: 'writeFile',
        status: 'success',
        stdoutBytes: 12,
        stderrBytes: 0,
      }],
    }));
    const executionTransport = mockExecutionTransport(invoke);
    const runtime = new PlatformToolRuntime({ executionTransport });
    const records: import('../agent/toolRuntime.js').ExecutionInvocationAudit[] = [];
    const recorder = { records, record(r: typeof records[number]) { records.push(r); } };

    await runtime.invoke(
      {
        toolId: 'Write',
        input: { path: 'a.txt', content: 'hi' },
        authorization: { approved: true, source: 'human_approval' },
      },
      {
        channelContext: adminContext,
        workspace: workspace('/tmp/project'),
        executionAudit: recorder,
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: 'server-container', operation: 'writeFile' });
  });

  it('notifies the memory index only for successful memory source changes', async () => {
    const invoke = vi.fn(async () => successResponse('ok'));
    const executionTransport = mockExecutionTransport(invoke);
    const memoryIndexService = {
      enqueueSync: vi.fn(),
      noteMaybeChanged: vi.fn(),
    } as unknown as MemoryIndexService;
    const runtime = new PlatformToolRuntime({ executionTransport, memoryIndexService });
    const ctx = {
      channelContext: adminContext,
      workspace: workspace('/tmp/project'),
    };

    await runtime.invoke(
      {
        toolId: 'Write',
        input: { path: 'MEMORY.md', content: 'hi' },
        authorization: { approved: true, source: 'human_approval' },
      },
      ctx,
    );
    await runtime.invoke(
      {
        toolId: 'Write',
        input: { path: 'docs/note.md', content: 'hi' },
        authorization: { approved: true, source: 'human_approval' },
      },
      ctx,
    );
    await runtime.invoke(
      {
        toolId: 'Edit',
        input: { file_path: 'memory/2026-06-29.md', old_string: 'a', new_string: 'b' },
        authorization: { approved: true, source: 'human_approval' },
      },
      ctx,
    );
    await runtime.invoke(
      {
        toolId: 'Shell',
        input: { command: 'printf hi > MEMORY.md' },
        authorization: { approved: true, source: 'human_approval' },
      },
      ctx,
    );

    expect(memoryIndexService.enqueueSync).toHaveBeenCalledTimes(2);
    expect(memoryIndexService.enqueueSync).toHaveBeenNthCalledWith(
      1,
      '/tmp/project',
      'tool:Write:MEMORY.md',
    );
    expect(memoryIndexService.enqueueSync).toHaveBeenNthCalledWith(
      2,
      '/tmp/project',
      'tool:Edit:memory/2026-06-29.md',
    );
    expect(memoryIndexService.noteMaybeChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps workspace identity separate from the OpenAI tool adapter', () => {
    const provider = new LocalWorkspaceProvider();
    const ref = provider.resolve(adminContext, {
      cwd: '/tmp/workspace',
      sessionId: 'session-abc',
      workspaceId: 'ws_pantheon__admin-1',
      sandboxScopeId: 'ws_pantheon__admin-1__workspaces_pantheon_admin-1',
      mountSubPath: 'workspaces/pantheon/admin-1',
    });

    expect(ref).toMatchObject({
      id: 'ws_pantheon__admin-1',
      root: '/tmp/workspace',
      userId: 'admin-1',
      username: 'admin',
      sessionId: 'session-abc',
      sandboxScopeId: 'ws_pantheon__admin-1__workspaces_pantheon_admin-1',
      mountSubPath: 'workspaces/pantheon/admin-1',
      executionTarget: 'server-local',
    });
  });
});

describe('applyToolDescriptionOverride', () => {
  it('returns descriptor untouched when no override configured', () => {
    const patched = applyToolDescriptionOverride(readFileToolDescriptor, undefined);
    expect(patched).toBe(readFileToolDescriptor);
    expect(patched.description).toBe(readFileToolDescriptor.description);
  });

  it('append mode preserves original description and concatenates normalized override text', () => {
    const patched = applyToolDescriptionOverride(readFileToolDescriptor, {
      tools: {
        Read: {
          descriptionOverride: {
            mode: 'append',
            // 多行输入应被 split/trim/filter/join 归一化成单行
            text: '本平台请优先读取\n    assets/YYYYMMDD/ 下的文件。\n\n路径中允许使用相对路径。',
          },
        },
      },
    });
    expect(patched).not.toBe(readFileToolDescriptor);
    expect(patched.description.startsWith(readFileToolDescriptor.description)).toBe(true);
    expect(patched.description).toContain('assets/YYYYMMDD/');
    expect(patched.description).not.toContain('\n');
    expect(patched.description).not.toContain('    '); // 缩进被 trim 掉
  });

  it('replace mode returns override text as the entire description', () => {
    const patched = applyToolDescriptionOverride(readFileToolDescriptor, {
      tools: {
        Read: { descriptionOverride: { mode: 'replace', text: '仅用于读取合同模板。' } },
      },
    });
    expect(patched.description).toBe('仅用于读取合同模板。');
    expect(patched.description).not.toContain(readFileToolDescriptor.description);
  });

  it('empty / whitespace-only override text is a no-op', () => {
    const patched = applyToolDescriptionOverride(readFileToolDescriptor, {
      tools: { Read: { descriptionOverride: { mode: 'append', text: '   \n  \n' } } },
    });
    expect(patched.description).toBe(readFileToolDescriptor.description);
  });

  it('falls back to descriptor.name key when tools lookup by id misses', () => {
    // 制造 id 与 name 不一致的场景：MCP 工具走 id=`mcp:xxx.tool`、name='tool'
    const descriptor = { ...readFileToolDescriptor, id: 'mcp:kb.read', name: 'Read' };
    const patched = applyToolDescriptionOverride(descriptor, {
      tools: { Read: { descriptionOverride: { mode: 'append', text: '仅限企业文档。' } } },
    });
    expect(patched.description.endsWith('仅限企业文档。')).toBe(true);
  });
});
