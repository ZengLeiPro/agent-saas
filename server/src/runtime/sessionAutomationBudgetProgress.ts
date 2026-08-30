import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { SessionAutomationSpec } from '@agent/shared/types/sessionAutomation.js';
import type { PlatformEvent } from './types.js';

const MICROCREDITS_PER_CREDIT = 1_000_000n;

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export interface AutomationBudgetTables {
  automations: string;
  specs: string;
  usage: string;
  budgetReservations: string;
}

/** Convert the NUMERIC/JSON boundary once; all budget comparisons remain integer-only. */
export function creditsToMicrocredits(value: string | number): bigint | undefined {
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  let text = String(value).trim();
  if (/e/i.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return undefined;
    text = numeric.toFixed(6);
  }
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) return undefined;
  const magnitude = BigInt(match[2]!) * MICROCREDITS_PER_CREDIT
    + BigInt((fraction.slice(0, 6) + '000000').slice(0, 6));
  return match[1] === '-' ? -magnitude : magnitude;
}

export async function resolveAutomationBudgetReason(input: {
  client: Queryable;
  tables: AutomationBudgetTables;
  tablePrefix: string;
  runsTable: string;
  tenantId: string;
  sessionId: string;
  automationId: string;
  now?: Date;
}): Promise<string | undefined> {
  const rowResult = await input.client.query(
    `SELECT a.run_count,s.spec FROM ${input.tables.automations} a
       JOIN ${input.tables.specs} s ON s.automation_id=a.automation_id AND s.spec_version=a.spec_version
      WHERE a.tenant_id=$1 AND a.session_id=$2 AND a.automation_id=$3`,
    [input.tenantId, input.sessionId, input.automationId],
  );
  const row = rowResult.rows[0];
  if (!row) return 'not_found';
  const usageResult = await input.client.query(
    `SELECT COALESCE(SUM(turns),0) AS turns,COALESCE(SUM(tokens),0) AS tokens,
            COALESCE(SUM(credits),0)::text AS credits
       FROM ${input.tables.usage} WHERE tenant_id=$1 AND automation_id=$2`,
    [input.tenantId, input.automationId],
  );
  const totals = usageResult.rows[0] ?? {};
  const reservedResult = await input.client.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE budget_kind='turns'),0)::text AS turns,
            COALESCE(SUM(amount) FILTER (WHERE budget_kind='tokens'),0)::text AS tokens,
            COALESCE(SUM(amount) FILTER (WHERE budget_kind='credits'),0)::text AS credits
       FROM ${input.tables.budgetReservations}
      WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('reserved','result_unknown','reconcile')`,
    [input.tenantId, input.automationId],
  );
  const reserved = reservedResult.rows[0] ?? {};
  const budget = (row.spec as SessionAutomationSpec).budget ?? {};
  let usedMicrocredits = creditsToMicrocredits(String(totals.credits ?? '0'));
  const reservedMicrocredits = creditsToMicrocredits(String(reserved.credits ?? '0'));
  if (usedMicrocredits === undefined || reservedMicrocredits === undefined) return 'credits_unverifiable';
  usedMicrocredits += reservedMicrocredits;

  if (budget.maxCredits !== undefined) {
    const ledger = `${input.tablePrefix}_billing_credit_ledger`;
    const events = `${input.tablePrefix}_billing_usage_events`;
    const exists = await input.client.query('SELECT to_regclass($1) AS ledger,to_regclass($2) AS events', [ledger, events]);
    if (exists.rows[0]?.ledger) {
      const eventClause = exists.rows[0]?.events
        ? ` OR l.run_id IN (SELECT u.run_id FROM ${events} u WHERE u.tenant_id=$1 AND u.raw_usage_json->'automationAttribution'->>'rootAutomationId'=$2)`
        : '';
      const billed = await input.client.query(
        `SELECT COALESCE(SUM(CASE WHEN l.type IN ('debit','reversal') THEN -l.credits_delta_micro ELSE 0 END),0)::text AS credits_micro
           FROM ${ledger} l WHERE l.tenant_id=$1
            AND (l.run_id IN (SELECT r.run_id FROM ${input.runsTable} r WHERE r.tenant_id=$1 AND r.metadata->'automationFence'->>'rootAutomationId'=$2)${eventClause})`,
        [input.tenantId, input.automationId],
      );
      const billedMicrocredits = /^\d+$/.test(String(billed.rows[0]?.credits_micro ?? ''))
        ? BigInt(String(billed.rows[0]!.credits_micro))
        : undefined;
      if (billedMicrocredits === undefined) return 'credits_unverifiable';
      if (billedMicrocredits > usedMicrocredits) usedMicrocredits = billedMicrocredits;
    }
  }

  if (budget.expiresAt && (input.now ?? new Date()).getTime() >= new Date(budget.expiresAt).getTime()) return 'expires_at';
  if (budget.maxRuns !== undefined && BigInt(String(row.run_count)) >= BigInt(budget.maxRuns)) return 'max_runs';
  if (budget.maxTurns !== undefined
    && BigInt(String(totals.turns ?? 0)) + BigInt(String(reserved.turns ?? 0)) >= BigInt(budget.maxTurns)) return 'max_turns';
  if (budget.maxTokens !== undefined
    && BigInt(String(totals.tokens ?? 0)) + BigInt(String(reserved.tokens ?? 0)) >= BigInt(budget.maxTokens)) return 'max_tokens';
  if (budget.maxCredits !== undefined) {
    const limitMicrocredits = creditsToMicrocredits(budget.maxCredits);
    if (limitMicrocredits === undefined) return 'credits_unverifiable';
    if (usedMicrocredits >= limitMicrocredits) return 'max_credits';
  }
  return undefined;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

export interface RunProgressEvidence {
  summary: string;
  evidenceRefs: string[];
  fingerprint: string;
}

/** Build evidence only from immutable host events; transport/run identifiers never enter the hash. */
export function extractRunProgressEvidence(events: readonly PlatformEvent[], terminalStatus: string): RunProgressEvidence {
  const evidenceRefs: string[] = [];
  const facts: Array<Record<string, unknown>> = [];
  let summary = '';
  for (const event of events) {
    if (event.type === 'assistant_message') {
      const content = normalizeContent(event.content);
      if (!content) continue;
      summary = content;
      evidenceRefs.push(`event:${event.id}`);
      facts.push({ type: event.type, content });
    } else if (event.type === 'tool_result') {
      const content = normalizeContent(event.content);
      if (!content) continue;
      evidenceRefs.push(`event:${event.id}`);
      facts.push({ type: event.type, toolName: event.toolName, isError: event.isError === true, content });
    } else if (event.type === 'run_finished' && event.error) {
      const content = normalizeContent(event.error);
      if (!content) continue;
      if (!summary) summary = content;
      evidenceRefs.push(`event:${event.id}`);
      facts.push({ type: event.type, error: content });
    } else if (event.type === 'run_state_changed' && event.reason) {
      const content = normalizeContent(event.reason);
      if (!content) continue;
      if (!summary) summary = content;
      evidenceRefs.push(`event:${event.id}`);
      facts.push({ type: event.type, status: event.status, reason: content });
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ terminalStatus, facts })).digest('hex');
  return { summary, evidenceRefs, fingerprint };
}

export function reduceNoProgress(previous: string | undefined, current: string, count: number, threshold = 3): { count: number; pause: boolean } {
  const next = previous === current ? count + 1 : 0;
  return { count: next, pause: next >= threshold };
}
