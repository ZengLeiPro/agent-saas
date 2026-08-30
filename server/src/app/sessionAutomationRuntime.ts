import type { PgPool } from '../runtime/runStoreTypes.js';
import { SessionAutomationTools, SessionAutomationToolProvider } from '../agent/tools/sessionAutomationTools.js';
import { SessionAutomationCommandService } from '../runtime/sessionAutomationCommandService.js';
import {
  RuntimeSchedulerAutomationDispatcher,
  SessionAutomationCoordinator,
} from '../runtime/sessionAutomationCoordinator.js';
import { ModelGoalEvaluator, SessionAutomationEvaluator } from '../runtime/sessionAutomationEvaluator.js';
import { PgSessionAutomationStore } from '../runtime/sessionAutomationStore.js';
import { SessionAutomationTerminalProjector } from '../runtime/sessionAutomationTerminalProjector.js';

export interface SessionAutomationFlags {
  controlEnabled?: boolean;
  executionEnabled?: boolean;
  fixedLoopEnabled?: boolean;
  adaptiveLoopEnabled?: boolean;
  goalEnabled?: boolean;
  evaluatorEnforced?: boolean;
}

export async function createSessionAutomationPersistence(options: {
  pool: PgPool;
  tablePrefix: string;
  runsTable: string;
  flags?: SessionAutomationFlags;
  cancelRun: (runId: string, reason: string) => Promise<void>;
}) {
  const store = new PgSessionAutomationStore(options.pool, options.tablePrefix, options.runsTable);
  await store.init();
  const flags = options.flags ?? {};
  const commandService = new SessionAutomationCommandService(store, {
    controlEnabled: flags.controlEnabled ?? false,
    executionEnabled: flags.executionEnabled ?? false,
    fixedLoopEnabled: flags.fixedLoopEnabled ?? false,
    adaptiveLoopEnabled: flags.adaptiveLoopEnabled ?? false,
    goalEnabled: flags.goalEnabled ?? false,
    evaluatorEnforced: flags.evaluatorEnforced ?? false,
  }, options.cancelRun);
  return { store, commandService };
}

export function createSessionAutomationWorkers(options: {
  store: PgSessionAutomationStore;
  evaluator: ConstructorParameters<typeof ModelGoalEvaluator>[0];
  dispatcher: ConstructorParameters<typeof SessionAutomationCoordinator>[1];
  executionEnabled: () => boolean;
  onError: (error: unknown) => void;
}) {
  const evaluator = new SessionAutomationEvaluator(options.store, new ModelGoalEvaluator(options.evaluator));
  return {
    evaluator,
    provider: new SessionAutomationToolProvider(new SessionAutomationTools(options.store, evaluator)),
    coordinator: new SessionAutomationCoordinator(options.store, options.dispatcher, {
      executionEnabled: options.executionEnabled,
      onError: options.onError,
    }),
    terminalProjector: new SessionAutomationTerminalProjector(options.store),
  };
}

export { RuntimeSchedulerAutomationDispatcher };
