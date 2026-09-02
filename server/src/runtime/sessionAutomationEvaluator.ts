import { createHash, randomUUID } from 'node:crypto';
import { resolveAutomationBudgetReason } from './sessionAutomationBudgetProgress.js';
export { reduceNoProgress } from './sessionAutomationBudgetProgress.js';
import type pg from 'pg';
import type { BillingService } from '../data/billing/service.js';
import type { ModelProviderOptions } from '../types/index.js';
import type { ModelAdapter, ModelUsage, RunContext } from './types.js';
import { SessionAutomationRuntimeGuard, type AutomationAttemptHandle } from './sessionAutomationRuntimeGuard.js';
import type { PgSessionAutomationStore } from './sessionAutomationStore.js';
import { estimateContextTokens } from './contextBreakdown.js';

export type GoalEvidenceKind = 'event' | 'tool_result' | 'test' | 'build';
export interface GoalEvidenceManifestEntry {
  ref: string;
  kind: GoalEvidenceKind;
  tenantId: string;
  sessionId: string;
  rootAutomationId: string;
  source: { eventId: string; runId: string; toolCallId?: string };
  version: { globalSequence: number; sha256: string };
  freshness: { capturedAt: string; freshThroughGlobalSequence: number };
}
export interface GoalEvidenceManifest {
  version: 1;
  fence: {
    tenantId: string;
    sessionId: string;
    rootAutomationId: string;
    executionId: string;
    incarnationId: string;
    generation: number;
    specVersion: number;
    runId: string;
  };
  entries: GoalEvidenceManifestEntry[];
  canonicalHash: string;
}
/** Evidence consumed by the monotonically versioned automation projection. */
export interface GoalEvidence {
  summary: string;
  evidenceManifest: GoalEvidenceManifest;
  hardGates: {
    runTerminal: boolean;
    noPendingInteraction: boolean;
    noActiveResources: boolean;
    budgetValid: boolean;
  };
}
export type GoalDecision = 'met' | 'continue' | 'blocked' | 'unverifiable';
export interface GoalEvaluatorPort {
  evaluate(input: {
    tenantId: string;
    sessionId: string;
    ownerUserId: string;
    automationId: string;
    executionId: string;
    incarnationId: string;
    generation: number;
    specVersion: number;
    condition: string;
    evidence: GoalEvidence;
    evaluatorRunId?: string;
    executionRunId?: string;
    onAttemptPrepared?: (providerAttemptId: string) => Promise<void>;
  }): Promise<{ decision: GoalDecision; reason: string; confidence: number; usage?: ModelUsage }>;
  settleBillingRun?(tenantId:string,runId:string):Promise<void>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function sha256(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function goalEvidenceManifestHash(manifest: Omit<GoalEvidenceManifest, 'canonicalHash'>): string { return sha256(manifest); }
export function isValidGoalEvidenceManifest(manifest: unknown, expectedHash?: string): manifest is GoalEvidenceManifest {
  if (!manifest || typeof manifest !== 'object') return false;
  const value = manifest as GoalEvidenceManifest;
  if (value.version !== 1 || !value.fence || typeof value.fence !== 'object'
    || typeof value.fence.tenantId !== 'string' || typeof value.fence.sessionId !== 'string'
    || typeof value.fence.rootAutomationId !== 'string' || typeof value.fence.executionId !== 'string'
    || typeof value.fence.incarnationId !== 'string' || !Number.isSafeInteger(value.fence.generation)
    || !Number.isSafeInteger(value.fence.specVersion) || typeof value.fence.runId !== 'string'
    || !Array.isArray(value.entries) || value.entries.length === 0 || typeof value.canonicalHash !== 'string') return false;
  if (value.entries.some(entry => !entry || typeof entry.ref !== 'string' || !['event','tool_result','test','build'].includes(entry.kind)
    || typeof entry.tenantId !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.rootAutomationId !== 'string'
    || !entry.source || typeof entry.source.eventId !== 'string' || typeof entry.source.runId !== 'string'
    || !entry.version || !Number.isSafeInteger(entry.version.globalSequence) || typeof entry.version.sha256 !== 'string'
    || !entry.freshness || typeof entry.freshness.capturedAt !== 'string' || !Number.isSafeInteger(entry.freshness.freshThroughGlobalSequence))) return false;
  const { canonicalHash, ...body } = value;
  return canonicalHash === goalEvidenceManifestHash(body) && (!expectedHash || canonicalHash === expectedHash);
}
export function passesGoalHardGates(evidence: GoalEvidence): boolean {
  return evidence.hardGates.runTerminal
    && evidence.hardGates.noPendingInteraction
    && evidence.hardGates.noActiveResources
    && evidence.hardGates.budgetValid
    && isValidGoalEvidenceManifest(evidence.evidenceManifest);
}

function parsePersistedGoalDecision(payload: unknown): { decision: GoalDecision; reason: string; confidence: number } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const evaluation = (payload as Record<string, unknown>).evaluation;
  if (!evaluation || typeof evaluation !== 'object') return undefined;
  const result = evaluation as Record<string, unknown>;
  if (!['met', 'continue', 'blocked', 'unverifiable'].includes(String(result.decision))
    || typeof result.reason !== 'string' || typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence)) return undefined;
  return {
    decision: result.decision as GoalDecision,
    reason: result.reason,
    confidence: Math.max(0, Math.min(1, result.confidence)),
  };
}

export async function finalizeEvaluatorBilling(finalize:(()=>Promise<void>)|undefined,maxAttempts=3):Promise<boolean>{
  if(!finalize)return true;
  for(let attempt=1;attempt<=maxAttempts;attempt++)try{await finalize();return true;}catch{if(attempt===maxAttempts)return false;}
  return false;
}

export class GoalEvaluationResultUnknownError extends Error {
  constructor(message: string, readonly providerAttemptId: string) {
    super(message);
    this.name = 'GoalEvaluationResultUnknownError';
  }
}

/** Independent utility-model evaluator; it is not the primary automation agent. */
export class ModelGoalEvaluator implements GoalEvaluatorPort {
  constructor(private readonly options: {
    resolveModel: (tenantId: string) => { model: string; connection?: { apiKey?: string; baseUrl?: string }; providerOptions?: ModelProviderOptions } | null;
    createAdapter: (connection: { apiKey?: string; baseUrl?: string } | undefined, options?: ModelProviderOptions) => ModelAdapter;
    billing: () => BillingService | undefined;
    resolveIdentity: (userId: string) => { username: string } | undefined;
    runtimeGuard: SessionAutomationRuntimeGuard;
    executionEnabled: () => boolean;
  }) {}

  async evaluate(input: Parameters<GoalEvaluatorPort['evaluate']>[0]): Promise<{ decision: GoalDecision; reason: string; confidence: number }> {
    const resolved = this.options.resolveModel(input.tenantId);
    if (!resolved) throw new Error('result_unknown:model_unavailable');
    const identity = this.options.resolveIdentity(input.ownerUserId);
    if (!identity) throw new Error('result_unknown:owner_unavailable');
    const billing = await this.options.billing()?.beginUtilityModelRun({
      tenantId: input.tenantId,
      userId: input.ownerUserId,
      username: identity.username,
      sessionId: input.sessionId,
      channel: 'automation_evaluator',
      attribution: {
        rootAutomationId: input.automationId,
        automationExecutionId: input.executionId,
        automationGeneration: input.generation,
      },
    });
    const adapter = this.options.createAdapter(resolved.connection, resolved.providerOptions);
    const evaluatorRunId = input.evaluatorRunId ?? `automation-evaluator-${randomUUID()}`;
    const context: RunContext = {
      runId: evaluatorRunId,
      sessionId: input.sessionId,
      model: resolved.model,
      cwd: '.',
      tenantId: input.tenantId,
      channelContext: { channel: 'web', resumeSessionId: input.sessionId },
      automationFence: {
        automationId: input.automationId,
        incarnationId: input.incarnationId,
        generation: input.generation,
        specVersion: input.specVersion,
        executionId: input.executionId,
        runId: evaluatorRunId,
        ...(input.executionRunId ? { rootRunId: input.executionRunId } : {}),
      },
      ...(billing ? { authorizeModelTurn: billing.beforeModelCall } : {}),
    };
    const closeBilling=async():Promise<boolean>=>{const closed=await finalizeEvaluatorBilling(billing?.finalize);
      if(!closed&&billing)await this.options.runtimeGuard.ensureBillingClosure(context,billing.runId);return closed;};
    let text = '';
    let completed = false;
    let usage: ModelUsage | undefined;
    let attempt: AutomationAttemptHandle | undefined;
    let transportStarted = false;
    try {
      const evaluationMessages = [
        { role: 'system' as const, content: 'You are an independent completion verifier. Never trust a claimant assertion without evidence. Return only JSON: {"decision":"met|continue|blocked|unverifiable","reason":"...","confidence":0..1}.' },
        { role: 'user' as const, content: JSON.stringify({ completionCondition: input.condition, evidence: input.evidence }) },
      ];
      if (this.options.executionEnabled() === false) throw new Error('execution_disabled');
      attempt = await this.options.runtimeGuard.beforeModel(context, `goal-evaluation:${input.executionId}`, {
        model: resolved.model, inputTokens: estimateContextTokens(evaluationMessages), maxOutputTokens: 500, purpose: 'goal_evaluation',
      });
      if (attempt) await input.onAttemptPrepared?.(attempt.providerAttemptId);
      // Recheck after durable preparation and immediately before transport. If the switch changed,
      // the catch path releases the reservation without sending provider bytes.
      if (this.options.executionEnabled() === false) throw new Error('execution_disabled');
      // Re-fence after billing authorization and in the adapter hook before every provider attempt.
      await context.authorizeModelTurn?.();
      if (this.options.executionEnabled() === false) throw new Error('execution_disabled');
      await this.options.runtimeGuard.beforeModelTransport(context, attempt, true);
      let providerTransportAuthorized = false;
      const transportContext = { ...context, authorizeModelTurn: async () => {
        await this.options.runtimeGuard.beforeModelTransport(context, attempt, !providerTransportAuthorized);
        providerTransportAuthorized = true;
        transportStarted = true;
      } };
      for await (const event of adapter.stream({
        model: resolved.model,
        messages: evaluationMessages,
        tools: [],
        toolChoice: 'none',
        maxOutputTokens: 500,
        signal: new AbortController().signal,
      }, transportContext)) {
        if (event.type === 'text_delta') text += event.content;
        if (event.type === 'completed') {
          completed = true;
          text = event.content || text;
          usage = event.usage;
          if (event.usage && billing) await billing.recordUsage(resolved.model, event.usage);
          if (event.terminalStatus && event.terminalStatus !== 'completed') throw new Error(`result_unknown:${event.terminalStatus}`);
        }
      }
      if (!completed) throw new Error('result_unknown:no_terminal_result');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!['met', 'continue', 'blocked', 'unverifiable'].includes(String(parsed.decision))
        || typeof parsed.reason !== 'string' || typeof parsed.confidence !== 'number'
        || !Number.isFinite(parsed.confidence)) {
        throw new Error('result_unknown:invalid_evaluator_json');
      }
      const decision = {
        decision: parsed.decision as GoalDecision,
        reason: parsed.reason,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
      };
      await this.options.runtimeGuard.finishModel(context, attempt, usage, undefined, { evaluation: decision });
      // The completed attempt/result payload is the durable replay authority. Billing usage
      // is already in its durable ledger/outbox; fail closed after bounded settlement retries.
      if(!await closeBilling())throw new GoalEvaluationResultUnknownError('billing_finalize_failed',attempt!.providerAttemptId);
      return { ...decision, ...(usage ? { usage } : {}) };
    } catch (error) {
      if(error instanceof GoalEvaluationResultUnknownError)throw error;
      if (attempt) {
        if (transportStarted) {
          await this.options.runtimeGuard.finishModel(context, attempt, usage, error);
          await closeBilling();
          throw new GoalEvaluationResultUnknownError(
            error instanceof Error ? error.message : String(error),
            attempt.providerAttemptId,
          );
        }
        await this.options.runtimeGuard.releaseModel(
          context,
          attempt,
          error instanceof Error ? error.message : String(error),
        );
      }
      await closeBilling();
      throw error;
    }
  }

  async settleBillingRun(tenantId:string,runId:string):Promise<void>{const billing=this.options.billing();if(!billing)throw new Error('billing_service_unavailable');await billing.store.settleRunDebit(tenantId,runId);}
}

export class SessionAutomationEvaluator {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly eventsTable: string;

  constructor(
    readonly store: PgSessionAutomationStore,
    readonly evaluator: GoalEvaluatorPort,
    readonly executionEnabled: () => boolean,
  ) {
    this.eventsTable = `${store.tablePrefix}_events`;
  }

  private async resolveHardGates(client: pg.Pool | pg.PoolClient, input: {
    tenantId: string;
    sessionId: string;
    automationId: string;
    executionId: string;
    runId: string;
  }): Promise<GoalEvidence['hardGates']> {
    const execution = await client.query(
      `SELECT state FROM ${this.store.tables.executions}
        WHERE execution_id=$1 AND tenant_id=$2 AND session_id=$3 AND run_id=$4`,
      [input.executionId, input.tenantId, input.sessionId, input.runId],
    );
    const active = await client.query(
      `SELECT COUNT(*)::int AS count FROM ${this.store.runsTable}
        WHERE tenant_id=$1 AND session_id=$2 AND run_id<>$3 AND status IN ('pending','running')`,
      [input.tenantId, input.sessionId, input.runId],
    );
    const pendingInteraction = await client.query(
      `SELECT EXISTS(
         SELECT 1 FROM ${this.eventsTable} requested
          WHERE requested.tenant_id=$1 AND requested.session_id=$2 AND requested.event_type='interaction_requested'
            AND NOT EXISTS(
              SELECT 1 FROM ${this.eventsTable} resolved
               WHERE resolved.tenant_id=requested.tenant_id AND resolved.session_id=requested.session_id
                 AND resolved.event_type='interaction_resolved'
                 AND resolved.event_json->>'interactionId'=requested.event_json->>'interactionId'
            )
       ) AS pending`,
      [input.tenantId, input.sessionId],
    );
    const durableInteractions = await client.query(
      `SELECT EXISTS(
         SELECT 1 FROM ${this.store.tables.interactions}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND state IN ('prepared','active','result_unknown','reconcile')
       ) AS pending`,
      [input.tenantId, input.sessionId, input.automationId],
    );
    const durableResources = await client.query(
      `SELECT EXISTS(
         SELECT 1 FROM ${this.store.tables.backgroundResources}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND state IN ('prepared','active','release_pending','result_unknown','reconcile')
       ) AS active`,
      [input.tenantId, input.sessionId, input.automationId],
    );
    const automation = await client.query(
      `SELECT limit_hit_reason FROM ${this.store.tables.automations}
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,
      [input.tenantId, input.sessionId, input.automationId],
    );
    const budgetReason = await resolveAutomationBudgetReason({
      client,
      tables: this.store.tables,
      tablePrefix: this.store.tablePrefix,
      runsTable: this.store.runsTable,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      automationId: input.automationId,
    });
    return {
      runTerminal: execution.rows[0]?.state === 'terminal',
      noPendingInteraction: pendingInteraction.rows[0]?.pending !== true
        && durableInteractions.rows[0]?.pending !== true,
      noActiveResources: Number(active.rows[0]?.count ?? 0) === 0
        && durableResources.rows[0]?.active !== true,
      budgetValid: !automation.rows[0]?.limit_hit_reason && (budgetReason === undefined || budgetReason.startsWith('max_')),
    };
  }

  private get runtimeEventsTable(): string { return `${this.store.tablePrefix}_events`; }

  private classifyEvidenceEvent(event: Record<string, unknown>, toolInputs: Map<string, { name: string; command?: string }>): GoalEvidenceKind | undefined {
    // Assistant prose is model-authored progress narration, never host evidence of completion.
    if (event.type !== 'tool_result' || event.isError === true || typeof event.toolCallId !== 'string') return undefined;
    const call = toolInputs.get(event.toolCallId);
    if (!call || call.name !== event.toolName) return undefined;
    if (call.name !== 'Shell') return 'tool_result';
    const exitCode = (event.metadata as Record<string, unknown> | undefined)?.exitCode;
    if (exitCode !== 0) return undefined;
    const command = (call.command ?? '').trim();
    // Shell input is model-authored. Only attest a direct, single recognized test/build
    // invocation whose success is host-derived; substring matches such as `echo test`
    // and compound commands are deliberately ordinary tool evidence.
    if (!command || /(?:&&|\|\||[;|`<>\n]|\$\()/u.test(command)) return 'tool_result';
    const packagePrefix = String.raw`(?:pnpm(?:\s+(?:-[A-Za-z]|--filter)\s+\S+)*\s+|npm\s+|yarn\s+|bun\s+)`;
    if (new RegExp(`^(?:${packagePrefix}(?:test|typecheck|run\\s+(?:test|typecheck)|exec\\s+(?:vitest|jest|tsc))\\b|(?:npx\\s+)?(?:vitest|jest|pytest|tsc)\\b|cargo\\s+test\\b|go\\s+test\\b)`, 'i').test(command)) return 'test';
    if (new RegExp(`^(?:${packagePrefix}(?:build|run\\s+build|exec\\s+(?:vite|webpack|rollup)\\s+build)\\b|(?:npx\\s+)?(?:vite|webpack|rollup)\\s+build\\b|cargo\\s+build\\b)`, 'i').test(command)) return 'build';
    return 'tool_result';
  }

  async freezeEvidenceManifest(client: pg.Pool | pg.PoolClient, input: {
    tenantId: string; sessionId: string; automationId: string; executionId: string; runId: string;
    incarnationId: string; generation: number; specVersion: number; evidenceRefs: string[];
  }): Promise<{ manifest?: GoalEvidenceManifest; reason?: string }> {
    const normalized: string[] = [];
    for (const raw of input.evidenceRefs) {
      const match = /^\s*event:([^\s]+)\s*$/i.exec(raw);
      if (!match) return { reason: 'evidence_ref_invalid_format' };
      const ref = `event:${match[1]}`;
      if (!normalized.includes(ref)) normalized.push(ref);
    }
    if (!normalized.length) return { reason: 'evidence_ref_empty' };
    const ids = normalized.map(ref => ref.slice('event:'.length));
    const execution = await client.query(
      `SELECT 1 FROM ${this.store.tables.executions}
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4 AND run_id=$5`,
      [input.tenantId, input.sessionId, input.automationId, input.executionId, input.runId],
    );
    if (!execution.rowCount) return { reason: 'evidence_ref_outside_fence' };
    const events = await client.query(
      `SELECT global_sequence,event_id,event_json,timestamp
         FROM ${this.runtimeEventsTable}
        WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3
        ORDER BY global_sequence`,
      [input.tenantId, input.sessionId, input.runId],
    );
    const byId = new Map<string, { global_sequence: string | number; event_id: string; event_json: Record<string, unknown>; timestamp: Date | string }>();
    const toolInputs = new Map<string, { name: string; command?: string }>();
    let freshThrough = 0;
    const mutationSequences: number[] = [];
    for (const row of events.rows) {
      const sequence = Number(row.global_sequence);
      if (!Number.isSafeInteger(sequence)) return { reason: 'evidence_source_version_invalid' };
      freshThrough = Math.max(freshThrough, sequence);
      byId.set(String(row.event_id), row);
      const event = row.event_json as Record<string, unknown>;
      if (event.type === 'assistant_tool_calls' && event.runId === input.runId && event.sessionId === input.sessionId && Array.isArray(event.toolCalls)) {
        for (const rawCall of event.toolCalls) {
          const call = rawCall as Record<string, unknown>;
          if (typeof call.id !== 'string' || typeof call.name !== 'string' || typeof call.arguments !== 'string') continue;
          let command: string | undefined;
          try { const parsed = JSON.parse(call.arguments) as Record<string, unknown>; if (typeof parsed.command === 'string') command = parsed.command; } catch { /* unsupported input is fail-closed below */ }
          toolInputs.set(call.id, { name: call.name, ...(command ? { command } : {}) });
        }
      }
    }
    for (const row of events.rows) {
      const event = row.event_json as Record<string, unknown>;
      if (event.type === 'tool_result' && event.isError !== true && ['Write','Edit','Shell'].includes(String(event.toolName))) {
        mutationSequences.push(Number(row.global_sequence));
      }
    }
    const capturedAt = new Date().toISOString();
    const entries: GoalEvidenceManifestEntry[] = [];
    for (let index = 0; index < ids.length; index++) {
      const row = byId.get(ids[index]!);
      if (!row) return { reason: 'evidence_ref_not_found' };
      const event = row.event_json;
      if (event.runId !== input.runId || event.sessionId !== input.sessionId) return { reason: 'evidence_ref_outside_fence' };
      const kind = this.classifyEvidenceEvent(event, toolInputs);
      if (!kind) return { reason: 'evidence_ref_unsupported' };
      const sequence = Number(row.global_sequence);
      if ((kind === 'test' || kind === 'build') && mutationSequences.some(value => value > sequence)) return { reason: 'evidence_ref_stale' };
      entries.push({
        ref: normalized[index]!, kind, tenantId: input.tenantId, sessionId: input.sessionId,
        rootAutomationId: input.automationId,
        source: { eventId: String(row.event_id), runId: input.runId,
          ...(typeof event.toolCallId === 'string' ? { toolCallId: event.toolCallId } : {}) },
        version: { globalSequence: sequence, sha256: sha256(event) },
        freshness: { capturedAt, freshThroughGlobalSequence: freshThrough },
      });
    }
    const body = {
      version: 1 as const,
      fence: {
        tenantId: input.tenantId, sessionId: input.sessionId, rootAutomationId: input.automationId,
        executionId: input.executionId, incarnationId: input.incarnationId, generation: input.generation,
        specVersion: input.specVersion, runId: input.runId,
      },
      entries,
    };
    return { manifest: { ...body, canonicalHash: goalEvidenceManifestHash(body) } };
  }

  async validateEvidenceManifest(client: pg.Pool | pg.PoolClient, manifest: unknown, expectedHash: string, input: {
    tenantId: string; sessionId: string; automationId: string; executionId: string; incarnationId: string;
    generation: number; specVersion: number; runId: string; throughGlobalSequence?: number;
  }): Promise<{ valid: boolean; reason?: string }> {
    if (!isValidGoalEvidenceManifest(manifest, expectedHash)) return { valid: false, reason: 'evidence_manifest_tampered' };
    const frozen = manifest as GoalEvidenceManifest;
    if (frozen.fence.tenantId !== input.tenantId || frozen.fence.sessionId !== input.sessionId
      || frozen.fence.rootAutomationId !== input.automationId || frozen.fence.executionId !== input.executionId
      || frozen.fence.incarnationId !== input.incarnationId || frozen.fence.generation !== input.generation
      || frozen.fence.specVersion !== input.specVersion || frozen.fence.runId !== input.runId) {
      return { valid: false, reason: 'evidence_manifest_fence_mismatch' };
    }
    for (const entry of frozen.entries) {
      if (entry.tenantId !== input.tenantId || entry.sessionId !== input.sessionId
        || entry.rootAutomationId !== input.automationId || entry.source.runId !== input.runId) return { valid: false, reason: 'evidence_ref_outside_fence' };
      const row = await client.query(
        `SELECT global_sequence,event_json FROM ${this.runtimeEventsTable}
          WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND event_id=$4`,
        [input.tenantId, input.sessionId, input.runId, entry.source.eventId],
      );
      if (!row.rowCount) return { valid: false, reason: 'evidence_ref_not_found' };
      if (Number(row.rows[0].global_sequence) !== entry.version.globalSequence || sha256(row.rows[0].event_json) !== entry.version.sha256) {
        return { valid: false, reason: 'evidence_source_changed' };
      }
      if (entry.kind === 'test' || entry.kind === 'build') {
        const stale = await client.query(
          `SELECT 1 FROM ${this.runtimeEventsTable}
            WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND global_sequence>$4
              AND ($5::bigint IS NULL OR global_sequence<=$5)
              AND event_type='tool_result' AND COALESCE((event_json->>'isError')::boolean,false)=false
              AND event_json->>'toolName' IN ('Write','Edit','Shell') LIMIT 1`,
          [input.tenantId, input.sessionId, input.runId, entry.version.globalSequence, input.throughGlobalSequence ?? null],
        );
        if (stale.rowCount) return { valid: false, reason: 'evidence_ref_stale' };
      }
    }
    return { valid: true };
  }

  private async validateEvaluationEvidence(client: pg.Pool | pg.PoolClient, job: {
    tenant_id: string; session_id: string; automation_id: string; execution_id: string;
    incarnation_id: string; generation: string | number; spec_version: string | number;
    decision_epoch: string | number; run_id: string; evidence_manifest_hash?: string;
    evidence_manifest?: GoalEvidenceManifest; evidence?: GoalEvidence;
  }, evidence: GoalEvidence): Promise<{ valid: boolean; reason?: string }> {
    if (!job.evidence_manifest_hash || !job.evidence_manifest
      || canonicalJson(job.evidence_manifest) !== canonicalJson(evidence.evidenceManifest)) {
      return { valid: false, reason: 'evidence_manifest_tampered' };
    }
    const candidate = await client.query(
      `SELECT summary,evidence_manifest,evidence_manifest_hash FROM ${this.store.tables.goalCompletionCandidates}
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4
          AND incarnation_id=$5 AND generation=$6 AND spec_version=$7 AND run_id=$8 AND projected_at IS NOT NULL`,
      [job.tenant_id, job.session_id, job.automation_id, job.execution_id, job.incarnation_id,
        job.generation, job.spec_version, job.run_id],
    );
    const frozen = candidate.rows[0];
    if (!frozen || String(frozen.evidence_manifest_hash ?? '') !== job.evidence_manifest_hash
      || canonicalJson(frozen.evidence_manifest) !== canonicalJson(job.evidence_manifest)
      || frozen.summary !== evidence.summary) {
      return { valid: false, reason: 'evidence_candidate_mismatch' };
    }
    return this.validateEvidenceManifest(client, evidence.evidenceManifest, job.evidence_manifest_hash, {
      tenantId: job.tenant_id, sessionId: job.session_id, automationId: job.automation_id,
      executionId: job.execution_id, incarnationId: job.incarnation_id,
      generation: Number(job.generation), specVersion: Number(job.spec_version), runId: job.run_id,
      throughGlobalSequence: Number(job.decision_epoch),
    });
  }

  async nominate(input: {
    tenantId: string;
    sessionId: string;
    automationId: string;
    executionId: string;
    runId: string;
    incarnationId: string;
    generation: number;
    specVersion: number;
    summary: string;
    evidenceRefs: string[];
  }): Promise<{ queued: boolean; reason?: string }> {
    if (input.evidenceRefs.length === 0) return { queued: false, reason: 'evidence_ref_empty' };
    return this.store.tx(async client => {
      const snapshot = await this.store.getLocked(client, input.tenantId, input.sessionId, input.automationId);
      if (!snapshot || snapshot.spec.kind !== 'goal' || snapshot.status !== 'active'
        || snapshot.activeRunId !== input.runId || snapshot.incarnationId !== input.incarnationId
        || snapshot.generation !== input.generation || snapshot.specVersion !== input.specVersion) {
        return { queued: false, reason: 'stale_fence' };
      }
      const execution = await client.query(
        `SELECT 1 FROM ${this.store.tables.executions}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4
            AND run_id=$5 AND incarnation_id=$6 AND generation=$7 AND spec_version=$8
            AND state<>'terminal'`,
        [input.tenantId, input.sessionId, input.automationId, input.executionId, input.runId,
          input.incarnationId, input.generation, input.specVersion],
      );
      if (!execution.rowCount) return { queued: false, reason: 'stale_fence' };
      const frozen = await this.freezeEvidenceManifest(client, input);
      if (!frozen.manifest) return { queued: false, reason: frozen.reason ?? 'evidence_ref_unsupported' };
      if (!this.executionEnabled()) return { queued: false, reason: 'execution_disabled' };
      const inserted = await client.query(
        `INSERT INTO ${this.store.tables.goalCompletionCandidates}
          (candidate_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,run_id,summary,evidence_refs,evidence_manifest,evidence_manifest_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(execution_id) DO NOTHING`,
        [randomUUID(), input.tenantId, input.sessionId, input.automationId, input.executionId,
          input.incarnationId, input.generation, input.specVersion, input.runId, input.summary,
          JSON.stringify(frozen.manifest.entries.map(entry => entry.ref)), JSON.stringify(frozen.manifest), frozen.manifest.canonicalHash],
      );
      const authoritative = inserted.rowCount || (await client.query(
        `SELECT 1 FROM ${this.store.tables.goalCompletionCandidates} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4 AND incarnation_id=$5 AND generation=$6 AND spec_version=$7 AND run_id=$8`,
        [input.tenantId,input.sessionId,input.automationId,input.executionId,input.incarnationId,input.generation,input.specVersion,input.runId])).rowCount;
      if (!authoritative) return { queued: false, reason: 'candidate_exists' };
      // The locked transaction leaves the candidate as the only authoritative successor.
      await this.store.supersedeActiveWakeupsLocked(client,snapshot,'goal_candidate_nominated');
      return { queued: true };
    });
  }
  private async applyDecisionLocked(
    client: pg.PoolClient,
    job: {
      evaluation_id: string; tenant_id: string; session_id: string; automation_id: string;
      execution_id: string; incarnation_id: string; generation: string | number;
      spec_version: string | number; decision_epoch: string | number; run_id: string;
      evidence_manifest_hash?: string; evidence_manifest?: GoalEvidenceManifest;
    },
    evidence: GoalEvidence,
    result: { decision: GoalDecision; reason: string; confidence: number },
    authority: { leaseToken: string } | { providerAttemptId: string },
  ): Promise<boolean> {
    const current = await this.store.getLocked(client, job.tenant_id, job.session_id, job.automation_id);
    const latestGates = await this.resolveHardGates(client, {
      tenantId: job.tenant_id,
      sessionId: job.session_id,
      automationId: job.automation_id,
      executionId: job.execution_id,
      runId: job.run_id,
    });
    const fenced = current
      && current.incarnationId === job.incarnation_id
      && current.generation === Number(job.generation)
      && current.specVersion === Number(job.spec_version)
      && current.status === 'active';
    const manifestValidation = await this.validateEvaluationEvidence(client, job, evidence);
    const decision = result.decision === 'met'
      && (!manifestValidation.valid || !passesGoalHardGates({ ...evidence, hardGates: latestGates }) || result.confidence < 0.8)
      ? { ...result, decision: 'unverifiable' as const, reason: 'final_gate_or_confidence_failed' }
      : result;
    const updated = 'leaseToken' in authority
      ? await client.query(
        `UPDATE ${this.store.tables.evaluations}
            SET state=$2,decision=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE evaluation_id=$1 AND lease_token=$4 AND state='claimed'`,
        [job.evaluation_id, decision.decision, JSON.stringify(decision), authority.leaseToken],
      )
      : await client.query(
        `UPDATE ${this.store.tables.evaluations}
            SET state=$2,decision=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE evaluation_id=$1 AND provider_attempt_id=$4
            AND state IN ('claimed','result_unknown')`,
        [job.evaluation_id, decision.decision, JSON.stringify(decision), authority.providerAttemptId],
      );
    if (!updated.rowCount) return false;
    if (!fenced) return true;
    if (decision.decision === 'met') {
      await this.store.beginTerminalDrainLocked(client,current!,'completed','goal_met');
    } else if (decision.decision === 'continue') {
      await this.store.supersedeActiveWakeupsLocked(client,current!,'goal_evaluator_continue');
      const fence=[job.tenant_id,job.session_id,job.automation_id,job.incarnation_id,job.generation,job.spec_version];
      const persisted=await client.query(`SELECT continuation_epoch FROM ${this.store.tables.automations} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4 AND generation=$5 AND spec_version=$6 FOR UPDATE`,fence);
      const epoch=Number(persisted.rows[0]?.continuation_epoch)+1;
      if(!Number.isSafeInteger(epoch)||epoch<1)throw new Error('invalid_wakeup_continuation_epoch');
      await this.store.scheduleTx(client,{
        tenantId:job.tenant_id,sessionId:job.session_id,automationId:job.automation_id,incarnationId:job.incarnation_id,
        generation:Number(job.generation),specVersion:Number(job.spec_version),continuationEpoch:epoch,
        triggerKey:`goal:${job.automation_id}:g${job.generation}:e${epoch}:evaluation:${job.evaluation_id}`,
        dueAt:new Date(),payload:{evaluationId:job.evaluation_id,reason:decision.reason},
      });
      await client.query(`UPDATE ${this.store.tables.automations} SET phase='waiting',continuation_epoch=$7,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4 AND generation=$5 AND spec_version=$6 AND status='active' AND phase='evaluating'`,[...fence,epoch]);
    } else {
      await client.query(
        `UPDATE ${this.store.tables.automations}
            SET status='blocked',phase='idle',last_error=$7,control_version=control_version+1,
                projection_version=projection_version+1,updated_at=now()
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND incarnation_id=$4 AND generation=$5 AND spec_version=$6 AND status='active'`,
        [job.tenant_id, job.session_id, job.automation_id, job.incarnation_id,
          job.generation, job.spec_version, decision.reason],
      );
    }
    const next=await this.store.getLocked(client,job.tenant_id,job.session_id,job.automation_id);
    if(next)await this.store.event(client,next,'automation_state_changed',{evaluationId:job.evaluation_id,decision:decision.decision,snapshot:next});
    return true;
  }
  async reconcileUnknown(): Promise<number> {
    let restored = 0;
    // Restart-safe billing close: retry durable lifecycle rows before replaying a completed verdict.
    if(this.evaluator.settleBillingRun){const pendingBilling=await this.store.pool.query(
      `SELECT * FROM ${this.store.tables.lifecycleWork} WHERE object_type='run' AND action='reconcile' AND state IN ('pending','waiting','result_unknown','dead') ORDER BY created_at LIMIT 25`);
      for(const row of pendingBilling.rows)try{await this.evaluator.settleBillingRun(row.tenant_id,row.object_id);await this.store.applyAuthoritativeLifecycleReceipt({
        workId:row.work_id,tenantId:row.tenant_id,sessionId:row.session_id,automationId:row.automation_id,incarnationId:row.incarnation_id,generation:Number(row.generation),
        objectIncarnationId:row.object_incarnation_id,objectGeneration:Number(row.object_generation),objectType:'run',objectId:row.object_id,action:'reconcile',
        receiptKey:`billing:${row.work_id}`,authority:'server_internal',outcome:'completed',payload:{billingClosure:'settled'},
      });}catch{/* keep durable work reachable for coordinator/restart retry */}
    }
    const completed = await this.store.pool.query(
      `SELECT e.evaluation_id,e.tenant_id,e.session_id,e.automation_id,e.execution_id,e.incarnation_id,
              e.generation,e.spec_version,e.decision_epoch,e.evidence,e.evidence_manifest,e.evidence_manifest_hash,x.run_id,p.provider_attempt_id,p.result_payload
         FROM ${this.store.tables.evaluations} e
         JOIN ${this.store.tables.executions} x
           ON x.tenant_id=e.tenant_id AND x.session_id=e.session_id AND x.automation_id=e.automation_id
          AND x.execution_id=e.execution_id AND x.incarnation_id=e.incarnation_id
          AND x.generation=e.generation AND x.spec_version=e.spec_version
         JOIN ${this.store.tables.providerAttempts} p
           ON p.provider_attempt_id=e.provider_attempt_id AND p.tenant_id=e.tenant_id
          AND p.session_id=e.session_id AND p.automation_id=e.automation_id
          AND p.execution_id=e.execution_id AND p.incarnation_id=e.incarnation_id
          AND p.generation=e.generation AND p.run_id=x.run_id
        WHERE ((e.state='claimed' AND e.lease_expires_at<now()) OR e.state='result_unknown')
          AND p.operation='goal-evaluation:'||e.execution_id::text
          AND p.state='completed'
          AND NOT EXISTS(SELECT 1 FROM ${this.store.tables.lifecycleWork} billing
            WHERE billing.tenant_id=e.tenant_id AND billing.session_id=e.session_id AND billing.automation_id=e.automation_id
              AND billing.incarnation_id=e.incarnation_id AND billing.generation=e.generation
              AND billing.object_type='run' AND billing.action='reconcile' AND billing.state<>'completed')`,
    );
    for (const job of completed.rows) {
      restored += await this.store.tx(async client => {
        const locked = await client.query(
          `SELECT p.state,p.result_payload
             FROM ${this.store.tables.evaluations} e
             JOIN ${this.store.tables.providerAttempts} p ON p.provider_attempt_id=e.provider_attempt_id
            WHERE e.evaluation_id=$1 AND e.provider_attempt_id=$2
              AND ((e.state='claimed' AND e.lease_expires_at<now()) OR e.state='result_unknown')
              AND p.tenant_id=$3 AND p.session_id=$4 AND p.automation_id=$5
              AND p.incarnation_id=$6 AND p.generation=$7 AND p.execution_id=$8 AND p.run_id=$9
              AND p.operation='goal-evaluation:'||e.execution_id::text AND p.state='completed'
            FOR UPDATE OF e,p`,
          [job.evaluation_id, job.provider_attempt_id, job.tenant_id, job.session_id,
            job.automation_id, job.incarnation_id, job.generation, job.execution_id, job.run_id],
        );
        if (!locked.rowCount) return 0;
        const result = parsePersistedGoalDecision(locked.rows[0].result_payload);
        if (!result) {
          const evaluation = await client.query(
            `UPDATE ${this.store.tables.evaluations}
                SET state='unverifiable',decision=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
              WHERE evaluation_id=$1 AND provider_attempt_id=$2
                AND state IN ('claimed','result_unknown')`,
            [job.evaluation_id, job.provider_attempt_id, JSON.stringify({
              decision: 'unverifiable', reason: 'completed_attempt_result_unavailable', confidence: 0,
            })],
          );
          if (!evaluation.rowCount) return 0;
          await client.query(
            `UPDATE ${this.store.tables.automations}
                SET status='reconcile_required',phase='waiting',next_wakeup_at=NULL,last_error=$7,
                    projection_version=projection_version+1,updated_at=now()
              WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
                AND incarnation_id=$4 AND generation=$5 AND spec_version=$6 AND status='active'`,
            [job.tenant_id, job.session_id, job.automation_id, job.incarnation_id,
              job.generation, job.spec_version, 'completed_attempt_result_unavailable'],
          );
          return 1;
        }
        return await this.applyDecisionLocked(client, job, job.evidence as GoalEvidence, result, {
          providerAttemptId: job.provider_attempt_id,
        }) ? 1 : 0;
      });
    }

    restored += await this.store.tx(async client => {
      const unknown = await client.query(
        `UPDATE ${this.store.tables.evaluations} e
            SET state='result_unknown',provider_attempt_id=p.provider_attempt_id,
                lease_token=NULL,lease_expires_at=NULL,updated_at=now()
           FROM ${this.store.tables.providerAttempts} p
          WHERE e.state='claimed' AND e.lease_expires_at<now()
            AND p.tenant_id=e.tenant_id AND p.session_id=e.session_id AND p.automation_id=e.automation_id
            AND p.execution_id=e.execution_id AND p.incarnation_id=e.incarnation_id AND p.generation=e.generation
            AND p.operation='goal-evaluation:'||e.execution_id::text
            AND p.state IN ('prepared','dispatched','result_unknown','reconcile')
          RETURNING e.evaluation_id`,
      );
      // Also sweep already-handled result_unknown rows: evaluator error handling can
      // persist the evaluation state before a worker dies, so reconciliation authority
      // must not depend on this invocation having performed the claimed transition.
      await client.query(
          `UPDATE ${this.store.tables.providerAttempts} p
              SET state='result_unknown',version=p.version+1,lease_token=NULL,lease_expires_at=NULL,
                  last_error=COALESCE(p.last_error,'evaluator_lease_expired_after_admission'),updated_at=now()
             FROM ${this.store.tables.evaluations} e
            WHERE e.provider_attempt_id=p.provider_attempt_id AND e.state='result_unknown'
              AND p.state IN ('prepared','dispatched')`,
        );
        await client.query(
          `UPDATE ${this.store.tables.budgetReservations} r
              SET state='result_unknown',version=r.version+1,updated_at=now()
             FROM ${this.store.tables.providerAttempts} p,${this.store.tables.evaluations} e
            WHERE e.provider_attempt_id=p.provider_attempt_id AND e.state='result_unknown'
              AND r.tenant_id=p.tenant_id AND r.idempotency_key=p.idempotency_key AND r.state='reserved'`,
        );
        await client.query(
          `UPDATE ${this.store.tables.automations} a
              SET status='reconcile_required',phase='waiting',next_wakeup_at=NULL,projection_version=projection_version+1,updated_at=now()
             FROM ${this.store.tables.evaluations} e
             JOIN ${this.store.tables.executions} x
               ON x.tenant_id=e.tenant_id AND x.session_id=e.session_id AND x.automation_id=e.automation_id
              AND x.execution_id=e.execution_id AND x.incarnation_id=e.incarnation_id
              AND x.generation=e.generation AND x.spec_version=e.spec_version
             JOIN ${this.store.tables.providerAttempts} p
               ON p.provider_attempt_id=e.provider_attempt_id AND p.tenant_id=e.tenant_id
              AND p.session_id=e.session_id AND p.automation_id=e.automation_id
              AND p.execution_id=e.execution_id AND p.incarnation_id=e.incarnation_id
              AND p.generation=e.generation AND p.run_id=x.run_id
            WHERE e.state='result_unknown' AND p.state IN ('result_unknown','reconcile')
              AND a.tenant_id=e.tenant_id AND a.session_id=e.session_id AND a.automation_id=e.automation_id
              AND a.incarnation_id=e.incarnation_id AND a.generation=e.generation AND a.spec_version=e.spec_version
              AND a.status='active'`,
        );
      const retryable = await client.query(
        `UPDATE ${this.store.tables.evaluations} e
            SET state='pending',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE e.state='claimed' AND e.lease_expires_at<now()
            AND NOT EXISTS(
              SELECT 1 FROM ${this.store.tables.providerAttempts} p
               WHERE p.tenant_id=e.tenant_id AND p.session_id=e.session_id AND p.automation_id=e.automation_id
                 AND p.incarnation_id=e.incarnation_id AND p.generation=e.generation AND p.execution_id=e.execution_id
                 AND p.operation='goal-evaluation:'||e.execution_id::text
                 AND p.state IN ('prepared','dispatched','result_unknown','reconcile')
            )
          RETURNING e.evaluation_id`,
      );
      return (unknown.rowCount ?? 0) + (retryable.rowCount ?? 0);
    });
    return restored;
  }

  private async checkInBlocked(): Promise<number> {
    const blocked = await this.store.pool.query(
      `SELECT e.evaluation_id,e.tenant_id,e.session_id,e.automation_id,e.execution_id,e.incarnation_id,
              e.generation,e.spec_version,e.decision_epoch,e.evidence,e.evidence_manifest,e.evidence_manifest_hash,x.run_id
         FROM ${this.store.tables.evaluations} e
         JOIN ${this.store.tables.executions} x ON x.execution_id=e.execution_id
        WHERE e.state='blocked' AND e.decision->>'reason'='hard_gate'`,
    );
    let restored = 0;
    for (const job of blocked.rows) {
      restored += await this.store.tx(async client => {
        const current = await this.store.getLocked(client, job.tenant_id, job.session_id, job.automation_id);
        if (!current || current.status !== 'active' || current.incarnationId !== job.incarnation_id
          || current.generation !== Number(job.generation) || current.specVersion !== Number(job.spec_version)) return 0;
        const gates = await this.resolveHardGates(client, {
          tenantId: job.tenant_id, sessionId: job.session_id, automationId: job.automation_id,
          executionId: job.execution_id, runId: job.run_id,
        });
        const evidence: GoalEvidence = { ...job.evidence, hardGates: gates };
        const manifestValidation = await this.validateEvaluationEvidence(client, job, evidence);
        if (!manifestValidation.valid || !passesGoalHardGates(evidence)) return 0;
        const updated = await client.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='pending',decision=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND state='blocked' AND incarnation_id=$2 AND generation=$3 AND spec_version=$4
            RETURNING evaluation_id`,
          [job.evaluation_id, job.incarnation_id, job.generation, job.spec_version],
        );
        return updated.rowCount ?? 0;
      });
    }
    return restored;
  }

  async evaluatePending(limit = 10): Promise<number> {
    await this.reconcileUnknown();
    await this.checkInBlocked();
    if (!this.executionEnabled()) return 0;
    const jobs = await this.store.tx(async client => {
      const result = await client.query(
        `SELECT e.*,a.owner_user_id,x.run_id
           FROM ${this.store.tables.evaluations} e
           JOIN ${this.store.tables.automations} a
             ON a.tenant_id=e.tenant_id AND a.session_id=e.session_id AND a.automation_id=e.automation_id
            AND a.incarnation_id=e.incarnation_id AND a.generation=e.generation
            AND a.spec_version=e.spec_version AND a.status='active'
           JOIN ${this.store.tables.executions} x
             ON x.tenant_id=e.tenant_id AND x.session_id=e.session_id AND x.automation_id=e.automation_id
            AND x.execution_id=e.execution_id AND x.incarnation_id=e.incarnation_id
            AND x.generation=e.generation AND x.spec_version=e.spec_version
          WHERE e.state='pending' AND x.state='terminal'
          ORDER BY e.created_at FOR UPDATE OF e,a SKIP LOCKED LIMIT $1`,
        [limit],
      );
      for (const job of result.rows) {
        const token = randomUUID();
        await client.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='claimed',lease_token=$2,lease_expires_at=now()+interval '2 minutes'
            WHERE evaluation_id=$1`,
          [job.evaluation_id, token],
        );
        job.lease_token = token;
      }
      return result.rows;
    });

    for (const job of jobs) {
      if (!this.executionEnabled()) {
        await this.releaseClaimForDisabledExecution(job.evaluation_id, job.lease_token);
        continue;
      }
      const snapshot = await this.store.get(job.tenant_id, job.session_id, job.automation_id);
      if (!snapshot) continue;
      const gates = await this.resolveHardGates(this.store.pool, {
        tenantId: job.tenant_id,
        sessionId: job.session_id,
        automationId: job.automation_id,
        executionId: job.execution_id,
        runId: job.run_id,
      });
      const evidence: GoalEvidence = { ...job.evidence, hardGates: gates };
      const manifestValidation = await this.validateEvaluationEvidence(this.store.pool, job, evidence);
      if (!manifestValidation.valid) {
        await this.store.pool.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='unverifiable',decision=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$3`,
          [job.evaluation_id, JSON.stringify({ decision: 'unverifiable', reason: manifestValidation.reason ?? 'evidence_manifest_invalid', confidence: 1 }), job.lease_token],
        );
        continue;
      }
      if (!passesGoalHardGates(evidence)) {
        await this.store.pool.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='blocked',decision=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$3`,
          [job.evaluation_id, JSON.stringify({ decision: 'blocked', reason: 'hard_gate', confidence: 1, gates }), job.lease_token],
        );
        continue;
      }

      // Close the claim-to-provider race: revalidate the switch and complete automation fence
      // immediately before the evaluator can reserve budget or send provider bytes.
      if (!this.executionEnabled()) {
        await this.releaseClaimForDisabledExecution(job.evaluation_id, job.lease_token);
        continue;
      }
      const admitted = await this.store.pool.query(
        `SELECT 1 FROM ${this.store.tables.evaluations} e
          JOIN ${this.store.tables.automations} a
            ON a.tenant_id=e.tenant_id AND a.session_id=e.session_id AND a.automation_id=e.automation_id
           AND a.incarnation_id=e.incarnation_id AND a.generation=e.generation
           AND a.spec_version=e.spec_version AND a.status='active'
         WHERE e.evaluation_id=$1 AND e.lease_token=$2 AND e.state='claimed'`,
        [job.evaluation_id, job.lease_token],
      );
      if (!admitted.rowCount) {
        await this.store.pool.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$2 AND state='claimed'`,
          [job.evaluation_id, job.lease_token],
        );
        continue;
      }

      if (!this.executionEnabled()) {
        await this.releaseClaimForDisabledExecution(job.evaluation_id, job.lease_token);
        continue;
      }
      let result: { decision: GoalDecision; reason: string; confidence: number };
      try {
        result = await this.evaluator.evaluate({
          tenantId: job.tenant_id,
          sessionId: job.session_id,
          ownerUserId: job.owner_user_id,
          automationId: job.automation_id,
          executionId: job.execution_id,
          incarnationId: job.incarnation_id,
          generation: Number(job.generation),
          specVersion: Number(job.spec_version),
          condition: snapshot.spec.condition!,
          evidence,
          evaluatorRunId: `automation-evaluator-${job.evaluation_id}`,
          executionRunId: job.run_id,
          onAttemptPrepared: async (providerAttemptId) => {
            await this.store.pool.query(
              `UPDATE ${this.store.tables.evaluations}
                  SET provider_attempt_id=$2,updated_at=now()
                WHERE evaluation_id=$1 AND lease_token=$3 AND state='claimed'`,
              [job.evaluation_id, providerAttemptId, job.lease_token],
            );
          },
        });
      } catch (error) {
        const resultUnknown = error instanceof GoalEvaluationResultUnknownError;
        await this.store.pool.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state=$2,decision=$3,provider_attempt_id=COALESCE($4,provider_attempt_id),
                  lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$5`,
          [job.evaluation_id, resultUnknown ? 'result_unknown' : 'pending',
            JSON.stringify({ reason: error instanceof Error ? error.message : String(error) }),
            resultUnknown ? error.providerAttemptId : null, job.lease_token],
        );
        continue;
      }

      await this.store.tx(client => this.applyDecisionLocked(
        client, job, evidence, result, { leaseToken: job.lease_token },
      ));
      const published=await this.store.get(job.tenant_id,job.session_id,job.automation_id);if(published)this.store.publish(published);
    }
    return jobs.length;
  }

  private async releaseClaimForDisabledExecution(evaluationId: string, leaseToken: string): Promise<void> {
    await this.store.pool.query(
      `UPDATE ${this.store.tables.evaluations}
          SET state='pending',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE evaluation_id=$1 AND lease_token=$2 AND state='claimed'`,
      [evaluationId, leaseToken],
    );
  }

  start(pollMs = 2_000): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.evaluatePending(); } finally { this.running = false; }
    };
    void tick();
    this.timer = setInterval(() => void tick(), pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
