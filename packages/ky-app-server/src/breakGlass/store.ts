/**
 * §3.5 本地兜底登录的存储契约与内存实现。
 *
 * 具名恢复记录（argon2id 密码 + 8 个一次性恢复码）、兜底会话（模式级撤销）、
 * 员工一次性码、本地审计。PG 实现见 `pgStore.ts`，表结构见 `sql/001_ky_app_server.sql`。
 */

/** 一个一次性恢复码的哈希与使用状态。 */
export interface RecoveryCodeEntry {
  hash: string;
  usedAt: number | null;
}

/** 具名恢复记录：绑定某位组织管理员的 `sub`。 */
export interface RecoveryRecord {
  sub: string;
  /** argon2id（m=64 MiB, t=3, p=1）。 */
  passwordHash: string;
  codes: RecoveryCodeEntry[];
  failedAttempts: number;
  /** 锁定到期时刻（毫秒）；null 表示未锁定。 */
  lockedUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 兜底会话：模式级，一次启用 4 小时可续。 */
export interface BreakGlassSession {
  enabledBy: string;
  enabledAt: number;
  expiresAt: number;
}

/** 员工一次性码（15 分钟 TTL、哈希存储、5 次错误锁定）。 */
export interface EmployeeCodeEntry {
  loginId: string;
  sub: string;
  hash: string;
  expiresAt: number;
  usedAt: number | null;
  failedAttempts: number;
  lockedUntil: number | null;
}

export type BreakGlassAuditAction =
  'recovery.setup' | 'enable' | 'renew' | 'disable' | 'employee-code.issue' | 'login';

/** 本地审计条目（§3.5「全程本地审计」）。 */
export interface BreakGlassAuditEntry {
  at: number;
  action: BreakGlassAuditAction;
  outcome: 'success' | 'failure';
  sub?: string;
  loginId?: string;
  ip?: string;
  /** 只进日志的原因描述。 */
  detail?: string;
}

export interface BreakGlassStore {
  getRecord(sub: string): Promise<RecoveryRecord | null>;
  saveRecord(record: RecoveryRecord): Promise<void>;
  getSession(): Promise<BreakGlassSession | null>;
  /** 传 null 表示关闭兜底模式（模式级撤销）。 */
  saveSession(session: BreakGlassSession | null): Promise<void>;
  getEmployeeCode(loginId: string): Promise<EmployeeCodeEntry | null>;
  saveEmployeeCode(entry: EmployeeCodeEntry): Promise<void>;
  appendAudit(entry: BreakGlassAuditEntry): Promise<void>;
  listAudit(): Promise<BreakGlassAuditEntry[]>;
}

/** 内存实现：测试与单进程开发用。 */
export class MemoryBreakGlassStore implements BreakGlassStore {
  private readonly records = new Map<string, RecoveryRecord>();
  private readonly employeeCodes = new Map<string, EmployeeCodeEntry>();
  private readonly audit: BreakGlassAuditEntry[] = [];
  private session: BreakGlassSession | null = null;

  async getRecord(sub: string): Promise<RecoveryRecord | null> {
    const record = this.records.get(sub);
    return record === undefined ? null : structuredClone(record);
  }

  async saveRecord(record: RecoveryRecord): Promise<void> {
    this.records.set(record.sub, structuredClone(record));
  }

  async getSession(): Promise<BreakGlassSession | null> {
    return this.session === null ? null : { ...this.session };
  }

  async saveSession(session: BreakGlassSession | null): Promise<void> {
    this.session = session === null ? null : { ...session };
  }

  async getEmployeeCode(loginId: string): Promise<EmployeeCodeEntry | null> {
    const entry = this.employeeCodes.get(loginId);
    return entry === undefined ? null : { ...entry };
  }

  async saveEmployeeCode(entry: EmployeeCodeEntry): Promise<void> {
    this.employeeCodes.set(entry.loginId, { ...entry });
  }

  async appendAudit(entry: BreakGlassAuditEntry): Promise<void> {
    this.audit.push({ ...entry });
  }

  async listAudit(): Promise<BreakGlassAuditEntry[]> {
    return this.audit.map((entry) => ({ ...entry }));
  }
}
