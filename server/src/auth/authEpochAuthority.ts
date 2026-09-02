import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuthEpochBinding {
  authEpoch: number;
  generation: number;
}

interface AuthEpochRecord extends AuthEpochBinding {
  updatedAt: string;
  reason: 'login' | 'legacy_upgrade' | 'logout' | 'revoke' | 'delete_account';
  fenced: boolean;
}

interface PersistedAuthEpochState {
  version: 1;
  users: Record<string, AuthEpochRecord>;
}

export interface AuthEpochAuditEvent extends AuthEpochBinding {
  event: 'auth_epoch_issued' | 'auth_epoch_fenced' | 'legacy_token_upgraded';
  userId: string;
  reason: AuthEpochRecord['reason'];
  at: string;
}

/** Durable per-user epoch authority. Writes are atomic and every mutation is monotonic. */
export class AuthEpochAuthority {
  private state: PersistedAuthEpochState = { version: 1, users: {} };

  constructor(
    private readonly filePath?: string,
    private readonly audit?: (event: AuthEpochAuditEvent) => void,
  ) {
    this.load();
  }

  issueLogin(userId: string): AuthEpochBinding {
    return this.advance(userId, 'login', false, 'auth_epoch_issued');
  }

  /** Epoch-less N-1 tokens are accepted exactly once, only before an authority record exists. */
  upgradeLegacy(userId: string): AuthEpochBinding | null {
    this.load();
    if (this.state.users[userId]) return null;
    return this.advance(userId, 'legacy_upgrade', false, 'legacy_token_upgraded');
  }

  fence(userId: string, reason: 'logout' | 'revoke' | 'delete_account'): AuthEpochBinding {
    return this.advance(userId, reason, true, 'auth_epoch_fenced');
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
      && binding?.generation === current.generation;
  }

  private advance(
    userId: string,
    reason: AuthEpochRecord['reason'],
    fenced: boolean,
    event: AuthEpochAuditEvent['event'],
  ): AuthEpochBinding {
    this.load();
    const previous = this.state.users[userId];
    const binding = {
      authEpoch: (previous?.authEpoch ?? 0) + 1,
      generation: (previous?.generation ?? 0) + 1,
    };
    const at = new Date().toISOString();
    this.state.users[userId] = { ...binding, updatedAt: at, reason, fenced };
    this.persist();
    this.audit?.({ event, userId, ...binding, reason, at });
    return binding;
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedAuthEpochState;
      if (parsed?.version === 1 && parsed.users && typeof parsed.users === 'object') this.state = parsed;
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
