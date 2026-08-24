import type { RuntimeScheduler } from '../runtime/scheduler.js';
import {
  effectiveMaxConcurrentRuns,
  type PgRuntimeSchedulerConfigStore,
  type RuntimeSchedulerCapacityController,
  type RuntimeSessionLockMode,
} from '../runtime/runtimeSchedulerConfigStore.js';

export function createRuntimeSchedulerCapacityController(input: {
  store: PgRuntimeSchedulerConfigStore;
  scheduler: RuntimeScheduler;
  sessionLockMode: RuntimeSessionLockMode;
}): RuntimeSchedulerCapacityController {
  const getSnapshot = async () => {
    const persisted = await input.store.get();
    const effective = effectiveMaxConcurrentRuns(persisted.maxConcurrentRuns, input.sessionLockMode);
    input.scheduler.updateMaxConcurrentRuns(effective);
    input.scheduler.updateExecutionEnabled(persisted.executionEnabled);
    const local = input.scheduler.getCapacitySnapshot();
    return {
      status: 'ok' as const,
      ...persisted,
      sessionLockMode: input.sessionLockMode,
      effectiveMaxConcurrentRuns: effective,
      maxConfigurableConcurrentRuns: input.store.maxConfigurableConcurrentRuns,
      editable: input.sessionLockMode === 'lease',
      inFlightRuns: local.inFlightRuns,
      inFlightBackgroundRuns: local.inFlightBackgroundRuns,
      foregroundReservedRuns: local.foregroundReservedRuns,
    };
  };
  return {
    getSnapshot,
    updateMaxConcurrentRuns: async (value, actor) => {
      if (input.sessionLockMode !== 'lease') {
        throw new Error('dual 迁移阶段固定为 4；切换到 lease 后才能修改并发');
      }
      const persisted = await input.store.update(value, actor);
      input.scheduler.updateMaxConcurrentRuns(persisted.maxConcurrentRuns);
      return getSnapshot();
    },
    updateExecutionMaintenance: async (enabled, reason, actor) => {
      const persisted = await input.store.updateExecutionMaintenance(enabled, reason, actor);
      input.scheduler.updateExecutionEnabled(persisted.executionEnabled);
      return getSnapshot();
    },
  };
}
