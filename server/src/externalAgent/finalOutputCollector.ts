import type { ExternalExecutionRecord } from '../data/externalConversations/index.js';
import type { RunRecord, RunStore } from '../runtime/runStore.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore } from '../runtime/types.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'orphaned']);

export type PublicExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ExternalExecutionResult {
  executionId: string;
  conversationId: string;
  status: PublicExecutionStatus;
  output?: { text: string };
  error?: { code: string; message: string };
  usage: {
    effectiveModel?: string;
    reasoningEffort?: string;
  };
}

export interface FinalOutputCollectorDeps {
  runStore: Pick<RunStore, 'get'>;
  sessionCatalog: Pick<SessionCatalog, 'get'>;
  eventStoreFor: (transcriptPath: string, tenantId: string) => EventStore;
}

function publicStatus(run: RunRecord): PublicExecutionStatus {
  if (run.status === 'completed') return 'completed';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'failed' || run.status === 'orphaned') return 'failed';
  return 'running';
}

export class FinalOutputCollector {
  constructor(private readonly deps: FinalOutputCollectorDeps) {}

  async collect(execution: ExternalExecutionRecord): Promise<ExternalExecutionResult> {
    if (execution.submissionStatus === 'rejected') {
      return {
        executionId: execution.executionId,
        conversationId: execution.conversationId,
        status: 'failed',
        error: {
          code: execution.errorCode ?? 'submission_rejected',
          message: execution.errorMessage ?? 'Agent submission rejected',
        },
        usage: {},
      };
    }
    if (!execution.runId) {
      return {
        executionId: execution.executionId,
        conversationId: execution.conversationId,
        status: 'running',
        usage: {},
      };
    }
    const run = await this.deps.runStore.get(execution.runId);
    if (
      !run ||
      run.tenantId !== execution.tenantId ||
      run.userId !== execution.serviceAccountUserId
    ) {
      return {
        executionId: execution.executionId,
        conversationId: execution.conversationId,
        status: 'failed',
        error: { code: 'execution_unavailable', message: 'Execution state unavailable' },
        usage: {},
      };
    }
    const status = publicStatus(run);
    const usage = {
      ...(run.actualModelSeen || run.model
        ? { effectiveModel: run.actualModelSeen ?? run.model }
        : {}),
      ...(execution.requestedReasoningEffort
        ? { reasoningEffort: execution.requestedReasoningEffort }
        : {}),
    };
    if (status === 'running') {
      return {
        executionId: execution.executionId,
        conversationId: execution.conversationId,
        status,
        usage,
      };
    }
    if (status !== 'completed') {
      return {
        executionId: execution.executionId,
        conversationId: execution.conversationId,
        status,
        error: {
          code: run.status === 'cancelled' ? 'execution_cancelled' : 'execution_failed',
          message:
            run.statusReason ??
            (run.status === 'cancelled' ? 'Execution cancelled' : 'Execution failed'),
        },
        usage,
      };
    }
    const session = await this.deps.sessionCatalog.get(run.sessionId);
    if (!session || session.tenantId !== execution.tenantId) {
      return {
        executionId: execution.executionId,
        conversationId: execution.conversationId,
        status: 'failed',
        error: { code: 'execution_output_unavailable', message: 'Execution output unavailable' },
        usage,
      };
    }
    const events = await this.deps
      .eventStoreFor(session.transcriptPath, execution.tenantId)
      .list(execution.tenantId, run.sessionId, { includeTypes: ['assistant_message'] });
    const final = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === 'assistant_message' &&
          event.runId === run.runId &&
          typeof event.content === 'string',
      );
    return {
      executionId: execution.executionId,
      conversationId: execution.conversationId,
      status: 'completed',
      output: { text: final?.type === 'assistant_message' ? final.content : '' },
      usage,
    };
  }

  async waitForTerminal(
    execution: ExternalExecutionRecord,
    timeoutMs: number,
  ): Promise<ExternalExecutionResult> {
    const deadline = Date.now() + timeoutMs;
    let result = await this.collect(execution);
    while (result.status === 'running' && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now())));
        timer.unref?.();
      });
      result = await this.collect(execution);
    }
    return result;
  }

  static isTerminal(run: Pick<RunRecord, 'status'>): boolean {
    return TERMINAL.has(run.status);
  }
}
