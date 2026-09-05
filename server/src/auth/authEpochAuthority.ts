import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuthEpochBinding {
  authEpoch: number;
  generation: number;
}

interface AuthEpochRecord extends AuthEpochBinding {
  /** 仍然有效的登录 generation；每个设备/客户端一次登录对应一个。 */
  activeGenerations: number[];
  updatedAt: string;
  reason: 'login' | 'legacy_upgrade' | 'logout' | 'revoke' | 'delete_account';
  fenced: boolean;
}

interface PersistedAuthEpochState {
  version: 1;
  users: Record<string, AuthEpochRecord>;
}

export interface AuthEpochAuditEvent extends AuthEpochBinding {
  event: 'auth_epoch_issued' | 'auth_epoch_fenced' | 'auth_generation_revoked' | 'legacy_token_upgraded';
  userId: string;
  reason: AuthEpochRecord['reason'];
  at: string;
}

/** 单用户同时保留的登录数上限；超出时淘汰最早签发的 generation。 */
const MAX_ACTIVE_GENERATIONS = 32;

/**
 * Durable per-user epoch authority. Writes are atomic and every mutation is monotonic.
 *
 * - `authEpoch` 是用户级围栏：只在 fence（revoke/delete_account）时推进，推进后此前所有 token 全部失效。
 * - `generation` 是登录级会话：每次登录分配一个新值并加入 `activeGenerations`，
 *   多设备/多客户端可同时持有各自的 generation；logout 只撤销自己的那一个。
 */
export class AuthEpochAuthority {
  private state: PersistedAuthEpochState = { version: 1, users: {} };

  /**
   * 构造期之后追加的订阅者。构造期的 `audit` 回调只有一个位置，
   * 而 WP2a 的 SAT 停签登记表（`kyapp/sat/suspension.ts`）必须在运行时装配阶段挂上去，
   * 因此这里提供可叠加的订阅通道，与构造期回调并存、互不影响。
   */
  private readonly auditSubscribers: Array<(event: AuthEpochAuditEvent) => void> = [];

  constructor(
    private readonly filePath?: string,
    private readonly audit?: (event: AuthEpochAuditEvent) => void,
  ) {
    this.load();
  }

  /** 追加一个 audit 订阅者；返回取消订阅的函数。订阅者抛错不影响主流程。 */
  onAudit(listener: (event: AuthEpochAuditEvent) => void): () => void {
    this.auditSubscribers.push(listener);
    return () => {
      const index = this.auditSubscribers.indexOf(listener);
      if (index >= 0) this.auditSubscribers.splice(index, 1);
    };
  }

  /** 新登录：分配新 generation 并保留其他仍有效的登录，不再驱逐同一用户的其他会话。 */
  issueLogin(userId: string): AuthEpochBinding {
    return this.issue(userId, 'login', 'auth_epoch_issued');
  }

  /** Epoch-less N-1 tokens are accepted exactly once, only before an authority record exists. */
  upgradeLegacy(userId: string): AuthEpochBinding | null {
    this.load();
    if (this.state.users[userId]) return null;
    return this.issue(userId, 'legacy_upgrade', 'legacy_token_upgraded');
  }

  /** 用户级围栏：推进 authEpoch 并清空全部登录，此前所有 token 立即失效。 */
  fence(userId: string, reason: 'logout' | 'revoke' | 'delete_account'): AuthEpochBinding {
    this.load();
    const previous = this.state.users[userId];
    const binding = {
      authEpoch: (previous?.authEpoch ?? 0) + 1,
      generation: (previous?.generation ?? 0) + 1,
    };
    this.write(userId, { ...binding, activeGenerations: [], reason, fenced: true }, 'auth_epoch_fenced');
    return binding;
  }

  /**
   * 登录级撤销：只让 binding 对应的那一次登录失效，同一用户其他设备不受影响。
   * 返回 null 表示 binding 不属于当前 authEpoch（无法判定归属，调用方按未授权处理）；
   * `duplicate=true` 表示该 generation 早已失效，重复调用保持幂等。
   */
  revokeGeneration(
    userId: string,
    binding: Partial<AuthEpochBinding> | null | undefined,
  ): (AuthEpochBinding & { duplicate: boolean }) | null {
    this.load();
    const current = this.state.users[userId];
    if (!current || typeof binding?.authEpoch !== 'number' || typeof binding.generation !== 'number') return null;
    if (binding.authEpoch < current.authEpoch) {
      return { authEpoch: current.authEpoch, generation: binding.generation, duplicate: true };
    }
    if (binding.authEpoch !== current.authEpoch) return null;
    const result = { authEpoch: current.authEpoch, generation: binding.generation };
    if (current.fenced || !current.activeGenerations.includes(binding.generation)) {
      return { ...result, duplicate: true };
    }
    this.write(userId, {
      ...current,
      activeGenerations: current.activeGenerations.filter((generation) => generation !== binding.generation),
      reason: 'logout',
    }, 'auth_generation_revoked', binding.generation);
    return { ...result, duplicate: false };
  }

  current(userId: string): (AuthEpochBinding & { fenced: boolean }) | null {
    this.load();
    const record = this.state.users[userId];
    return record ? { authEpoch: record.authEpoch, generation: record.generation, fenced: record.fenced } : null;
  }

  validates(userId: string, binding: Partial<AuthEpochBinding> | null | undefined): boolean {
    this.load();
    const current = this.state.users[userId];
    return !!current && !current.fenced
      && binding?.authEpoch === current.authEpoch
      && typeof binding.generation === 'number'
      && current.activeGenerations.includes(binding.generation);
  }

  private issue(
    userId: string,
    reason: 'login' | 'legacy_upgrade',
    event: AuthEpochAuditEvent['event'],
  ): AuthEpochBinding {
    this.load();
    const previous = this.state.users[userId];
    const binding = {
      authEpoch: previous?.authEpoch ?? 1,
      generation: (previous?.generation ?? 0) + 1,
    };
    const retained = previous && !previous.fenced ? previous.activeGenerations : [];
    const activeGenerations = [...retained, binding.generation].slice(-MAX_ACTIVE_GENERATIONS);
    this.write(userId, { ...binding, activeGenerations, reason, fenced: false }, event);
    return binding;
  }

  private write(
    userId: string,
    record: Omit<AuthEpochRecord, 'updatedAt'>,
    event: AuthEpochAuditEvent['event'],
    auditGeneration = record.generation,
  ): void {
    const at = new Date().toISOString();
    this.state.users[userId] = { ...record, updatedAt: at };
    this.persist();
    const payload: AuthEpochAuditEvent = {
      event, userId, authEpoch: record.authEpoch, generation: auditGeneration, reason: record.reason, at,
    };
    this.audit?.(payload);
    for (const listener of this.auditSubscribers) {
      try {
        listener(payload);
      } catch {
        // 订阅者是旁路观察者，异常不得影响 epoch 写入。
      }
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedAuthEpochState;
      if (parsed?.version === 1 && parsed.users && typeof parsed.users === 'object') {
        // 兼容单 generation 旧记录：未围栏的旧记录只承认最后一次登录。
        for (const record of Object.values(parsed.users)) {
          if (!Array.isArray(record.activeGenerations)) {
            record.activeGenerations = record.fenced ? [] : [record.generation];
          }
        }
        this.state = parsed;
      }
    } catch {
      throw new Error(`AUTH_EPOCH_STATE_CORRUPT:${this.filePath}`);
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}
