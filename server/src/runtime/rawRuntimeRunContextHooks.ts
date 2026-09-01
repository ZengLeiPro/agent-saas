import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatchTypes.js';
import type { RunContext } from './types.js';
import { createTaskboardSuccessfulCompletionCheck } from '../taskboard/runSuccessfulCompletion.js';

export function buildRuntimeRunContextHooks(
  config: RawRuntimeRunDispatchConfig,
  tenantId: string | undefined,
  userId: string | undefined,
  runId: string,
): Pick<RunContext, 'authorizeModelTurn' | 'checkSuccessfulCompletion'> {
  const billing = config.billingService?.();
  const checkSuccessfulCompletion = createTaskboardSuccessfulCompletionCheck(
    config.taskboard?.executionStore?.(),
    runId,
  );
  return {
    ...(billing && tenantId ? {
      authorizeModelTurn: async () => {
        const decision = await billing.authorizeRun({
          tenantId,
          ...(userId ? { userId } : {}),
          runId,
        });
        if (!decision.ok) throw new Error(`[${decision.code}] ${decision.reason}`);
      },
    } : {}),
    ...(checkSuccessfulCompletion ? { checkSuccessfulCompletion } : {}),
  };
}
