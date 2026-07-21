import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type {
  EventStore,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  PlatformEvent,
  PlatformEventInput,
  RunContext,
} from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

class MemoryEventStore implements EventStore {
  readonly events: PlatformEvent[] = [];

  async append(event: PlatformEventInput): Promise<PlatformEvent> {
    const stored = {
      ...event,
      id: `event-${this.events.length + 1}`,
      timestamp: new Date(1_752_000_000_000 + this.events.length).toISOString(),
    } as PlatformEvent;
    this.events.push(stored);
    return stored;
  }

  async list(sessionId: string, options?: { excludeTypes?: PlatformEvent['type'][] }): Promise<PlatformEvent[]> {
    const excluded = new Set(options?.excludeTypes ?? []);
    return this.events.filter((event) => event.sessionId === sessionId && !excluded.has(event.type));
  }
}

const githubTool: ToolDescriptor = {
  id: 'mcp__github__get_issue',
  name: 'mcp__github__get_issue',
  displayName: 'GitHub / get_issue',
  description: '读取指定仓库的 issue',
  schema: z.object({}).passthrough(),
  parametersJsonSchema: {
    type: 'object',
    required: ['number'],
    properties: { number: { type: 'integer', description: 'Issue 编号' } },
  },
  risk: 'workspace_write',
  approvalMode: 'web',
  auditCategory: 'mcp.github.get_issue',
  mcp: {
    serverName: 'github',
    serverDisplayName: 'GitHub',
    serverDescription: '仓库、代码搜索、Issue、Pull Request 与 Commit',
  },
};

const notionTool: ToolDescriptor = {
  ...githubTool,
  id: 'mcp__notion__get_page',
  name: 'mcp__notion__get_page',
  displayName: 'Notion / get_page',
  description: '读取 Notion 页面',
  auditCategory: 'mcp.notion.get_page',
  mcp: {
    serverName: 'notion',
    serverDisplayName: 'Notion',
    serverDescription: '页面、数据库、内容搜索与编辑',
  },
};

class ControlledMcpRuntime implements ToolRuntime {
  readonly invoke = vi.fn(async (_call: AuthorizedToolCall, _context: ToolCallContext): Promise<ToolResult> => ({
    content: '{"number":42,"title":"Progressive MCP"}',
  }));

  list(): ToolDescriptor[] {
    return [githubTool, notionTool];
  }
}

class SearchThenCallAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield {
      type: 'completed',
      content: '',
      toolCalls: [{
        id: 'call_issue_42',
        namespace: 'mcp_github',
        name: githubTool.name,
        arguments: '{"number":42}',
      }],
      toolSearchResults: [{
        execution: 'server',
        paths: ['mcp_github.mcp__github__get_issue'],
        loadedToolNames: [githubTool.name],
      }],
    };
  }
}

class FinalAnswerAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: 'text_delta', content: '已读取 42 号 issue。' };
    yield {
      type: 'completed',
      content: '已读取 42 号 issue。',
      toolCalls: [],
      usage: { inputTokens: 30, outputTokens: 8, cacheReadInputTokens: 16, cacheCreationInputTokens: 0 },
    };
  }
}

class BoundaryAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private turn = 0;

  constructor(private readonly first: Extract<ModelEvent, { type: 'completed' }>) {}

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.turn++ === 0) {
      yield this.first;
      return;
    }
    yield { type: 'completed', content: '已安全拒绝未加载的工具调用。', toolCalls: [] };
  }
}

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function context(runId: string): RunContext {
  return {
    runId,
    sessionId: 'session-mcp-deferred',
    model: 'gpt-5.4',
    cwd: '/tmp',
    channelContext: {
      channel: 'web',
      user: { id: 'user-1', username: 'tester', role: 'user', tenantId: 'tenant-1' },
    },
  };
}

describe('RawAgentLoop MCP deferred 真实工具身份与审批恢复', () => {
  it('Search 只加载命中的 Server 工具，审批恢复后仍直接调用真实 mcp__server__tool', async () => {
    const eventStore = new MemoryEventStore();
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-mcp-deferred');
    const runtime = new ControlledMcpRuntime();
    const searchAdapter = new SearchThenCallAdapter();
    const firstLoop = new RawAgentLoop({
      modelAdapter: searchAdapter,
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection('/dev/null'),
      toolRuntime: runtime,
      mcpLoadingMode: 'openai_responses_hosted',
    });

    const firstEvents = await collect(firstLoop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '读取 GitHub 42 号 issue' },
      prompt: '读取 GitHub 42 号 issue',
      instructions: '只在任务需要连接器真实数据时搜索 MCP。',
      maxTurns: 3,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, context('run-search')));

    expect(firstEvents.at(-1)?.type).not.toBe('done');
    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(searchAdapter.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: githubTool.name, deferLoading: true }),
      expect.objectContaining({ name: notionTool.name, deferLoading: true }),
    ]);
    expect(eventStore.events.filter((event) => event.type === 'mcp_tool_catalog_snapshot')).toHaveLength(1);
    const loadedEvents = eventStore.events.filter((event) => event.type === 'mcp_tools_loaded');
    expect(loadedEvents).toHaveLength(1);
    expect(loadedEvents[0]).toMatchObject({
      paths: ['mcp_github.mcp__github__get_issue'],
      tools: [expect.objectContaining({ name: githubTool.name })],
    });
    expect(JSON.stringify(loadedEvents)).not.toContain(notionTool.name);

    const approvals = await approvalStore.list('session-mcp-deferred');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      status: 'pending',
      toolName: githubTool.name,
    });

    const finalAdapter = new FinalAnswerAdapter();
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection('/dev/null'),
      toolRuntime: runtime,
      mcpLoadingMode: 'openai_responses_hosted',
    });
    const resumed = await collect(rebuiltLoop.resumeApproval({
      approvalId: approvals[0]!.id,
      response: { allow: true, message: '测试环境批准只读调用' },
      instructions: '只在任务需要连接器真实数据时搜索 MCP。',
      maxTurns: 3,
    }, context('run-resume')));

    expect(runtime.invoke).toHaveBeenCalledOnce();
    expect(runtime.invoke.mock.calls[0]?.[0]).toMatchObject({
      toolId: githubTool.id,
      input: { number: 42 },
    });
    expect(resumed.at(-1)).toEqual({ type: 'done' });
    expect(finalAdapter.requests).toHaveLength(1);
    expect(finalAdapter.requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'additional_tools',
        tools: [expect.objectContaining({ name: githubTool.name })],
      }),
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [expect.objectContaining({
          namespace: 'mcp_github',
          function: expect.objectContaining({ name: githubTool.name }),
        })],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call_issue_42',
      }),
    ]));
    expect(eventStore.events.filter((event) => event.type === 'mcp_tools_loaded')).toHaveLength(1);
  });

  it('即使 provider 绕过 Search 直接生成真实工具名，runtime 也拒绝执行', async () => {
    const eventStore = new MemoryEventStore();
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-mcp-deferred');
    const runtime = new ControlledMcpRuntime();
    const adapter = new BoundaryAdapter({
      type: 'completed',
      content: '',
      toolCalls: [{
        id: 'call_without_search',
        namespace: 'mcp_github',
        name: githubTool.name,
        arguments: '{"number":42}',
      }],
    });
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection('/dev/null'),
      toolRuntime: runtime,
      mcpLoadingMode: 'openai_responses_hosted',
    });

    const events = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '绕过搜索调用 GitHub' },
      prompt: '绕过搜索调用 GitHub',
      instructions: 'MCP 工具必须先搜索加载。',
      maxTurns: 3,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, context('run-bypass')));

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(await approvalStore.list('session-mcp-deferred')).toHaveLength(0);
    expect(eventStore.events.find((event) => event.type === 'tool_result')).toMatchObject({
      toolCallId: 'call_without_search',
      isError: true,
      content: expect.stringContaining('MCP tool unavailable'),
    });
  });

  it('Search 已加载工具但 function_call namespace 不匹配时拒绝执行', async () => {
    const eventStore = new MemoryEventStore();
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-mcp-deferred');
    const runtime = new ControlledMcpRuntime();
    const adapter = new BoundaryAdapter({
      type: 'completed',
      content: '',
      toolCalls: [{
        id: 'call_wrong_namespace',
        namespace: 'mcp_notion',
        name: githubTool.name,
        arguments: '{"number":42}',
      }],
      toolSearchResults: [{
        execution: 'server',
        paths: ['mcp_github'],
        loadedToolNames: [githubTool.name],
      }],
    });
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection('/dev/null'),
      toolRuntime: runtime,
      mcpLoadingMode: 'openai_responses_hosted',
    });

    const events = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '读取 GitHub 42 号 issue' },
      prompt: '读取 GitHub 42 号 issue',
      instructions: 'MCP 工具必须保持 Server 身份一致。',
      maxTurns: 3,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, context('run-wrong-namespace')));

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(await approvalStore.list('session-mcp-deferred')).toHaveLength(0);
    expect(eventStore.events.find((event) => event.type === 'tool_result')).toMatchObject({
      toolCallId: 'call_wrong_namespace',
      isError: true,
      content: expect.stringContaining('MCP namespace mismatch'),
    });
  });
});
