import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBuiltinTools } from '../agent/builtinTools.js';
import { createDefaultExecutionTransportRegistry, type ToolCallContext } from '../agent/toolRuntime.js';
import { getBuiltinHistoricalConfigDigests } from '../data/agentProfiles/builtins.js';
import { InMemoryAgentRuntimeProfileStore } from '../data/agentProfiles/store.js';
import {
  DEFAULT_ORG_AGENT_RUNTIME_POLICY,
  mergeOrgAgentWorkerRuntimePolicy,
} from '../data/orgAgents/runtimePolicy.js';
import { AgentRuntimeProfileResolver } from '../runtime/agentProfiles.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord, FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { SUBAGENT_TYPES } from '../runtime/subagent/agentTypes.js';
import { SubagentLimiter } from '../runtime/subagent/subagentLimits.js';
import { runSubagent } from '../runtime/subagent/subagentRunner.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { ChannelContext } from '../types/index.js';
import { TextOnlyAdapter } from './helpers/subagentModelAdapters.js';

const cleanup = new Set<string>();
afterEach(async () => {
  await Promise.all([...cleanup].map(path => rm(path, { recursive: true, force: true })));
  cleanup.clear();
});

describe('background Profile recovery', () => {
  it('reloads the pinned task session and starts a real Worker child with a legacy builtin digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'background-profile-recovery-'));
    cleanup.add(root);
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const taskSessionId = `sub-${randomUUID()}`;
    const sessionCatalog = new FileSessionCatalog({ agentCwd: root });
    const eventStores = new Map<string, FileEventStore>();
    const eventStoreFactory: NonNullable<RawRuntimeRunDispatchConfig['eventStoreFactory']> = session => {
      let store = eventStores.get(session.sessionId);
      if (!store) {
        store = new FileEventStore(join(root, 'events', `${session.sessionId}.jsonl`), tenantId);
        eventStores.set(session.sessionId, store);
      }
      return store;
    };
    const profileStore = new InMemoryAgentRuntimeProfileStore();
    await profileStore.init();
    const resolver = new AgentRuntimeProfileResolver(profileStore);
    const background = await resolver.resolveForSession({
      existingSession: null,
      bindingKey: 'background_general',
    });
    let taskSession = createRuntimeSessionRecord({
      sessionId: taskSessionId,
      userId: 'user-1',
      username: 'alice',
      userRole: 'user',
      tenantId,
      channel: 'web',
      cwd: root,
      modelRef: 'mock/worker-model',
      executionTarget: 'server-local',
      workspaceId: `workspace-${taskSessionId}`,
      status: 'idle',
      kind: 'subagent',
      executionRole: 'worker',
      orgAgentId: 'org-kaikai',
      orgAgentSnapshot: {
        name: '开开',
        instructions: '后台执行组织任务',
        allowedSkills: ['dws'],
        allowedKnowledge: [],
        runtime: {
          ...structuredClone(DEFAULT_ORG_AGENT_RUNTIME_POLICY),
          executionMode: 'dispatcher',
          workerModel: { strategy: 'fixed', modelRef: 'mock/worker-model' },
        },
      },
    });
    cleanup.add(dirname(dirname(taskSession.transcriptPath)));
    const effectiveWorker = {
      ...background,
      version: {
        ...background.version,
        config: mergeOrgAgentWorkerRuntimePolicy(
          background.version.config,
          taskSession.orgAgentSnapshot?.runtime,
        ),
      },
    };
    taskSession = resolver.bindSessionRecord(taskSession, effectiveWorker);
    expect(effectiveWorker.version.config.model).toEqual({ strategy: 'fixed', modelRef: 'mock/worker-model' });
    expect(taskSession.profileConfigDigest).toBe(background.binding.profileConfigDigest);
    const historicalDigest = getBuiltinHistoricalConfigDigests('background_general')[0]!;
    await sessionCatalog.upsert({ ...taskSession, profileConfigDigest: historicalDigest });
    const reloaded = await sessionCatalog.get(taskSessionId);
    expect(reloaded).not.toBeNull();

    const channelContext: ChannelContext = {
      channel: 'web',
      user: { id: 'user-1', username: 'alice', role: 'user', tenantId },
    };
    const parentContext: ToolCallContext = {
      channelContext,
      workspace: {
        id: `workspace-${taskSessionId}`,
        root,
        userId: 'user-1',
        username: 'alice',
        tenantId,
        sessionId: taskSessionId,
        executionTarget: 'server-local',
      },
      sessionId: taskSessionId,
      runId: `bg-${randomUUID()}`,
      toolCallId: 'background-task',
    };
    const config: RawRuntimeRunDispatchConfig = {
      agentCwd: root,
      sharedDir: join(root, 'shared'),
      sessionCatalog,
      eventStoreFactory,
      agentRuntimeProfileResolver: resolver,
      modelResolver: () => ({
        model: 'mock-model',
        connection: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:0' },
      }),
    };
    const outcome = await runSubagent({
      config,
      executionTransportRegistry: createDefaultExecutionTransportRegistry(),
      tenantHandResolver: createTenantRemoteHandAuthTokenResolver({}),
      parentContext,
      parentProviders: [createBuiltinTools()],
      agentType: SUBAGENT_TYPES.general,
      profileSourceSession: reloaded!,
      request: { description: '后台任务', prompt: '完成后台任务', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new TextOnlyAdapter(),
    });

    expect(outcome.status).toBe('completed');
    await expect(sessionCatalog.get(outcome.childSessionId)).resolves.toMatchObject({
      kind: 'subagent',
      executionRole: 'worker',
      orgAgentId: 'org-kaikai',
      profileBindingKey: 'background_general',
      profileVersionId: background.binding.profileVersionId,
      profileConfigDigest: background.binding.profileConfigDigest,
    });
  });
});
