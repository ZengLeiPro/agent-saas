import type { RunStore } from '../runStore.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../sessionCatalog.js';
import { supportsSubagentContinuationProtocol } from './subagentContinuationProtocol.js';

export async function resolveSubagentContinuationHistory(input: {
  continuation?: { previousRunId?: string; previousSessionId?: string; sequence?: number };
  sessionCatalog: SessionCatalog;
  runStore?: RunStore;
  agentId: string;
  tenantId: string;
  userId?: string;
  parentSessionId: string;
}): Promise<RuntimeSessionRecord | undefined> {
  if (!input.continuation) return undefined;
  const previousRunId = input.continuation.previousRunId?.trim();
  const previousSessionId = input.continuation.previousSessionId?.trim();
  if (!previousRunId || !previousSessionId) {
    throw new Error('子 Agent continuation 必须同时包含 previousRunId 和 previousSessionId。');
  }
  const previousSession = await input.sessionCatalog.get(previousSessionId);
  if (
    !previousSession ||
    previousSession.deletedAt ||
    previousSession.kind !== 'subagent' ||
    previousSession.tenantId !== input.tenantId ||
    (input.userId && previousSession.userId !== input.userId)
  ) {
    throw new Error('子 Agent continuation 的历史会话不存在、已删除或身份不一致。');
  }
  if (!input.runStore) throw new Error('子 Agent continuation 缺少 durable RunStore。');
  const previousRun = await input.runStore.get(previousRunId);
  if (
    !previousRun ||
    previousRun.sessionId !== previousSessionId ||
    previousRun.tenantId !== input.tenantId ||
    (input.userId &&
      previousRun.userId !== input.userId &&
      previousRun.submitterUserId !== input.userId) ||
    previousRun.metadata.subagent !== true ||
    previousRun.metadata.subagentAgentId !== input.agentId ||
    previousRun.metadata.parentSessionId !== input.parentSessionId ||
    !supportsSubagentContinuationProtocol(previousRun.metadata)
  ) {
    throw new Error('子 Agent continuation 的历史 run 不存在或逻辑身份不一致。');
  }
  return previousSession;
}
