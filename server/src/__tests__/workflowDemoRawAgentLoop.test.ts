import { describe, expect, it } from 'vitest';

import {
  demoManifestRecordSchema,
  type DemoManifestRecord,
} from '../../../shared/src/index.js';
import {
  PlatformToolRuntime,
} from '../agent/toolRuntime.js';
import {
  WorkflowDemoToolProvider,
  type WorkflowDemoStepInput,
} from '../agent/workflowDemoToolProvider.js';
import { initializeWorkflowDemo } from '../data/workflowDemos/engine.js';
import { InMemoryWorkflowDemoStore } from '../data/workflowDemos/store.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { canonicalToolInputDigest } from '../runtime/canonicalToolInput.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import {
  InMemoryToolInvocationStore,
  type StartToolInvocationInput,
  type ToolInvocationStatus,
} from '../runtime/toolInvocationStore.js';
import type {
  EventAppendContext,
  EventListOptions,
  EventStore,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  PlatformEvent,
  PlatformEventInput,
  RunContext,
} from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

const SESSION_ID = 'workflow-demo-session';
const AGENT_RUN_ID = 'workflow-demo-agent-run';
const TENANT_ID = 'tenant-workflow-demo';
const USER_ID = 'user-workflow-demo';

function createManifest(): DemoManifestRecord {
  return demoManifestRecordSchema.parse({
    id: 'raw-agent-loop-create-demo',
    workflowId: 'raw-agent-loop-create-workflow',
    catalogScenarioId: 'raw-agent-loop-create-catalog',
    definitionVersion: 1,
    primaryType: 'CREATE',
    environment: { kind: 'isolated_stateful', dataLabel: 'synthetic' },
    status: 'planned',
    publication: { status: 'private' },
    public: {
      title: '真实 Agent 成果创建演示',
      environmentLabel: '隔离演示系统·合成数据',
      before: [{ id: 'artifact-one', label: '演示成果对象', state: '待生成' }],
      timeline: [
        { id: 'trigger', label: '接收任务', summary: '读取已持久化的演示任务', state: '任务已接收' },
        { id: 'create-artifact', label: '创建成果', summary: '写入成果对象并重新读取', state: '成果已生成并回读' },
        { id: 'verify', label: '核验终态', summary: '按业务对象终态完成独立回读', state: '成果已生成并回读' },
      ],
      after: [{ id: 'artifact-one', label: '演示成果对象', state: '成果已生成并回读' }],
      evidence: [
        { id: 'agent-run', kind: 'agent_run', label: 'Agent 运行', summary: '步骤来自真实模型工具调用' },
        { id: 'artifact', kind: 'artifact', label: '成果对象', summary: '成果已写入隔离演示系统' },
        { id: 'readback', kind: 'readback', label: '终态回读', summary: '动作后重新读取并核对状态' },
      ],
    },
    internal: {
      tenantRef: 'internal-test-tenant',
      accountRef: 'internal-test-account',
      runIds: [],
      businessObjectRefs: [],
      idempotencyKeyHashes: [],
      beforeSnapshotRefs: [],
      timelineEventRefs: [],
      afterSnapshotRefs: [],
      evidenceRefs: [],
      executionPlan: [
        {
          eventId: 'trigger',
          phase: 'trigger',
          actorRole: 'demo-workflow-agent',
          targetObjectId: 'artifact-one',
          expectedState: '任务已接收',
          mutation: false,
          approvalRequired: false,
        },
        {
          eventId: 'create-artifact',
          phase: 'act',
          actorRole: 'demo-workflow-agent',
          targetObjectId: 'artifact-one',
          expectedState: '成果已生成并回读',
          mutation: true,
          approvalRequired: false,
          workflowActionId: 'create-artifact-action',
          permissionRef: 'permission-create-artifact',
          receiptSchemaRef: 'receipt:create-artifact:v1',
          workflowIdempotencyPolicyRef: 'idempotency-policy-create-artifact',
          operationRef: 'operation:create-artifact',
          idempotencyRef: 'idempotency:create-artifact',
        },
        {
          eventId: 'verify',
          phase: 'verify',
          actorRole: 'independent-readback',
          targetObjectId: 'artifact-one',
          expectedState: '成果已生成并回读',
          mutation: false,
          approvalRequired: false,
        },
      ],
      reviewedBy: [],
    },
  });
}

class MemoryEventStore implements EventStore {
  readonly events: PlatformEvent[] = [];

  async append(event: PlatformEventInput, _context?: EventAppendContext): Promise<PlatformEvent> {
    const stored = {
      ...event,
      id: `runtime-event-${this.events.length + 1}`,
      timestamp: new Date().toISOString(),
    } as PlatformEvent;
    this.events.push(stored);
    return stored;
  }

  async appendBatch(events: PlatformEventInput[], context?: EventAppendContext): Promise<PlatformEvent[]> {
    return Promise.all(events.map((event) => this.append(event, context)));
  }

  async list(sessionId: string, options: EventListOptions = {}): Promise<PlatformEvent[]> {
    const excluded = new Set(options.excludeTypes ?? []);
    return this.events.filter((event) => (
      (!('sessionId' in event) || event.sessionId === sessionId) && !excluded.has(event.type)
    ));
  }
}

class TrackingToolInvocationStore extends InMemoryToolInvocationStore {
  readonly transitions: Array<{ invocationId: string; status: ToolInvocationStatus }> = [];

  override async start(input: StartToolInvocationInput) {
    const record = await super.start(input);
    this.transitions.push({ invocationId: record.invocationId, status: record.status });
    return record;
  }

  override async complete(
    invocationId: string,
    status: Exclude<ToolInvocationStatus, 'running'>,
    error?: string,
  ) {
    const record = await super.complete(invocationId, status, error);
    if (record) this.transitions.push({ invocationId, status: record.status });
    return record;
  }
}

class WorkflowDemoModelAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private turn = 0;

  constructor(private readonly workflowRunId: string) {}

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.turn += 1;
    if (this.turn === 1) {
      yield completedToolCall('call-trigger', {
        workflowRunId: this.workflowRunId,
        eventId: 'trigger',
      });
      return;
    }
    if (this.turn === 2) {
      yield completedToolCall('call-create-artifact', {
        workflowRunId: this.workflowRunId,
        eventId: 'create-artifact',
        expectedVersion: 1,
      });
      return;
    }
    if (this.turn === 3) {
      yield completedToolCall('call-verify', {
        workflowRunId: this.workflowRunId,
        eventId: 'verify',
      });
      return;
    }
    yield { type: 'text_delta', content: '成果已创建并完成回读。' };
    yield {
      type: 'completed',
      content: '成果已创建并完成回读。',
      toolCalls: [],
      usage: { inputTokens: 4, outputTokens: 2 },
    };
  }
}

function completedToolCall(toolCallId: string, input: WorkflowDemoStepInput): ModelEvent {
  return {
    type: 'completed',
    content: '',
    toolCalls: [{
      id: toolCallId,
      name: 'WorkflowDemoStep',
      arguments: JSON.stringify(input),
    }],
    usage: { inputTokens: 8, outputTokens: 3 },
  };
}

async function collect(events: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const values: OutboundEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

describe('Workflow Demo 真实 RawAgentLoop 来源链', () => {
  it('模型工具调用经 Runtime/Provider 写入带一致 provenance 的 mutation/event 并回读终态', async () => {
    const manifest = createManifest();
    const workflowDemoStore = new InMemoryWorkflowDemoStore();
    const initialized = await initializeWorkflowDemo(workflowDemoStore, {
      manifest,
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      idempotencyKey: 'raw-agent-loop-e2e-idempotency',
    });
    const toolInvocationStore = new TrackingToolInvocationStore();
    const provider = new WorkflowDemoToolProvider({
      workflowDemoStore,
      toolInvocationStore,
      resolveManifest: async (demoId) => {
        if (demoId !== manifest.id) throw new Error(`测试 manifest 不存在: ${demoId}`);
        return manifest;
      },
      dispatch: { runId: initialized.run.runId, eventId: manifest.internal.executionPlan![0]!.eventId },
    });
    const runtimeEvents = new MemoryEventStore();
    const adapter = new WorkflowDemoModelAdapter(initialized.run.runId);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore: runtimeEvents,
      approvalStore: new EventBackedApprovalStore(runtimeEvents, SESSION_ID),
      transcriptProjection: new LegacyTranscriptProjection('/dev/null'),
      toolRuntime: new PlatformToolRuntime({ providers: [provider] }),
      toolInvocationStore,
    });

    const outbound = await collect(loop.run(
      {
        message: { channel: 'web', chatId: SESSION_ID, content: '执行成果创建演示' },
        prompt: '执行成果创建演示',
        instructions: '按平台给出的事件顺序调用 WorkflowDemoStep，并在终态后简短回复。',
        maxTurns: 5,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: AGENT_RUN_ID,
        sessionId: SESSION_ID,
        model: 'test-workflow-model',
        cwd: '/tmp/workflow-demo-raw-agent-loop',
        tenantId: TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: USER_ID, username: 'workflow_user', role: 'user', tenantId: TENANT_ID },
        },
      },
    ));

    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(adapter.requests).toHaveLength(4);
    expect(adapter.requests.every((request) => request.tools.some((tool) => tool.id === 'WorkflowDemoStep'))).toBe(true);

    const invocationIds = [
      `${AGENT_RUN_ID}:call-trigger`,
      `${AGENT_RUN_ID}:call-create-artifact`,
      `${AGENT_RUN_ID}:call-verify`,
    ];
    expect(toolInvocationStore.transitions).toEqual(invocationIds.flatMap((invocationId) => [
      { invocationId, status: 'running' },
      { invocationId, status: 'completed' },
    ]));
    for (const invocationId of invocationIds) {
      expect((await toolInvocationStore.get(invocationId))?.status).toBe('completed');
    }

    const mutationInput: WorkflowDemoStepInput = {
      workflowRunId: initialized.run.runId,
      eventId: 'create-artifact',
      expectedVersion: 1,
    };
    const mutationInvocation = await toolInvocationStore.get(`${AGENT_RUN_ID}:call-create-artifact`);
    expect(mutationInvocation?.metadata).toEqual(expect.objectContaining({
      toolId: 'WorkflowDemoStep',
      toolInputDigest: canonicalToolInputDigest(mutationInput),
    }));

    const workflowEvents = await workflowDemoStore.readEvents(initialized.run.runId);
    const mutations = await workflowDemoStore.readMutations(initialized.run.runId);
    const mutationEvent = workflowEvents.find((event) => event.eventId === 'create-artifact');
    expect(workflowEvents.map((event) => event.eventId)).toEqual(['trigger', 'create-artifact', 'verify']);
    expect(mutations).toHaveLength(1);
    expect(mutationEvent?.agentProvenance).toEqual({
      runtimeSessionId: SESSION_ID,
      runtimeRunId: AGENT_RUN_ID,
      toolInvocationId: `${AGENT_RUN_ID}:call-create-artifact`,
      toolCallId: 'call-create-artifact',
      toolId: 'WorkflowDemoStep',
      toolName: 'WorkflowDemoStep',
      toolInputDigest: canonicalToolInputDigest(mutationInput),
      workflowEventId: 'create-artifact',
      actionBindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    expect(mutations[0]?.agentProvenance).toEqual(mutationEvent?.agentProvenance);
    expect(mutations[0]?.actionDigest).toBe(mutationEvent?.agentProvenance?.actionBindingDigest);
    expect(mutations[0]).toMatchObject({
      workflowActionId: 'create-artifact-action',
      before: { state: '待生成', version: 1 },
      after: { state: '成果已生成并回读', version: 2 },
      source: 'agent',
    });

    const readBack = await workflowDemoStore.readObjects(initialized.run.runId);
    expect(readBack).toEqual([{
      id: 'artifact-one',
      label: '演示成果对象',
      state: '成果已生成并回读',
      version: 2,
    }]);
    expect((await workflowDemoStore.getByRunId(initialized.run.runId))?.status).toBe('passed');
    expect((await workflowDemoStore.getReplayByRunId(initialized.run.runId))?.replay.verification.readBackVerified).toBe(true);

    const runtimeEventTypes = runtimeEvents.events.map((event) => event.type);
    expect(runtimeEventTypes.filter((type) => type === 'assistant_tool_calls')).toHaveLength(3);
    expect(runtimeEventTypes.filter((type) => type === 'tool_invocation_started')).toHaveLength(3);
    expect(runtimeEventTypes.filter((type) => type === 'tool_invocation_completed')).toHaveLength(3);
    expect(runtimeEventTypes.filter((type) => type === 'tool_result')).toHaveLength(3);
    expect(runtimeEventTypes.filter((type) => type === 'tool_audit')).toHaveLength(3);
    for (const invocationId of invocationIds) {
      const toolCallId = invocationId.slice(invocationId.indexOf(':') + 1);
      const startedIndex = runtimeEvents.events.findIndex((event) => (
        event.type === 'tool_invocation_started' && event.invocationId === invocationId
      ));
      const completedIndex = runtimeEvents.events.findIndex((event) => (
        event.type === 'tool_invocation_completed' && event.invocationId === invocationId
      ));
      const resultIndex = runtimeEvents.events.findIndex((event) => (
        event.type === 'tool_result' && event.toolCallId === toolCallId
      ));
      expect(startedIndex).toBeGreaterThanOrEqual(0);
      expect(completedIndex).toBeGreaterThan(startedIndex);
      expect(resultIndex).toBeGreaterThan(completedIndex);
    }
  });
});
