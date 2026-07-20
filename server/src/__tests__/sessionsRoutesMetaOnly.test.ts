import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionsRouter, type SessionsRouterOptions } from '../routes/sessions.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta, type SessionMeta } from '../data/transcripts/meta.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';

const TEST_USER = {
  id: 'user-1',
  username: 'alice',
  role: 'user',
  tenantId: 'kaiyan',
} satisfies WorkspaceUser;

type SessionListResponse = {
  sessions: Array<{
    sessionId: string;
    title?: string;
    preview?: string;
    updatedAtMs: number;
    orgAgentId?: string;
    orgAgentName?: string;
    orgAgentAvailable?: boolean;
  }>;
  hasMore: boolean;
};

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(
  agentCwd: string,
  options: {
    user?: WorkspaceUser;
    resolveContextAccounting?: (modelRef?: string) => {
      exact: boolean;
      kind: 'exact_current' | 'stateful_response_exact' | 'unknown';
      source: 'provider_usage' | 'unknown';
      label: string;
      reason?: string;
    };
    orgAgentStore?: OrgAgentStore;
    sessionProjectionStore?: SessionsRouterOptions['sessionProjectionStore'];
  } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = options.user ?? TEST_USER;
    req.user = {
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId ?? TEST_USER.tenantId,
    };
    next();
  });
  app.use('/api', createSessionsRouter({
    agentCwd,
    runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath)),
    resolveContextAccounting: options.resolveContextAccounting,
    orgAgentStore: options.orgAgentStore,
    sessionProjectionStore: options.sessionProjectionStore,
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('sessions routes for meta-only runtime sessions', () => {
  let agentCwd = '';
  const cleanupPaths = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'sessions-meta-only-'));
    cleanupPaths.add(agentCwd);
  });

  afterEach(async () => {
    for (const target of cleanupPaths) {
      await rm(target, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  function userCwd(): string {
    return resolveUserCwd(agentCwd, TEST_USER);
  }

  async function writeRuntimeSession(options: {
    sessionId?: string;
    userId?: string;
    username?: string;
    content?: string;
    createdAt?: string;
    metaPatch?: Partial<SessionMeta>;
    metaMtimeMs?: number;
  } = {}): Promise<{ sessionId: string; transcriptPath: string }> {
    const sessionId = options.sessionId ?? randomUUID();
    const createdAt = options.createdAt ?? new Date().toISOString();
    const transcriptPath = getTranscriptPath(userCwd(), sessionId, {
      tenantId: TEST_USER.tenantId,
      userId: TEST_USER.id,
    });
    cleanupPaths.add(dirname(transcriptPath));

    await writeSessionMeta(transcriptPath, {
      userId: options.userId ?? TEST_USER.id,
      username: options.username ?? TEST_USER.username,
      channel: 'web',
      createdAt,
      cwd: userCwd(),
      transcriptPath,
      runtimeStatus: 'running',
      updatedAt: createdAt,
      ...options.metaPatch,
    });
    if (options.metaMtimeMs !== undefined) {
      const date = new Date(options.metaMtimeMs);
      await utimes(transcriptPath.replace(/\.jsonl$/, '.meta.json'), date, date);
    }

    if (options.content) {
      const eventStore = new FileEventStore(getRuntimeEventLogPath(transcriptPath));
      await eventStore.append({
        type: 'user_message_submitted',
        sessionId,
        runId: `${Date.now()}-${randomUUID()}`,
        userId: options.userId ?? TEST_USER.id,
        clientMsgId: randomUUID(),
        content: options.content,
      });
    }

    return { sessionId, transcriptPath };
  }

  async function writeAssistantUsageTranscript(
    transcriptPath: string,
    sessionId: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    },
  ): Promise<void> {
    await appendFile(transcriptPath, JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        model: 'gpt-5.5',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
          cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
          api_request_count: 1,
        },
      },
    }) + '\n');
  }

  async function listSessions(baseUrl: string, query = ''): Promise<SessionListResponse> {
    const response = await fetch(`${baseUrl}/api/sessions${query}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<SessionListResponse>;
  }

  it('serves detail and stats before the legacy transcript is projected', async () => {
    const { sessionId } = await writeRuntimeSession({ content: 'hello before projection' });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const detail = await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1`);
      expect(detail.status).toBe(200);
      const detailJson = await detail.json() as { blocks: Array<{ kind: string; content: string }> };
      expect(detailJson.blocks).toEqual([
        expect.objectContaining({ kind: 'prompt', content: 'hello before projection' }),
      ]);

      const stats = await fetch(`${baseUrl}/api/sessions/${sessionId}/stats`);
      expect(stats.status).toBe(200);
      await expect(stats.json()).resolves.toMatchObject({ tokenUsage: null });
    } finally {
      await stopServer(server);
    }
  });

  it('returns orgAgentAvailable=false after a bound Agent is disabled', async () => {
    const orgAgentStore = new OrgAgentStore(join(agentCwd, 'data', 'org-agents.json'));
    const agent = await orgAgentStore.create({
      tenantId: TEST_USER.tenantId,
      name: '产品选型助手',
      instructions: '只回答选型问题',
      allowedSkills: ['wain-kb'],
      audience: { exposure: 'allow_users', usernames: [TEST_USER.username] },
      guardrail: {
        enabled: true,
        scopeDescription: '连接器产品选型',
        rejectionMessage: '超出职责范围',
        strictness: 'lenient',
      },
      enabled: true,
    }, 'admin');
    const { sessionId } = await writeRuntimeSession({
      content: '推荐一个连接器',
      metaPatch: { tenantId: TEST_USER.tenantId, orgAgentId: agent.id },
    });

    const { server, baseUrl } = await startServer(agentCwd, { orgAgentStore });
    try {
      const active = await listSessions(baseUrl, '?fresh=1');
      expect(active.sessions.find((item) => item.sessionId === sessionId)).toMatchObject({
        orgAgentId: agent.id,
        orgAgentName: '产品选型助手',
        orgAgentAvailable: true,
      });

      await orgAgentStore.update(agent.id, { enabled: false }, 'admin');
      const disabled = await listSessions(baseUrl, '?fresh=1');
      expect(disabled.sessions.find((item) => item.sessionId === sessionId)).toMatchObject({
        orgAgentId: agent.id,
        orgAgentName: '产品选型助手',
        orgAgentAvailable: false,
      });
    } finally {
      await stopServer(server);
    }
  });

  it('does not expose an org Agent name across tenant boundaries', async () => {
    const orgAgentStore = new OrgAgentStore(join(agentCwd, 'data', 'org-agents.json'));
    const externalAgent = await orgAgentStore.create({
      tenantId: 'other-tenant',
      name: '其他租户的内部专家',
      instructions: 'tenant secret',
      allowedSkills: [],
      audience: { exposure: 'all', usernames: [] },
      guardrail: {
        enabled: false,
        scopeDescription: '',
        rejectionMessage: '拒绝',
        strictness: 'strict',
      },
      enabled: true,
    }, 'admin');
    const { sessionId } = await writeRuntimeSession({
      content: '历史会话',
      metaPatch: { tenantId: TEST_USER.tenantId, orgAgentId: externalAgent.id },
    });

    const { server, baseUrl } = await startServer(agentCwd, { orgAgentStore });
    try {
      const listed = await listSessions(baseUrl, '?fresh=1');
      expect(listed.sessions.find((item) => item.sessionId === sessionId)).toEqual(expect.objectContaining({
        orgAgentId: externalAgent.id,
        orgAgentAvailable: false,
      }));
      expect(listed.sessions.find((item) => item.sessionId === sessionId)?.orgAgentName).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });

  it('creates distinct meta-only sessions bound to the requested available org Agent', async () => {
    const orgAgentStore = new OrgAgentStore(join(agentCwd, 'data', 'org-agents.json'));
    const agent = await orgAgentStore.create({
      tenantId: TEST_USER.tenantId,
      name: '产品选型助手',
      instructions: '只回答选型问题',
      allowedSkills: ['wain-kb'],
      audience: { exposure: 'allow_users', usernames: [TEST_USER.username] },
      guardrail: {
        enabled: true,
        scopeDescription: '连接器产品选型',
        rejectionMessage: '超出职责范围',
        strictness: 'lenient',
      },
      enabled: true,
    }, 'admin');

    const { server, baseUrl } = await startServer(agentCwd, { orgAgentStore });
    try {
      const create = () => fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgAgentId: agent.id }),
      });
      const first = await create();
      const second = await create();
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody = await first.json() as { session: SessionListResponse['sessions'][number] };
      const secondBody = await second.json() as { session: SessionListResponse['sessions'][number] };
      cleanupPaths.add(dirname(getTranscriptPath(userCwd(), firstBody.session.sessionId, {
        tenantId: TEST_USER.tenantId,
        userId: TEST_USER.id,
      })));
      expect(firstBody.session.sessionId).not.toBe(secondBody.session.sessionId);
      expect(firstBody.session).toMatchObject({
        title: '新会话',
        orgAgentId: agent.id,
        orgAgentName: '产品选型助手',
        orgAgentAvailable: true,
      });

      const listed = await listSessions(baseUrl, '?fresh=1');
      const createdIds = new Set([firstBody.session.sessionId, secondBody.session.sessionId]);
      expect(listed.sessions.filter((item) => createdIds.has(item.sessionId))).toHaveLength(2);
    } finally {
      await stopServer(server);
    }
  });

  it('rejects creating a session for a disabled or unassigned org Agent', async () => {
    const orgAgentStore = new OrgAgentStore(join(agentCwd, 'data', 'org-agents.json'));
    const unassigned = await orgAgentStore.create({
      tenantId: TEST_USER.tenantId,
      name: '未授权助手',
      instructions: 'restricted',
      allowedSkills: [],
      audience: { exposure: 'allow_users', usernames: ['bob'] },
      guardrail: {
        enabled: false,
        scopeDescription: '',
        rejectionMessage: '拒绝',
        strictness: 'strict',
      },
      enabled: true,
    }, 'admin');
    const disabled = await orgAgentStore.create({
      tenantId: TEST_USER.tenantId,
      name: '停用助手',
      instructions: 'disabled',
      allowedSkills: [],
      audience: { exposure: 'all', usernames: [] },
      guardrail: {
        enabled: false,
        scopeDescription: '',
        rejectionMessage: '拒绝',
        strictness: 'strict',
      },
      enabled: false,
    }, 'admin');

    const { server, baseUrl } = await startServer(agentCwd, { orgAgentStore });
    try {
      for (const orgAgentId of [unassigned.id, disabled.id]) {
        const response = await fetch(`${baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgAgentId }),
        });
        expect(response.status).toBe(403);
      }
      const listed = await listSessions(baseUrl, '?fresh=1');
      expect(listed.sessions.some((item) =>
        item.orgAgentId === unassigned.id || item.orgAgentId === disabled.id,
      )).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('marks transcript context as exact for full-history models', async () => {
    const { sessionId, transcriptPath } = await writeRuntimeSession({
      metaPatch: { model: 'kaiyan-llm/gpt55-high' },
    });
    await writeAssistantUsageTranscript(transcriptPath, sessionId, {
      inputTokens: 90000,
      outputTokens: 1000,
      cacheReadInputTokens: 80000,
    });
    await writeAssistantUsageTranscript(transcriptPath, sessionId, {
      inputTokens: 12000,
      outputTokens: 300,
      cacheReadInputTokens: 10752,
    });

    const { server, baseUrl } = await startServer(agentCwd, {
      resolveContextAccounting: () => ({
        exact: true,
        kind: 'exact_current',
        source: 'provider_usage',
        label: '当前上下文',
      }),
    });
    try {
      const stats = await fetch(`${baseUrl}/api/sessions/${sessionId}/stats`);
      expect(stats.status).toBe(200);
      await expect(stats.json()).resolves.toMatchObject({
        tokenUsage: {
          contextTokens: 12300,
          totalTokens: 103300,
          contextAccounting: {
            exact: true,
            kind: 'exact_current',
            source: 'provider_usage',
            lastRequestTokens: 12300,
          },
        },
      });
    } finally {
      await stopServer(server);
    }
  });

  it('marks transcript context as exact for stateful Responses chaining (usage is cumulative per turn)', async () => {
    const { sessionId, transcriptPath } = await writeRuntimeSession({
      metaPatch: { model: 'ark-agents/glm-5.2' },
    });
    await writeAssistantUsageTranscript(transcriptPath, sessionId, {
      inputTokens: 4397,
      outputTokens: 38,
      cacheReadInputTokens: 4288,
    });

    const { server, baseUrl } = await startServer(agentCwd, {
      resolveContextAccounting: () => ({
        exact: true,
        kind: 'stateful_response_exact',
        source: 'provider_usage',
        label: '当前上下文',
        reason: 'stateful chaining reports cumulative input per turn',
      }),
    });
    try {
      const stats = await fetch(`${baseUrl}/api/sessions/${sessionId}/stats`);
      expect(stats.status).toBe(200);
      await expect(stats.json()).resolves.toMatchObject({
        tokenUsage: {
          contextTokens: 4435,
          totalTokens: 4435,
          contextAccounting: {
            exact: true,
            kind: 'stateful_response_exact',
            source: 'provider_usage',
            label: '当前上下文',
            reason: 'stateful chaining reports cumulative input per turn',
            lastRequestTokens: 4435,
          },
        },
      });
    } finally {
      await stopServer(server);
    }
  });

  it('adds durable child-session usage to stats without inflating parent context', async () => {
    const { sessionId, transcriptPath } = await writeRuntimeSession({
      metaPatch: { model: 'kaiyan-llm/gpt55-high' },
    });
    await writeAssistantUsageTranscript(transcriptPath, sessionId, {
      inputTokens: 100,
      outputTokens: 20,
    });

    const childSessionId = `sub-${randomUUID()}`;
    const childRunId = `${Date.now()}-${randomUUID()}`;
    const { transcriptPath: childTranscriptPath } = await writeRuntimeSession({
      sessionId: childSessionId,
      metaPatch: { model: 'kaiyan-llm/gpt55-high' },
    });
    await writeFile(childTranscriptPath, '');

    const parentEvents = new FileEventStore(getRuntimeEventLogPath(transcriptPath));
    await parentEvents.append({
      type: 'subagent_finished',
      runId: `${Date.now()}-${randomUUID()}`,
      sessionId,
      toolCallId: 'tool-agent-1',
      agentType: 'general',
      description: '核对数据',
      childSessionId,
      childRunId,
      model: 'gpt-5.5',
      status: 'completed',
      totalTokens: 2500,
      toolUseCount: 1,
      turnCount: 2,
      durationMs: 1000,
    });

    const childEvents = new FileEventStore(getRuntimeEventLogPath(childTranscriptPath));
    await childEvents.append({
      type: 'assistant_tool_calls',
      runId: childRunId,
      sessionId: childSessionId,
      content: '',
      model: 'gpt-5.5',
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 0,
        apiRequestCount: 1,
      },
      toolCalls: [{ id: 'tool-1', name: 'Read', arguments: '{}' }],
    });
    await childEvents.append({
      type: 'assistant_message',
      runId: childRunId,
      sessionId: childSessionId,
      content: 'done',
      model: 'gpt-5.5',
      usage: {
        inputTokens: 1200,
        outputTokens: 200,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 0,
        apiRequestCount: 1,
      },
    });

    const { server, baseUrl } = await startServer(agentCwd, {
      resolveContextAccounting: () => ({
        exact: true,
        kind: 'exact_current',
        source: 'provider_usage',
        label: '当前上下文',
      }),
    });
    try {
      const stats = await fetch(`${baseUrl}/api/sessions/${sessionId}/stats`);
      expect(stats.status).toBe(200);
      await expect(stats.json()).resolves.toMatchObject({
        tokenUsage: {
          contextTokens: 120,
          subagentTotalTokens: 2500,
          totalTokens: 2620,
          subagentUsage: {
            childCount: 1,
            requestCount: 2,
            inputTokens: 2200,
            uncachedInputTokens: 800,
            cacheReadTokens: 1400,
            cacheCreationTokens: 0,
            outputTokens: 300,
            totalTokens: 2500,
            cacheHitDenominatorTokens: 2200,
            cacheHitRatio: 1400 / 2200,
          },
          contextAccounting: {
            exact: true,
            lastRequestTokens: 120,
          },
        },
      });
    } finally {
      await stopServer(server);
    }
  });

  it('lists meta-only sessions before the transcript is projected', async () => {
    const { sessionId } = await writeRuntimeSession({ content: '调用浏览器skill，打开google' });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      const listed = json.sessions.find((session) => session.sessionId === sessionId);
      expect(listed).toBeTruthy();
      expect(listed?.title).toContain('调用浏览器skill');
      expect(listed?.preview).toBe('调用浏览器skill，打开google');
    } finally {
      await stopServer(server);
    }
  });

  it('hides meta-only sessions owned by another user', async () => {
    const { sessionId } = await writeRuntimeSession({
      userId: 'user-2',
      username: 'bob',
      content: 'should not be visible',
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      expect(json.sessions.some((session) => session.sessionId === sessionId)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('hides deleted meta-only sessions', async () => {
    const { sessionId } = await writeRuntimeSession({
      content: 'deleted session',
      metaPatch: { deletedAt: new Date().toISOString(), deletedBy: TEST_USER.id },
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      expect(json.sessions.some((session) => session.sessionId === sessionId)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('blocks normal detail reads for deleted sessions but allows explicit trash preview', async () => {
    const { sessionId } = await writeRuntimeSession({
      content: 'deleted detail session',
      metaPatch: { deletedAt: new Date().toISOString(), deletedBy: TEST_USER.id },
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const normalDetail = await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1`);
      expect(normalDetail.status).toBe(404);

      const trashPreview = await fetch(`${baseUrl}/api/sessions/${sessionId}?includeDeleted=1`);
      expect(trashPreview.status).toBe(200);
      const json = await trashPreview.json() as { blocks: Array<{ kind: string; content: string }> };
      expect(json.blocks).toEqual([
        expect.objectContaining({ kind: 'prompt', content: 'deleted detail session' }),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it('hides memory and heartbeat polling meta-only sessions for non-admin users', async () => {
    const memory = await writeRuntimeSession({
      content: 'memory poll',
      metaPatch: { channel: 'cron', cronJobName: '每日记忆轮询' },
    });
    const heartbeat = await writeRuntimeSession({
      content: 'heartbeat poll',
      metaPatch: { channel: 'cron', cronJobName: '服务心跳轮询' },
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      expect(json.sessions.some((session) => session.sessionId === memory.sessionId)).toBe(false);
      expect(json.sessions.some((session) => session.sessionId === heartbeat.sessionId)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('hides memory and heartbeat polling meta-only sessions for organization admins', async () => {
    const memory = await writeRuntimeSession({
      content: 'memory poll',
      metaPatch: { channel: 'cron', cronSystemKind: 'memory_poll', cronJobName: '每日记忆轮询' },
    });
    const heartbeat = await writeRuntimeSession({
      content: 'heartbeat poll',
      metaPatch: { channel: 'cron', cronJobName: '服务心跳轮询' },
    });

    const { server, baseUrl } = await startServer(agentCwd, {
      user: { ...TEST_USER, role: 'admin' },
    });
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      expect(json.sessions.some((session) => session.sessionId === memory.sessionId)).toBe(false);
      expect(json.sessions.some((session) => session.sessionId === heartbeat.sessionId)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('hides subagent hidden sessions from the list (kind=subagent)', async () => {
    const visible = await writeRuntimeSession({ content: 'normal session' });
    const hidden = await writeRuntimeSession({
      content: 'subagent hidden session',
      metaPatch: { kind: 'subagent' },
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      expect(json.sessions.some((session) => session.sessionId === visible.sessionId)).toBe(true);
      expect(json.sessions.some((session) => session.sessionId === hidden.sessionId)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('de-duplicates sessions that have both transcript and meta files', async () => {
    const { sessionId, transcriptPath } = await writeRuntimeSession({ content: 'metadata prompt' });
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, JSON.stringify({ type: 'user', message: { content: 'transcript prompt' } }) + '\n');

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      const matches = json.sessions.filter((session) => session.sessionId === sessionId);
      expect(matches).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('sorts and paginates merged meta-only sessions', async () => {
    const older = await writeRuntimeSession({
      content: 'older prompt',
      metaMtimeMs: Date.now() - 10_000,
    });
    const newer = await writeRuntimeSession({
      content: 'newer prompt',
      metaMtimeMs: Date.now(),
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const firstPage = await listSessions(baseUrl, '?fresh=1&limit=1');
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.sessions).toHaveLength(1);
      expect(firstPage.sessions[0]?.sessionId).toBe(newer.sessionId);

      const secondPage = await listSessions(baseUrl, `?fresh=1&limit=1&before=${firstPage.sessions[0]!.updatedAtMs}`);
      expect(secondPage.sessions[0]?.sessionId).toBe(older.sessionId);
    } finally {
      await stopServer(server);
    }
  });

  it('uses the runtime session projection instead of scanning every transcript', async () => {
    const sessionId = randomUUID();
    const updatedAt = '2026-07-21T00:30:00.000Z';
    const list = vi.fn(async () => ({
      items: [{
        sessionId,
        tenantId: TEST_USER.tenantId,
        userId: TEST_USER.id,
        username: TEST_USER.username,
        channel: 'web',
        kind: 'user' as const,
        title: '投影会话',
        createdAt: updatedAt,
        updatedAt,
        metaJson: {
          userId: TEST_USER.id,
          username: TEST_USER.username,
          tenantId: TEST_USER.tenantId,
          channel: 'web',
          createdAt: updatedAt,
          updatedAt,
          customTitle: '投影会话',
        },
      }],
    }));

    const { server, baseUrl } = await startServer(agentCwd, {
      sessionProjectionStore: { list },
    });
    try {
      const response = await listSessions(baseUrl, '?fresh=1&limit=50');
      expect(response.sessions).toEqual([
        expect.objectContaining({ sessionId, title: '投影会话' }),
      ]);
      expect(list).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TEST_USER.tenantId,
        userId: TEST_USER.id,
        kind: 'user',
        includeDeleted: false,
      }));
    } finally {
      await stopServer(server);
    }
  });
});
