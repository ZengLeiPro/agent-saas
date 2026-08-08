import type {
  BillingCreditAccount,
  BillingDecisionCode,
  BillingMemberBudgetEnforcementMode,
  BillingRunReservation,
  TenantBillingPolicy,
} from './types.js';
import { CREDIT_MICRO } from './types.js';

export const RUN_RESERVATION_CHUNK_CREDITS_MICRO = 100 * CREDIT_MICRO;

export function committedMemberBudgetCreditsMicro(
  usedCreditsMicro: number,
  reservedCreditsMicro: number,
  enforcementMode: BillingMemberBudgetEnforcementMode,
): number {
  return usedCreditsMicro + (enforcementMode === 'stop_new_runs' ? reservedCreditsMicro : 0);
}

export function initialRunReservationGrant(capCreditsMicro: number[]): number {
  return Math.trunc(Math.min(RUN_RESERVATION_CHUNK_CREDITS_MICRO, ...capCreditsMicro));
}

export function planRunReservationExtension(
  requestedCreditsMicro: number,
  caps: Array<{ value: number; code: BillingDecisionCode }>,
  requireFullExtension: boolean,
): { addedCreditsMicro: number; limitingCode?: BillingDecisionCode } {
  const requested = Math.max(0, Math.trunc(requestedCreditsMicro));
  if (requested <= 0 || caps.length === 0) return { addedCreditsMicro: 0 };
  const smallestCap = caps.reduce((smallest, cap) => cap.value < smallest.value ? cap : smallest);
  const addedCreditsMicro = Math.trunc(Math.min(requested, smallestCap.value));
  if (addedCreditsMicro <= 0 || (requireFullExtension && addedCreditsMicro < requested)) {
    return { addedCreditsMicro: 0, limitingCode: smallestCap.code };
  }
  return {
    addedCreditsMicro,
    ...(addedCreditsMicro < requested ? { limitingCode: smallestCap.code } : {}),
  };
}

interface QueryClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface ReservationTables {
  creditAccountsTable: string;
  creditLedgerTable: string;
  memberBudgetsTable: string;
  memberPeriodAccountsTable: string;
  runReservationsTable: string;
}

async function ensureMemberPeriodAccount(
  client: QueryClient,
  tables: ReservationTables,
  tenantId: string,
  userId: string,
  periodStart: string,
): Promise<void> {
  await client.query(`
    INSERT INTO ${tables.memberPeriodAccountsTable}
      (tenant_id, user_id, period_start, used_micro, reserved_micro, updated_at)
    SELECT $1, $2, $3::date,
           GREATEST(0, COALESCE(SUM(CASE
             WHEN l.type = 'debit' THEN -l.credits_delta_micro
             WHEN l.type IN ('refund', 'reversal') THEN -l.credits_delta_micro
             ELSE 0 END), 0))::bigint,
           0, $4
    FROM ${tables.creditLedgerTable} l
    LEFT JOIN ${tables.creditLedgerTable} original ON original.id = l.reverses_ledger_id
    WHERE l.tenant_id = $1 AND l.user_id = $2
      AND COALESCE(original.created_at, l.created_at) >= ($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND COALESCE(original.created_at, l.created_at) < (($3::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai')
    ON CONFLICT (tenant_id, user_id, period_start) DO NOTHING
  `, [tenantId, userId, periodStart, new Date().toISOString()]);
}

export async function extendRunReservationLocked(input: {
  client: QueryClient;
  tables: ReservationTables;
  account: BillingCreditAccount;
  policy: TenantBillingPolicy;
  reservation: BillingRunReservation;
  requestedCreditsMicro: number;
  requireFullExtension?: boolean;
}): Promise<{
  reservation: BillingRunReservation;
  addedCreditsMicro: number;
  limitingCode?: BillingDecisionCode;
}> {
  const { client, tables, account, policy, reservation } = input;
  const caps: Array<{ value: number; code: BillingDecisionCode }> = [];
  if (policy.hardCapMode === 'stop_before_run') {
    caps.push({
      value: Math.max(0, account.balanceCreditsMicro - account.reservedCreditsMicro
        + (policy.allowNegativeBalance ? policy.negativeLimitCreditsMicro : 0)),
      code: 'BILLING_ORG_BALANCE_EXHAUSTED',
    });
    caps.push({
      value: Math.max(0, (policy.maxRunCreditsMicro ?? 0) - reservation.grantedCreditsMicro),
      code: 'BILLING_RUN_LIMIT_EXCEEDED',
    });
  }

  if (reservation.userId) {
    const budgetResult = await client.query<{ row_json: Record<string, unknown> }>(`
      SELECT row_to_json(b.*) AS row_json FROM ${tables.memberBudgetsTable} b
      WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE
    `, [reservation.tenantId, reservation.userId]);
    const budget = budgetResult.rows[0]?.row_json;
    const enforcementMode = String(budget?.enforcement_mode ?? 'notify') as BillingMemberBudgetEnforcementMode;
    if (Boolean(budget?.active) && enforcementMode === 'stop_new_runs') {
      const periodStart = reservation.periodStart.slice(0, 10);
      await ensureMemberPeriodAccount(
        client,
        tables,
        reservation.tenantId,
        reservation.userId,
        periodStart,
      );
      const periodResult = await client.query<{ row_json: Record<string, unknown> }>(`
        SELECT row_to_json(p.*) AS row_json FROM ${tables.memberPeriodAccountsTable} p
        WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date FOR UPDATE
      `, [reservation.tenantId, reservation.userId, periodStart]);
      const periodAccount = periodResult.rows[0]?.row_json;
      caps.push({
        value: budget?.monthly_limit_micro === null || budget?.monthly_limit_micro === undefined
          ? 0
          : Math.max(0, Number(budget.monthly_limit_micro)
              - Number(periodAccount?.used_micro ?? 0) - Number(periodAccount?.reserved_micro ?? 0)),
        code: 'BILLING_MEMBER_MONTHLY_LIMIT_EXCEEDED',
      });
      caps.push({
        value: budget?.per_run_limit_micro === null || budget?.per_run_limit_micro === undefined
          ? 0
          : Math.max(0, Number(budget.per_run_limit_micro) - reservation.grantedCreditsMicro),
        code: 'BILLING_MEMBER_PER_RUN_LIMIT_EXCEEDED',
      });
    }
  }

  const plan = planRunReservationExtension(
    input.requestedCreditsMicro,
    caps,
    input.requireFullExtension ?? false,
  );
  if (plan.addedCreditsMicro <= 0) return { reservation, ...plan };

  const timestamp = new Date().toISOString();
  await client.query(`UPDATE ${tables.creditAccountsTable}
    SET reserved_micro = reserved_micro + $2, updated_at = $3 WHERE tenant_id = $1`,
  [reservation.tenantId, plan.addedCreditsMicro, timestamp]);
  if (reservation.userId) {
    await client.query(`UPDATE ${tables.memberPeriodAccountsTable}
      SET reserved_micro = reserved_micro + $4, updated_at = $5
      WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date`,
    [reservation.tenantId, reservation.userId, reservation.periodStart.slice(0, 10), plan.addedCreditsMicro, timestamp]);
  }
  const updated = await client.query<{ updated: number }>(`
    UPDATE ${tables.runReservationsTable}
    SET granted_micro = granted_micro + $3,
        remaining_micro = remaining_micro + $3,
        updated_at = $4
    WHERE tenant_id = $1 AND run_id = $2 AND status = 'active'
    RETURNING 1 AS updated
  `, [reservation.tenantId, reservation.runId, plan.addedCreditsMicro, timestamp]);
  if (!updated.rows[0]) throw new Error('运行积分预占状态已变化，请重试');
  return {
    reservation: {
      ...reservation,
      grantedCreditsMicro: reservation.grantedCreditsMicro + plan.addedCreditsMicro,
      remainingCreditsMicro: reservation.remainingCreditsMicro + plan.addedCreditsMicro,
      updatedAt: timestamp,
    },
    ...plan,
  };
}

export async function prepareRunReservationForModel(input: {
  client: QueryClient;
  tables: ReservationTables;
  account: BillingCreditAccount;
  policy: TenantBillingPolicy;
  reservation: BillingRunReservation;
  pendingCreditsMicro: number;
  activeHoldsCreditsMicro: number;
}): Promise<
  | { ok: true; reservation: BillingRunReservation }
  | { ok: false; code: BillingDecisionCode; reason: string }
> {
  const committed = input.pendingCreditsMicro + input.activeHoldsCreditsMicro;
  const headroom = input.reservation.remainingCreditsMicro - committed;
  const extension = headroom < RUN_RESERVATION_CHUNK_CREDITS_MICRO
    ? await extendRunReservationLocked({
        ...input,
        requestedCreditsMicro: RUN_RESERVATION_CHUNK_CREDITS_MICRO - headroom,
      })
    : { reservation: input.reservation, addedCreditsMicro: 0 };
  if (committed >= extension.reservation.remainingCreditsMicro) {
    const code = extension.limitingCode ?? 'BILLING_RUN_LIMIT_EXCEEDED';
    return { ok: false, code, reason: reservationLimitReason(code) };
  }
  return { ok: true, reservation: extension.reservation };
}

export async function prepareRunReservationForFixedFee(input: {
  client: QueryClient;
  tables: ReservationTables;
  account: BillingCreditAccount;
  policy: TenantBillingPolicy;
  reservation: BillingRunReservation;
  requiredCreditsMicro: number;
}): Promise<
  | { ok: true; reservation: BillingRunReservation }
  | { ok: false; code: BillingDecisionCode; reason: string }
> {
  const missing = input.requiredCreditsMicro - input.reservation.remainingCreditsMicro;
  const extension = missing > 0
    ? await extendRunReservationLocked({
        ...input,
        requestedCreditsMicro: missing,
        requireFullExtension: true,
      })
    : { reservation: input.reservation, addedCreditsMicro: 0 };
  if (input.requiredCreditsMicro <= extension.reservation.remainingCreditsMicro) {
    return { ok: true, reservation: extension.reservation };
  }
  if (extension.limitingCode && extension.limitingCode !== 'BILLING_RUN_LIMIT_EXCEEDED') {
    return {
      ok: false,
      code: extension.limitingCode,
      reason: reservationLimitReason(extension.limitingCode),
    };
  }
  return {
    ok: false,
    code: 'BILLING_FIXED_FEE_LIMIT_EXCEEDED',
    reason: '固定费用将超过本次运行的剩余积分上限。',
  };
}

export function reservationLimitReason(code: BillingDecisionCode): string {
  if (code === 'BILLING_ORG_BALANCE_EXHAUSTED') return '组织积分余额不足，不能继续发起模型请求。';
  if (code === 'BILLING_MEMBER_MONTHLY_LIMIT_EXCEEDED') return '员工本月积分预算已用尽。';
  if (code === 'BILLING_MEMBER_PER_RUN_LIMIT_EXCEEDED') return '本次运行已达到员工单 Run 上限。';
  return '本次运行已达到积分上限，不能继续发起模型请求。';
}
