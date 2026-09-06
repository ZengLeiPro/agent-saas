// WP5：定制项目交付编排与交付状态。
// 全部为 expand-only 新表，不修改 v41～v43 的系统、安装、目录与会话快照结构。
export function governanceV44KyAppDeliveryStatements(prefix: string): string[] {
  const executions = `${prefix}_ky_app_onboard_executions`;
  const deliveries = `${prefix}_ky_app_delivery_records`;
  return [
    `CREATE TABLE IF NOT EXISTS ${executions} (
      execution_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      system_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      request_json JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','waiting_external','completed','failed')),
      current_step TEXT NOT NULL,
      steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE (tenant_id, system_id, installation_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${executions}_status_updated_idx
      ON ${executions} (status, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${executions}_tenant_updated_idx
      ON ${executions} (tenant_id, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${deliveries} (
      installation_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      system_id TEXT NOT NULL,
      delivered_at TIMESTAMPTZ,
      checklist_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      member_import_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      guide_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      offboarding_status TEXT NOT NULL DEFAULT 'active'
        CHECK (offboarding_status IN ('active','planned','running','completed','blocked')),
      offboarding_plan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      low_balance_notified_at TIMESTAMPTZ,
      exhausted_notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS ${deliveries}_tenant_delivery_idx
      ON ${deliveries} (tenant_id, delivered_at DESC NULLS LAST)`,
    `CREATE INDEX IF NOT EXISTS ${deliveries}_offboarding_idx
      ON ${deliveries} (offboarding_status, updated_at DESC)`,
  ];
}
