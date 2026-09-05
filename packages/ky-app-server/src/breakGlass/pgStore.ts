/**
 * §3.5 本地兜底登录的 PostgreSQL 实现。
 *
 * 会话表只有一行（`id = 1`），因此「关闭兜底模式」就是删掉那一行——撤销粒度 = 模式级。
 * 审计只追加不更新。
 */
import type { Pool } from 'pg';

import type {
  BreakGlassAuditAction,
  BreakGlassAuditEntry,
  BreakGlassSession,
  BreakGlassStore,
  EmployeeCodeEntry,
  RecoveryCodeEntry,
  RecoveryRecord,
} from './store.js';

export class PgBreakGlassStore implements BreakGlassStore {
  constructor(private readonly pool: Pool) {}

  async getRecord(sub: string): Promise<RecoveryRecord | null> {
    const result = await this.pool.query<{
      sub: string;
      password_hash: string;
      codes: RecoveryCodeEntry[];
      failed_attempts: number;
      locked_until: Date | null;
      created_at: Date;
      updated_at: Date;
    }>('SELECT * FROM ky_app_break_glass_record WHERE sub = $1', [sub]);
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    return {
      sub: row.sub,
      passwordHash: row.password_hash,
      codes: row.codes,
      failedAttempts: row.failed_attempts,
      lockedUntil: row.locked_until === null ? null : row.locked_until.getTime(),
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
    };
  }

  async saveRecord(record: RecoveryRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ky_app_break_glass_record
         (sub, password_hash, codes, failed_attempts, locked_until, created_at, updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)
       ON CONFLICT (sub) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         codes = EXCLUDED.codes,
         failed_attempts = EXCLUDED.failed_attempts,
         locked_until = EXCLUDED.locked_until,
         updated_at = EXCLUDED.updated_at`,
      [
        record.sub,
        record.passwordHash,
        JSON.stringify(record.codes),
        record.failedAttempts,
        record.lockedUntil === null ? null : new Date(record.lockedUntil),
        new Date(record.createdAt),
        new Date(record.updatedAt),
      ],
    );
  }

  async getSession(): Promise<BreakGlassSession | null> {
    const result = await this.pool.query<{
      enabled_by: string;
      enabled_at: Date;
      expires_at: Date;
    }>('SELECT * FROM ky_app_break_glass_session WHERE id = 1');
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    return {
      enabledBy: row.enabled_by,
      enabledAt: row.enabled_at.getTime(),
      expiresAt: row.expires_at.getTime(),
    };
  }

  async saveSession(session: BreakGlassSession | null): Promise<void> {
    if (session === null) {
      await this.pool.query('DELETE FROM ky_app_break_glass_session WHERE id = 1');
      return;
    }
    await this.pool.query(
      `INSERT INTO ky_app_break_glass_session (id, enabled_by, enabled_at, expires_at)
       VALUES (1,$1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET
         enabled_by = EXCLUDED.enabled_by,
         enabled_at = EXCLUDED.enabled_at,
         expires_at = EXCLUDED.expires_at`,
      [session.enabledBy, new Date(session.enabledAt), new Date(session.expiresAt)],
    );
  }

  async getEmployeeCode(loginId: string): Promise<EmployeeCodeEntry | null> {
    const result = await this.pool.query<{
      login_id: string;
      sub: string;
      code_hash: string;
      expires_at: Date;
      used_at: Date | null;
      failed_attempts: number;
      locked_until: Date | null;
    }>('SELECT * FROM ky_app_break_glass_employee_code WHERE login_id = $1', [loginId]);
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    return {
      loginId: row.login_id,
      sub: row.sub,
      hash: row.code_hash,
      expiresAt: row.expires_at.getTime(),
      usedAt: row.used_at === null ? null : row.used_at.getTime(),
      failedAttempts: row.failed_attempts,
      lockedUntil: row.locked_until === null ? null : row.locked_until.getTime(),
    };
  }

  async saveEmployeeCode(entry: EmployeeCodeEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ky_app_break_glass_employee_code
         (login_id, sub, code_hash, expires_at, used_at, failed_attempts, locked_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (login_id) DO UPDATE SET
         sub = EXCLUDED.sub,
         code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at,
         used_at = EXCLUDED.used_at,
         failed_attempts = EXCLUDED.failed_attempts,
         locked_until = EXCLUDED.locked_until`,
      [
        entry.loginId,
        entry.sub,
        entry.hash,
        new Date(entry.expiresAt),
        entry.usedAt === null ? null : new Date(entry.usedAt),
        entry.failedAttempts,
        entry.lockedUntil === null ? null : new Date(entry.lockedUntil),
      ],
    );
  }

  async appendAudit(entry: BreakGlassAuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ky_app_break_glass_audit (at, action, outcome, sub, login_id, ip, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        new Date(entry.at),
        entry.action,
        entry.outcome,
        entry.sub ?? null,
        entry.loginId ?? null,
        entry.ip ?? null,
        entry.detail ?? null,
      ],
    );
  }

  async listAudit(): Promise<BreakGlassAuditEntry[]> {
    const result = await this.pool.query<{
      at: Date;
      action: BreakGlassAuditAction;
      outcome: 'success' | 'failure';
      sub: string | null;
      login_id: string | null;
      ip: string | null;
      detail: string | null;
    }>('SELECT * FROM ky_app_break_glass_audit ORDER BY id');
    return result.rows.map((row) => ({
      at: row.at.getTime(),
      action: row.action,
      outcome: row.outcome,
      ...(row.sub === null ? {} : { sub: row.sub }),
      ...(row.login_id === null ? {} : { loginId: row.login_id }),
      ...(row.ip === null ? {} : { ip: row.ip }),
      ...(row.detail === null ? {} : { detail: row.detail }),
    }));
  }
}
