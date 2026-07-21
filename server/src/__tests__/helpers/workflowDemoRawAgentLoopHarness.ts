import type { DemoManifestRecord } from "../../../../shared/src/index.js";
import { PlatformToolRuntime } from "../../agent/toolRuntime.js";
import { WorkflowDemoToolProvider, type WorkflowDemoStepInput } from "../../agent/workflowDemoToolProvider.js";
import {
  getWorkflowDemoApprovalRequests,
  initializeWorkflowDemo,
  recordWorkflowDemoExternalStep,
} from "../../data/workflowDemos/engine.js";
import type {
  WorkflowDemoEventRecord,
  WorkflowDemoMutationRecord,
  WorkflowDemoObjectState,
  WorkflowDemoPublicReplay,
  WorkflowDemoStore,
  WorkflowDemoWaitRecord,
} from "../../data/workflowDemos/store.js";
import { EventBackedApprovalStore } from "../../runtime/approvalStore.js";
import { LegacyTranscriptProjection } from "../../runtime/legacyTranscriptProjection.js";
import { RawAgentLoop } from "../../runtime/rawAgentLoop.js";
import { InMemoryToolInvocationStore, type ToolInvocationStore } from "../../runtime/toolInvocationStore.js";
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
} from "../../runtime/types.js";
import type { OutboundEvent } from "../../types/index.js";

type ExecutionStep = NonNullable<DemoManifestRecord["internal"]["executionPlan"]>[number];

export interface RawAgentLoopPilotResult {
  manifest: DemoManifestRecord;
  runId: string;
  objects: WorkflowDemoObjectState[];
  events: WorkflowDemoEventRecord[];
  mutations: WorkflowDemoMutationRecord[];
  waits: WorkflowDemoWaitRecord[];
  replay: WorkflowDemoPublicReplay;
  segmentCount: number;
  invocationIds: string[];
  invocationStore: ToolInvocationStore;
  runtimeEvents: PlatformEvent[];
  modelRequests: ModelRequest[];
}

export async function executeWorkflowDemoViaRawAgentLoop(input: {
  manifest: DemoManifestRecord;
  resolveManifest: (demoId: string) => Promise<DemoManifestRecord>;
  workflowDemoStore: WorkflowDemoStore;
  tenantId: string;
  actorUserId: string;
}): Promise<RawAgentLoopPilotResult> {
  const plan = input.manifest.internal.executionPlan;
  if (!plan?.length) throw new Error(`${input.manifest.workflowId} 缺少 executionPlan`);

  const sessionId = `raw-pilot-session-${input.manifest.workflowId}`;
  const invocationStore = new InMemoryToolInvocationStore();
  const initialized = await initializeWorkflowDemo(input.workflowDemoStore, {
    manifest: input.manifest,
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    idempotencyKey: `raw-agent-loop-pilot-${input.manifest.id}`,
  });
  const provider = new WorkflowDemoToolProvider({
    workflowDemoStore: input.workflowDemoStore,
    toolInvocationStore: invocationStore,
    resolveManifest: input.resolveManifest,
    dispatch: { runId: initialized.run.runId, eventId: plan[0]!.eventId },
  });
  if (initialized.replayed || initialized.run.status !== "running") {
    throw new Error(`${input.manifest.workflowId} 初始化未产生全新 running run`);
  }

  const approvalRequests = new Map(
    getWorkflowDemoApprovalRequests(input.manifest).map((request) => [request.eventId, request] as const),
  );
  const runtimeEventStore = new MemoryEventStore();
  const invocationIds: string[] = [];
  const modelRequests: ModelRequest[] = [];
  let segmentCount = 0;
  let externalSequence = 0;
  let cursor = 0;

  while (cursor < plan.length) {
    const step = plan[cursor]!;
    if (step.phase === "approval" || step.phase === "resume") {
      externalSequence += 1;
      await applyExternalStep({
        manifest: input.manifest,
        step,
        index: cursor,
        runId: initialized.run.runId,
        store: input.workflowDemoStore,
        externalSequence,
        approvalRequests,
      });
      cursor += 1;
      continue;
    }

    const segment: ExecutionStep[] = [];
    while (cursor < plan.length) {
      const candidate = plan[cursor]!;
      if (candidate.phase === "approval" || candidate.phase === "resume") break;
      segment.push(candidate);
      cursor += 1;
    }
    segmentCount += 1;
    const runtimeRunId = `raw-pilot-run-${input.manifest.workflowId}-${segmentCount}`;
    const adapter = new WorkflowPlanModelAdapter({
      workflowRunId: initialized.run.runId,
      runtimeRunId,
      steps: segment,
      store: input.workflowDemoStore,
    });
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore: runtimeEventStore,
      approvalStore: new EventBackedApprovalStore(runtimeEventStore, sessionId),
      transcriptProjection: new LegacyTranscriptProjection("/dev/null"),
      toolRuntime: new PlatformToolRuntime({ providers: [provider] }),
      toolInvocationStore: invocationStore,
    });
    const outbound = await collect(loop.run(
      {
        message: { channel: "web", chatId: sessionId, content: `继续执行 ${input.manifest.public.title}` },
        prompt: `继续执行 ${input.manifest.public.title}`,
        instructions: "按冻结执行计划依次调用 WorkflowDemoStep；外部信号由平台恢复后再继续。",
        maxTurns: segment.length + 2,
        connection: { apiKey: "sk-isolated-test", baseUrl: "https://example.invalid/v1" },
      },
      {
        runId: runtimeRunId,
        sessionId,
        model: "deterministic-workflow-pilot-model",
        cwd: "/tmp/workflow-demo-raw-agent-loop-pilot",
        tenantId: input.tenantId,
        channelContext: {
          channel: "web",
          user: {
            id: input.actorUserId,
            username: input.actorUserId,
            role: "user",
            tenantId: input.tenantId,
          },
        },
      },
    ));
    if (outbound.at(-1)?.type !== "done") {
      throw new Error(`${input.manifest.workflowId} 第 ${segmentCount} 段 RawAgentLoop 未正常结束`);
    }
    invocationIds.push(...adapter.invocationIds);
    modelRequests.push(...adapter.requests);
  }

  const run = await input.workflowDemoStore.getByRunId(initialized.run.runId);
  const snapshot = await input.workflowDemoStore.getReplayByRunId(initialized.run.runId);
  if (!run || run.status !== "passed" || !snapshot) {
    throw new Error(`${input.manifest.workflowId} RawAgentLoop 多轮运行未形成 passed replay`);
  }
  return {
    manifest: input.manifest,
    runId: initialized.run.runId,
    objects: await input.workflowDemoStore.readObjects(initialized.run.runId),
    events: await input.workflowDemoStore.readEvents(initialized.run.runId),
    mutations: await input.workflowDemoStore.readMutations(initialized.run.runId),
    waits: await input.workflowDemoStore.readWaits(initialized.run.runId),
    replay: snapshot.replay,
    segmentCount,
    invocationIds,
    invocationStore,
    runtimeEvents: runtimeEventStore.events,
    modelRequests,
  };
}

class WorkflowPlanModelAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly invocationIds: string[] = [];
  private cursor = 0;

  constructor(private readonly input: {
    workflowRunId: string;
    runtimeRunId: string;
    steps: ExecutionStep[];
    store: WorkflowDemoStore;
  }) {}

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const step = this.input.steps[this.cursor];
    if (!step) {
      yield { type: "text_delta", content: "本段已完成，等待下一业务事件。" };
      yield {
        type: "completed",
        content: "本段已完成，等待下一业务事件。",
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 3 },
      };
      return;
    }

    this.cursor += 1;
    const toolCallId = `workflow-step-${this.cursor}`;
    this.invocationIds.push(`${this.input.runtimeRunId}:${toolCallId}`);
    const objects = await this.input.store.readObjects(this.input.workflowRunId);
    const target = objects.find((object) => object.id === step.targetObjectId);
    if (step.mutation && !target) {
      throw new Error(`${step.eventId} 的写入目标 ${step.targetObjectId} 不存在`);
    }
    const toolInput: WorkflowDemoStepInput = {
      workflowRunId: this.input.workflowRunId,
      eventId: step.eventId,
      ...(step.mutation ? { expectedVersion: target!.version } : {}),
    };
    yield {
      type: "completed",
      content: "",
      toolCalls: [{ id: toolCallId, name: "WorkflowDemoStep", arguments: JSON.stringify(toolInput) }],
      usage: { inputTokens: 8, outputTokens: 3 },
    };
  }
}

class MemoryEventStore implements EventStore {
  readonly events: PlatformEvent[] = [];

  async append(event: PlatformEventInput, _context?: EventAppendContext): Promise<PlatformEvent> {
    const stored = {
      ...event,
      id: `raw-pilot-runtime-event-${this.events.length + 1}`,
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
      (!("sessionId" in event) || event.sessionId === sessionId) && !excluded.has(event.type)
    ));
  }
}

async function applyExternalStep(input: {
  manifest: DemoManifestRecord;
  step: ExecutionStep;
  index: number;
  runId: string;
  store: WorkflowDemoStore;
  externalSequence: number;
  approvalRequests: Map<string, ReturnType<typeof getWorkflowDemoApprovalRequests>[number]>;
}): Promise<void> {
  const before = await input.store.readObjects(input.runId);
  const bindings = externalBindings(input.step);
  const approvalRequest = input.step.phase === "approval"
    ? input.approvalRequests.get(input.step.eventId)
    : undefined;
  if (input.step.phase === "approval" && !approvalRequest) {
    throw new Error(`${input.manifest.workflowId}/${input.step.eventId} 缺少冻结 approval request`);
  }
  await recordWorkflowDemoExternalStep(input.store, {
    manifest: input.manifest,
    runId: input.runId,
    externalActorUserId: `raw-pilot-external-${input.manifest.workflowId}-${input.externalSequence}`,
    eventId: input.step.eventId,
    signal: {
      signalId: `raw-pilot-signal-${input.manifest.workflowId}-${input.index + 1}`,
      signalRef: approvalRequest?.signalRef ?? input.step.resumeSignalRef!,
      kind: input.step.phase === "approval" ? "approval" : "resume",
      occurredAt: new Date(Date.UTC(2026, 6, 21, 10, input.index, 0)).toISOString(),
      ...(approvalRequest ? { approvalDigest: approvalRequest.approvalDigest } : {}),
      observations: bindings.map((binding, bindingIndex) => {
        const current = before.find((object) => object.id === binding.targetObjectId);
        if (!current) throw new Error(`外部信号目标不存在: ${binding.targetObjectId}`);
        return {
          objectId: binding.targetObjectId,
          expectedVersion: current.version,
          observedState: binding.expectedState,
          sourceReceiptId: `raw-pilot-source-${input.index + 1}-${bindingIndex + 1}`,
        };
      }),
    },
  });
}

function externalBindings(step: ExecutionStep): Array<{ targetObjectId: string; expectedState: string }> {
  return [
    ...(step.mutation ? [{ targetObjectId: step.targetObjectId, expectedState: step.expectedState }] : []),
    ...(step.externalChanges ?? []).map((change) => ({
      targetObjectId: change.targetObjectId,
      expectedState: change.expectedState,
    })),
  ];
}

async function collect(events: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const values: OutboundEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}
