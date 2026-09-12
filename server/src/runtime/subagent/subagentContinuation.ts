import type { RunRecord } from '../runStore.js';
import { supportsSubagentContinuationProtocol } from './subagentContinuationProtocol.js';

const ACTIVE_RUN_STATUSES = new Set<RunRecord['status']>([
  'pending',
  'running',
  'waiting_approval',
  'waiting_user',
  'waiting_hand',
]);

export interface PersistedSubagentIdentity {
  agentId: string;
  mode: 'foreground' | 'background';
  agentType: 'general' | 'explore';
  description: string;
  includeCompanyInfo: boolean;
  modelRef: string;
  effort?: string;
  latestRun: RunRecord;
  latestPhysicalRun?: RunRecord;
  activePhysicalRun?: RunRecord;
  activeBackgroundTask?: RunRecord;
  childSessionId?: string;
  previousRunId: string;
  sequence: number;
}

/**
 * 把一个稳定 agent_id 的 wrapper、child run 和 steering source 收敛为逻辑身份。
 * 调用方仍需从 RunStore 以 tenant + 根父会话 + user 过滤；这里再次校验，避免
 * 测试替身或未来实现漏掉授权边界。
 */
export function resolvePersistedSubagentIdentity(input: {
  records: RunRecord[];
  agentId: string;
  tenantId: string;
  parentSessionId: string;
  userId?: string;
}): PersistedSubagentIdentity {
  const records = [...input.records]
    .filter(
      (record) =>
        record.metadata?.subagent === true &&
        record.metadata.subagentAgentId === input.agentId &&
        record.metadata.parentSessionId === input.parentSessionId &&
        record.tenantId === input.tenantId &&
        (!input.userId ||
          record.userId === input.userId ||
          record.submitterUserId === input.userId),
    )
    .sort(compareRunNewestFirst);
  if (records.length === 0) throw new Error(`找不到可续接的子 Agent：${input.agentId}`);

  const executionRecords = records.filter(
    (record) => record.metadata.subagentResumeMessage !== true,
  );
  if (executionRecords.length === 0)
    throw new Error(`子 Agent ${input.agentId} 没有可恢复的执行记录。`);
  if (executionRecords.some((record) => !supportsSubagentContinuationProtocol(record.metadata))) {
    throw new Error(`子 Agent ${input.agentId} 使用旧版续接协议，不能安全恢复。`);
  }
  const physicalRuns = executionRecords.filter((record) => record.metadata.backgroundTask !== true);
  const backgroundTasks = executionRecords.filter(
    (record) => record.metadata.backgroundTask === true,
  );
  const latestPhysicalRun = physicalRuns[0];
  const latestRun = executionRecords[0]!;
  if (latestRun.status === 'cancelled' || latestPhysicalRun?.status === 'cancelled') {
    throw new Error(`子 Agent ${input.agentId} 已取消，不能恢复。`);
  }
  const metadata = latestPhysicalRun?.metadata ?? latestRun.metadata;

  const agentTypes = new Set<'general' | 'explore'>(
    executionRecords.flatMap((record) =>
      record.metadata.agentType === 'general' || record.metadata.agentType === 'explore'
        ? [record.metadata.agentType]
        : ([] as Array<'general' | 'explore'>),
    ),
  );
  if (agentTypes.size !== 1)
    throw new Error(`子 Agent ${input.agentId} 的 agent_type 历史不一致。`);
  const agentType = [...agentTypes][0]!;

  const explicitModes = new Set<'foreground' | 'background'>(
    executionRecords.flatMap((record) =>
      record.metadata.subagentMode === 'foreground' || record.metadata.subagentMode === 'background'
        ? [record.metadata.subagentMode]
        : ([] as Array<'foreground' | 'background'>),
    ),
  );
  if (explicitModes.size > 1) throw new Error(`子 Agent ${input.agentId} 的 mode 历史不一致。`);
  const mode =
    explicitModes.values().next().value ??
    (backgroundTasks.length > 0 ? 'background' : 'foreground');
  const description =
    metadataString(metadata, 'description') ?? metadataString(latestRun.metadata, 'description');
  const modelRef =
    metadataString(metadata, 'modelRef') ?? metadataString(latestRun.metadata, 'modelRef');
  if (!description || !modelRef) throw new Error(`子 Agent ${input.agentId} 的持久化身份不完整。`);

  const sequence =
    Math.max(
      0,
      ...executionRecords.map((record) => {
        const continuation = record.metadata.subagentContinuation;
        if (!continuation || typeof continuation !== 'object' || Array.isArray(continuation))
          return 0;
        const value = (continuation as Record<string, unknown>).sequence;
        return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
      }),
    ) + 1;

  return {
    agentId: input.agentId,
    mode,
    agentType,
    description,
    includeCompanyInfo: metadata.includeCompanyInfo === true,
    modelRef,
    ...(metadataString(metadata, 'effort') ? { effort: metadataString(metadata, 'effort') } : {}),
    latestRun,
    ...(latestPhysicalRun
      ? { latestPhysicalRun, childSessionId: latestPhysicalRun.sessionId }
      : {}),
    ...(physicalRuns.find((record) => ACTIVE_RUN_STATUSES.has(record.status))
      ? {
          activePhysicalRun: physicalRuns.find((record) => ACTIVE_RUN_STATUSES.has(record.status))!,
        }
      : {}),
    ...(backgroundTasks.find((record) => ACTIVE_RUN_STATUSES.has(record.status))
      ? {
          activeBackgroundTask: backgroundTasks.find((record) =>
            ACTIVE_RUN_STATUSES.has(record.status),
          )!,
        }
      : {}),
    previousRunId: latestPhysicalRun?.runId ?? latestRun.runId,
    sequence,
  };
}

function compareRunNewestFirst(left: RunRecord, right: RunRecord): number {
  const timestamp = Date.parse(right.requestedAt) - Date.parse(left.requestedAt);
  return timestamp || right.runId.localeCompare(left.runId);
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
