interface QueryClient {
  query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
}

/** 阻止旧硬封顶策略在缺少单 Run 上限时进入 readiness。 */
export async function assertHardCapRunLimitsConfigured(
  client: QueryClient,
  tenantPoliciesTable: string,
): Promise<void> {
  const invalid = await client.query<{ tenant_id: string }>(`
    SELECT tenant_id
    FROM ${tenantPoliciesTable}
    WHERE billing_enabled = true
      AND billing_mode <> 'internal'
      AND hard_cap_mode = 'stop_before_run'
      AND (max_run_credits_micro IS NULL OR max_run_credits_micro <= 0)
    ORDER BY tenant_id
    LIMIT 20
  `);
  if (invalid.rows.length === 0) return;
  const tenantIds = invalid.rows.map((row) => row.tenant_id).join(', ');
  throw new Error(
    `Billing policy upgrade blocked: hard-capped tenants missing max_run_credits_micro (${tenantIds}). `
    + 'Configure a positive organization per-run limit before deploying this release.',
  );
}

/**
 * PostgreSQL DATE 可能返回 `YYYY-MM-DD` 或 Date。Date 使用本地年月日还原，
 * 避免 `toISOString()` 在 UTC+8 把月初退到上个月末。
 */
export function normalizeDateOnly(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  if (matched?.[1]) return matched[1];
  throw new Error(`Invalid PostgreSQL DATE value: ${String(value)}`);
}
