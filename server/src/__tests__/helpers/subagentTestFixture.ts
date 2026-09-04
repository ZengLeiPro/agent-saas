import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createDefaultExecutionTransportRegistry,
  type ToolCallContext,
  type WorkspaceRef,
} from '../../agent/toolRuntime.js';
import type { BillingService } from '../../data/billing/service.js';
import type { RecordResultParams, TokenUsageStore } from '../../data/usage/store.js';
import { FileEventStore } from '../../runtime/fileEventStore.js';
import type { RawRuntimeRunDispatchConfig } from '../../runtime/rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord, FileSessionCatalog } from '../../runtime/sessionCatalog.js';
import { createTenantRemoteHandAuthTokenResolver } from '../../runtime/tenantRemoteHandResolver.js';
import type { ChannelContext } from '../../types/index.js';

export interface SubagentFixture {
  tmp: string;
  config: RawRuntimeRunDispatchConfig;
  parentContext: ToolCallContext;
  parentSessionId: string;
  parentRunId: string;
  tenantId: string;
  parentEventStore: FileEventStore;
  usageRecords: RecordResultParams[];
  cleanupDirs: Set<string>;
}

export async function makeFixture(options: {
  cleanupDirs: Set<string>;
  billingService?: BillingService;
  modelResolver?: RawRuntimeRunDispatchConfig['modelResolver'];
  parentMemoryPolicyVersion?: 'v1' | 'v2';
} = { cleanupDirs: new Set() }): Promise<SubagentFixture> {
  const tmp = await mkdtemp(join(tmpdir(), 'subagent-'));
  options.cleanupDirs.add(tmp);
  const tenantId = `t-sub-${randomUUID().slice(0, 8)}`;
  const parentSessionId = randomUUID();
  const parentRunId = `${Date.now()}-${randomUUID()}`;
  const usageRecords: RecordResultParams[] = [];

  const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
  const eventStores = new Map<string, FileEventStore>();
  const eventStoreFor = (sessionId: string): FileEventStore => {
    let store = eventStores.get(sessionId);
    if (!store) {
      store = new FileEventStore(join(tmp, 'events', `${sessionId}.jsonl`), tenantId);
      eventStores.set(sessionId, store);
    }
    return store;
  };

  const config: RawRuntimeRunDispatchConfig = {
    agentCwd: tmp,
    sharedDir: join(tmp, 'shared'),
    sessionCatalog,
    eventStoreFactory: (session) => eventStoreFor(session.sessionId),
    modelResolver: options.modelResolver
      ?? ((_ref: string, _tenantId?: string) => ({
        model: 'mock-model',
        connection: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:0' },
      })),
    ...(options.billingService ? { billingService: () => options.billingService } : {}),
    tokenUsageStore: () => ({
      recordResult: (params: RecordResultParams) => { usageRecords.push(params); },
    } as unknown as TokenUsageStore),
  };

  const parentRecord = createRuntimeSessionRecord({
    sessionId: parentSessionId,
    userId: 'user-1',
    username: 'alice',
    userRole: 'user',
    tenantId,
    channel: 'web',
    cwd: tmp,
    modelRef: 'mock/group-model',
    executionTarget: 'server-local',
    status: 'running',
    ...(options.parentMemoryPolicyVersion ? { memoryPolicyVersion: options.parentMemoryPolicyVersion } : {}),
  });
  options.cleanupDirs.add(dirname(dirname(parentRecord.transcriptPath)));
  await sessionCatalog.upsert(parentRecord);

  const channelContext: ChannelContext = {
    channel: 'web',
    user: { id: 'user-1', username: 'alice', role: 'user', tenantId },
  };
  const workspace: WorkspaceRef = {
    id: `ws-${parentSessionId}`,
    root: tmp,
    userId: 'user-1',
    username: 'alice',
    tenantId,
    sessionId: parentSessionId,
    executionTarget: 'server-local',
  };
  const parentContext: ToolCallContext = {
    channelContext,
    workspace,
    sessionId: parentSessionId,
    runId: parentRunId,
    toolCallId: 'call_agent_1',
  };

  return {
    tmp,
    config,
    parentContext,
    parentSessionId,
    parentRunId,
    tenantId,
    parentEventStore: eventStoreFor(parentSessionId),
    usageRecords,
    cleanupDirs: options.cleanupDirs,
  };
}

export function runnerDeps(fixture: SubagentFixture) {
  return {
    config: fixture.config,
    executionTransportRegistry: createDefaultExecutionTransportRegistry(),
    tenantHandResolver: createTenantRemoteHandAuthTokenResolver({}),
    parentContext: fixture.parentContext,
  };
}
