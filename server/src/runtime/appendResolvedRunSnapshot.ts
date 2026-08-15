import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { PgRunResolutionSnapshotStore } from './runResolutionSnapshotStore.js';
import type { RunPreflightService } from './runPreflight.js';
import type { HandRecord } from './handStore.js';
import type { RuntimeSessionRecord } from './sessionCatalog.js';

export interface ResolvedRunSnapshotConfig {
  runPreflightService?: RunPreflightService;
  runResolutionSnapshotStore?: Pick<PgRunResolutionSnapshotStore, 'append' | 'get'>;
  logger?: { warn(message: string): void };
}

export async function appendResolvedRunSnapshot(input: {
  config: ResolvedRunSnapshotConfig;
  runId: string;
  session: RuntimeSessionRecord;
  modelRef?: string;
  executionTarget: ExecutionTargetKind;
  hands: HandRecord[];
}): Promise<void> {
  const { runPreflightService, runResolutionSnapshotStore } = input.config;
  if (!runPreflightService || !runResolutionSnapshotStore) return;
  // 同一 run 的 resolution snapshot 必须 immutable；approval/interaction resume 不得用新配置覆盖审计基线。
  try {
    if (await runResolutionSnapshotStore.get(input.runId)) return;
  } catch (error) {
    input.config.logger?.warn(
      `[governance-shadow] existing snapshot lookup unavailable: run=${input.runId} `
      + `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tenantHands = input.hands.filter(hand => (
    hand.status === 'ready' && hand.metadata?.registeredBy === 'tenantRemoteHands'
  ));
  const tenantHandId = tenantHands.length === 1 ? tenantHands[0]?.handId : undefined;
  const defaultHandId = `${input.session.sessionId}:${input.executionTarget}`;
  const environment = input.hands.find(hand => hand.handId === (tenantHandId ?? defaultHandId));
  const result = await runPreflightService.preflight({
    phase: 'wake',
    runId: input.runId,
    sessionId: input.session.sessionId,
    ...(input.session.userId ? { userId: input.session.userId } : {}),
    ...(input.session.tenantId ? { tenantId: input.session.tenantId } : {}),
    ...(input.session.orgAgentId ? { orgAgentId: input.session.orgAgentId } : {}),
    ...(input.modelRef ? { modelRef: input.modelRef } : {}),
    environment: {
      providerId: environment?.providerId ?? input.executionTarget,
      ...(environment?.templateVersionId ? { templateVersionId: environment.templateVersionId } : {}),
      ...(environment?.handId ? { instanceId: environment.handId } : {}),
      ...(environment?.recipeDigest ? { recipeDigest: environment.recipeDigest } : {}),
    },
    skipBilling: true,
  });
  if (!result.proceed) {
    throw new Error(`[${result.accessDecision.reasonCode}] governance preflight blocked run ${input.runId}`);
  }
  try {
    await runResolutionSnapshotStore.append(result.snapshot);
  } catch (error) {
    if (result.enforcementMode === 'enforce') throw error;
    input.config.logger?.warn(
      `[governance-shadow] resolved snapshot unavailable (not blocking): run=${input.runId} `
      + `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
