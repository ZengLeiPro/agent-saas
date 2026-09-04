import { PlatformToolRuntime } from '../../agent/toolRuntime.js';
import type { RunRecord } from '../runStore.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import { resolveSessionCatalog } from '../rawRuntimeRunDispatch.js';
import { sessionIdentity } from './backgroundTaskServiceSupport.js';
import { deriveBackgroundRuntimeIsolationRequirement, type BackgroundCommandTaskMetadata } from './backgroundTaskMetadata.js';

export async function invokeBackgroundCommandControl(
  config: RawRuntimeRunDispatchConfig,
  record: RunRecord,
  metadata: BackgroundCommandTaskMetadata,
  toolId: 'BashOutput' | 'KillBash',
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: string }> {
  const executionRegistry = config.executionTransportRegistry;
  const tenantHandResolver = config.tenantRemoteHandResolver;
  if (!executionRegistry || !tenantHandResolver)
    throw new Error('后台命令缺少 executionTransportRegistry/tenantHandResolver 装配。');
  const sessionCatalog = resolveSessionCatalog(config);
  const taskSession = await sessionCatalog.get(record.sessionId);
  const parentSession = await sessionCatalog.get(metadata.parentSessionId);
  if (!taskSession) throw new Error(`后台命令 session 不存在：${record.sessionId}`);
  if (!parentSession) throw new Error(`后台命令父 session 不存在：${metadata.parentSessionId}`);
  const identity = sessionIdentity(parentSession);
  const runtime = new PlatformToolRuntime({
    executionTransportRegistry: executionRegistry,
    handStore: config.handStore,
    resolveHandAuthToken: (hand) => tenantHandResolver.resolveForHand(hand),
  });
  return await runtime.invoke(
    {
      toolId,
      input,
      authorization: { approved: true, source: 'legacy_adapter' },
    },
    {
      channelContext: {
        channel: metadata.parentChannel,
        resumeSessionId: metadata.parentSessionId,
        sessionOwner: identity,
        targetCwd: metadata.cwd,
        ...(metadata.timezone ? { timezone: metadata.timezone } : {}),
      },
      workspace: {
        id: metadata.workspaceId,
        root: metadata.cwd,
        userId: parentSession.userId,
        username: parentSession.username,
        tenantId: parentSession.tenantId,
        sessionId: metadata.parentSessionId,
        topLevelSessionId: metadata.topLevelSessionId ?? metadata.parentSessionId,
        executionTarget: record.executionTarget ?? taskSession.executionTarget ?? 'server-remote',
        ...(metadata.mountSubPath ? { mountSubPath: metadata.mountSubPath } : {}),
        ...(metadata.sharedReadOnlySubPath
          ? { sharedReadOnlySubPath: metadata.sharedReadOnlySubPath }
          : {}),
        ...(metadata.sandboxScopeId ? { sandboxScopeId: metadata.sandboxScopeId } : {}),
        ...(metadata.sandboxResources ? { sandboxResources: metadata.sandboxResources } : {}),
        ...(metadata.workload ? { workload: metadata.workload } : {}),
        ...(metadata.sandboxPolicy ? { sandboxPolicy: metadata.sandboxPolicy } : {}),
      },
      sessionId: metadata.parentSessionId,
      runId: record.runId,
      toolCallId: `${toolId}-${record.runId}`,
      ...(metadata.automationFence ? { automationFence: metadata.automationFence } : {}),
      ...(deriveBackgroundRuntimeIsolationRequirement(metadata, {
        runId: record.runId,
        sessionId: record.sessionId,
        workspaceId: metadata.workspaceId,
      }) ? { runtimeIsolationRequirement: deriveBackgroundRuntimeIsolationRequirement(metadata, {
        runId: record.runId,
        sessionId: record.sessionId,
        workspaceId: metadata.workspaceId,
      }) } : {}),
      signal,
    },
  );
}
