import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DemoManifestRecord } from '../../../shared/src/index.js';
import {
  WorkflowDemoToolProvider,
  workflowDemoStepToolDescriptor,
  type WorkflowDemoStepInput,
} from '../agent/workflowDemoToolProvider.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';
import { loadWorkflowLibraryV3 } from '../data/scenarios/workflowLibrary.js';
import { initializeWorkflowDemo } from '../data/workflowDemos/engine.js';
import { InMemoryWorkflowDemoStore } from '../data/workflowDemos/store.js';
import { canonicalToolInputDigest } from '../runtime/rawAgentLoop.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';

const DATA_PATH = resolve(import.meta.dirname, '../data/scenarios/workflow-library-v3.json');
const ACT_DEMO_ID = 'demo-controlled-version-release-loop-v1';

function createContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    channelContext: {
      channel: 'web',
      user: { id: 'user-one', username: 'user_one', role: 'user', tenantId: 'tenant-one' },
    },
    workspace: { root: '/tmp/workflow-demo-provider-test', executionTarget: 'server-local' },
    sessionId: 'session-one',
    runId: 'agent-run-one',
    toolCallId: 'tool-call-one',
    invocationId: 'agent-run-one:tool-call-one',
    ...overrides,
  };
}

async function loadActManifest(): Promise<DemoManifestRecord> {
  const library = await loadWorkflowLibraryV3(DATA_PATH);
  const manifest = library.internal.demos.find((item) => item.id === ACT_DEMO_ID);
  if (!manifest) throw new Error(`测试 Demo 不存在: ${ACT_DEMO_ID}`);
  return manifest;
}

async function createHarness(actorUserId = 'user-one') {
  const manifest = await loadActManifest();
  const workflowDemoStore = new InMemoryWorkflowDemoStore();
  const initialized = await initializeWorkflowDemo(workflowDemoStore, {
    manifest,
    tenantId: 'tenant-one',
    actorUserId,
    idempotencyKey: `workflow-provider-test-${actorUserId}`,
  });
  const firstStep = manifest.internal.executionPlan?.[0];
  if (!firstStep) throw new Error('测试 Demo 缺少 executionPlan');
  const input: WorkflowDemoStepInput = {
    workflowRunId: initialized.run.runId,
    eventId: firstStep.eventId,
  };
  const toolInvocationStore = new InMemoryToolInvocationStore();
  const provider = new WorkflowDemoToolProvider({
    workflowDemoStore,
    toolInvocationStore,
    resolveManifest: async () => manifest,
    dispatch: { runId: initialized.run.runId, eventId: firstStep.eventId },
  });
  return { manifest, workflowDemoStore, toolInvocationStore, provider, input };
}

async function startInvocation(
  store: InMemoryToolInvocationStore,
  input: WorkflowDemoStepInput,
  overrides: Partial<Parameters<InMemoryToolInvocationStore['start']>[0]> = {},
) {
  return store.start({
    invocationId: 'agent-run-one:tool-call-one',
    runId: 'agent-run-one',
    sessionId: 'session-one',
    toolCallId: 'tool-call-one',
    toolName: 'WorkflowDemoStep',
    executionTarget: 'server-local',
    tenantId: 'tenant-one',
    metadata: {
      toolId: 'WorkflowDemoStep',
      toolInputDigest: canonicalToolInputDigest(input),
    },
    ...overrides,
  });
}

function toolCall(input: WorkflowDemoStepInput) {
  return {
    toolId: 'WorkflowDemoStep',
    input,
    authorization: { approved: true, source: 'policy_auto' as const },
  };
}

describe('WorkflowDemoToolProvider', () => {
  it('只有带组织身份的真实会话才展示工具', async () => {
    const { provider } = await createHarness();
    expect(provider.list()).toEqual([]);
    expect(provider.list(createContext()).map((tool) => tool.id)).toEqual(['WorkflowDemoStep']);
    expect(workflowDemoStepToolDescriptor).toMatchObject({
      risk: 'safe',
      approvalMode: 'never',
      category: 'core',
    });
  });

  it('核对 running invocation 后经真实 Engine 推进一步，结果不泄漏内部 provenance', async () => {
    const harness = await createHarness();
    await startInvocation(harness.toolInvocationStore, harness.input);

    const result = await harness.provider.invoke(toolCall(harness.input), createContext());
    const events = await harness.workflowDemoStore.readEvents(harness.input.workflowRunId);

    expect(events).toHaveLength(1);
    expect(events[0]?.agentProvenance).toEqual({
      runtimeSessionId: 'session-one',
      runtimeRunId: 'agent-run-one',
      toolInvocationId: 'agent-run-one:tool-call-one',
      toolCallId: 'tool-call-one',
      toolId: 'WorkflowDemoStep',
      toolName: 'WorkflowDemoStep',
      toolInputDigest: canonicalToolInputDigest(harness.input),
      workflowEventId: harness.input.eventId,
      actionBindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      tenantId: 'tenant-one',
      actorUserId: 'user-one',
    });
    expect(JSON.parse(result!.content)).toMatchObject({
      workflowRunId: harness.input.workflowRunId,
      eventId: harness.input.eventId,
      phase: 'trigger',
      runStatus: 'running',
      completed: false,
      objects: expect.any(Array),
    });
    expect(result!.content).not.toMatch(/toolInvocationId|toolCallId|toolInputDigest|tenantId|actorUserId/);
  });

  it('缺少 Runtime 上下文或 invocation 行时 fail-closed，Workflow 零写入', async () => {
    const harness = await createHarness();

    await expect(harness.provider.invoke(toolCall(harness.input), createContext({ invocationId: undefined })))
      .rejects.toMatchObject({ code: 'WORKFLOW_DEMO_AGENT_PROVENANCE_REQUIRED' });
    await expect(harness.provider.invoke(toolCall(harness.input), createContext()))
      .rejects.toMatchObject({ code: 'WORKFLOW_DEMO_AGENT_INVOCATION_NOT_RUNNING' });
    expect(await harness.workflowDemoStore.readEvents(harness.input.workflowRunId)).toEqual([]);
  });

  it('拒绝 completed invocation 和摘要不匹配的重放', async () => {
    const completed = await createHarness();
    await startInvocation(completed.toolInvocationStore, completed.input);
    await completed.toolInvocationStore.complete('agent-run-one:tool-call-one', 'completed');
    await expect(completed.provider.invoke(toolCall(completed.input), createContext()))
      .rejects.toMatchObject({ code: 'WORKFLOW_DEMO_AGENT_INVOCATION_NOT_RUNNING' });
    expect(await completed.workflowDemoStore.readEvents(completed.input.workflowRunId)).toEqual([]);

    const mismatched = await createHarness();
    await startInvocation(mismatched.toolInvocationStore, {
      ...mismatched.input,
      eventId: 'another-event',
    });
    await expect(mismatched.provider.invoke(toolCall(mismatched.input), createContext()))
      .rejects.toMatchObject({ code: 'WORKFLOW_DEMO_AGENT_PROVENANCE_MISMATCH' });
    expect(await mismatched.workflowDemoStore.readEvents(mismatched.input.workflowRunId)).toEqual([]);
  });

  it('拒绝跨租户或非 run 创建者的 Agent 调用', async () => {
    const harness = await createHarness('another-user');
    await startInvocation(harness.toolInvocationStore, harness.input);

    await expect(harness.provider.invoke(toolCall(harness.input), createContext()))
      .rejects.toMatchObject({ code: 'WORKFLOW_DEMO_AGENT_IDENTITY_MISMATCH' });
    expect(await harness.workflowDemoStore.readEvents(harness.input.workflowRunId)).toEqual([]);
  });

  it('拒绝服务端 resolver 返回与 run 不一致的 manifest', async () => {
    const harness = await createHarness();
    await startInvocation(harness.toolInvocationStore, harness.input);
    const provider = new WorkflowDemoToolProvider({
      workflowDemoStore: harness.workflowDemoStore,
      toolInvocationStore: harness.toolInvocationStore,
      resolveManifest: async () => ({ ...harness.manifest, id: 'another-demo' }),
      dispatch: { runId: harness.input.workflowRunId, eventId: harness.input.eventId },
    });

    await expect(provider.invoke(toolCall(harness.input), createContext()))
      .rejects.toMatchObject({ code: 'WORKFLOW_DEMO_MANIFEST_MISMATCH' });
    expect(await harness.workflowDemoStore.readEvents(harness.input.workflowRunId)).toEqual([]);
  });

  it('即使工具 Invocation 真实存在，也拒绝推进不属于本次 dispatch capability 的 run', async () => {
    const harness = await createHarness();
    await startInvocation(harness.toolInvocationStore, harness.input);
    const provider = new WorkflowDemoToolProvider({
      workflowDemoStore: harness.workflowDemoStore,
      toolInvocationStore: harness.toolInvocationStore,
      resolveManifest: async () => harness.manifest,
      dispatch: {
        runId: '33333333-3333-4333-8333-333333333333',
        eventId: harness.input.eventId,
      },
    });

    await expect(provider.invoke(toolCall(harness.input), createContext()))
      .rejects.toMatchObject({ code: 'WORKFLOW_DEMO_DISPATCH_CAPABILITY_MISMATCH' });
    expect(await harness.workflowDemoStore.readEvents(harness.input.workflowRunId)).toEqual([]);
  });
});
