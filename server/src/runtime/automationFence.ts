import type { RunContext } from './types.js';

export function automationFenceFromMetadata(metadata: unknown): RunContext['automationFence'] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>).automationFence;
  if (!value || typeof value !== 'object') return undefined;
  const fence = value as Record<string, unknown>;
  if (
    typeof fence.automationId !== 'string'
    || typeof fence.incarnationId !== 'string'
    || typeof fence.generation !== 'number'
    || typeof fence.specVersion !== 'number'
    || typeof fence.executionId !== 'string'
    || typeof fence.runId !== 'string'
  ) return undefined;
  return {
    automationId: fence.automationId,
    incarnationId: fence.incarnationId,
    generation: fence.generation,
    specVersion: fence.specVersion,
    executionId: fence.executionId,
    runId: fence.runId,
    ...(typeof fence.rootRunId === 'string' ? { rootRunId: fence.rootRunId } : {}),
  };
}
