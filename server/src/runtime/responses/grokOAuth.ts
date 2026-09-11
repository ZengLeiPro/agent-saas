import { randomUUID } from 'node:crypto';
import { GrokOAuthClient, type GrokDeviceCode, type GrokOAuthTokens } from './grokOAuthClient.js';
import { GrokProtocolError } from './grokProtocol.js';
export type GrokDeviceStatus =
  'pending' | 'authorized_pending_publication' | 'applied' | 'expired' | 'denied' | 'error';
interface Session {
  id: string;
  owner: string;
  replaceCredentialRef?: string;
  device?: GrokDeviceCode;
  status: GrokDeviceStatus;
  expiresAt: number;
  nextPollAt: number;
  intervalMs: number;
  userCode: string;
  verificationUri: string;
  tokens?: GrokOAuthTokens;
  error?: string;
  polling?: Promise<ReturnType<GrokDeviceAuthService['status']>>;
}
/** Fixed API-owner sessions; intermediate secrets never leave this service. */
export class GrokDeviceAuthService {
  private readonly sessions = new Map<string, Session>();
  private startsInFlight = 0;
  constructor(
    private readonly client: GrokOAuthClient,
    private readonly options: { now?: () => number; maxSessions?: number } = {},
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  async start(owner: string, replaceCredentialRef?: string, clientId?: string) {
    this.cleanup();
    if (!owner || this.sessions.size + this.startsInFlight >= (this.options.maxSessions ?? 100))
      throw new GrokProtocolError('authorization_capacity', 429);
    this.startsInFlight += 1;
    try {
      const device = await this.client.start(clientId);
      const session: Session = {
        id: randomUUID(),
        owner,
        replaceCredentialRef,
        device,
        status: 'pending',
        expiresAt: Math.min(device.expiresAt, this.now() + 30 * 60_000),
        nextPollAt: this.now() + device.intervalMs,
        intervalMs: device.intervalMs,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
      };
      this.sessions.set(session.id, session);
      return this.status(session.id, owner);
    } finally {
      this.startsInFlight -= 1;
    }
  }
  status(id: string, owner: string) {
    const s = this.get(id, owner);
    return {
      sessionId: s.id,
      status: s.status,
      expiresAt: new Date(s.expiresAt).toISOString(),
      intervalMs: s.intervalMs,
      intervalSeconds: s.intervalMs / 1_000,
      ...(s.status === 'pending'
        ? { userCode: s.userCode, verificationUri: s.verificationUri }
        : {}),
      ...(s.error ? { error: s.error } : {}),
    };
  }
  async poll(id: string, owner: string) {
    const s = this.get(id, owner);
    if (s.polling) return s.polling;
    if (s.status !== 'pending' || this.now() < s.nextPollAt) return this.status(id, owner);
    const promise = this.advance(s).finally(() => {
      s.polling = undefined;
    });
    s.polling = promise;
    return promise;
  }
  authorizedResult(id: string, owner: string) {
    const s = this.get(id, owner);
    if (s.status !== 'authorized_pending_publication' || !s.tokens)
      throw new GrokProtocolError('authorization_not_ready', 409);
    return { tokens: s.tokens, replaceCredentialRef: s.replaceCredentialRef };
  }
  complete(id: string, owner: string): void {
    const s = this.get(id, owner);
    this.clearSecrets(s);
    s.status = 'applied';
  }
  cancel(id: string, owner: string): void {
    const s = this.get(id, owner);
    this.clearSecrets(s);
    this.sessions.delete(id);
  }
  private async advance(s: Session) {
    s.nextPollAt = this.now() + s.intervalMs;
    try {
      const tokens = await this.client.poll(s.device!);
      if (this.sessions.get(s.id) !== s || this.now() >= s.expiresAt) {
        this.clearSecrets(s);
        s.status = 'expired';
      } else {
        s.tokens = tokens;
        s.device = undefined;
        s.status = 'authorized_pending_publication';
      }
    } catch (error) {
      const code = error instanceof GrokProtocolError ? error.code : 'authorization_error';
      if (code === 'authorization_pending') {
        /* issuer interval retained */
      } else if (code === 'slow_down') {
        s.intervalMs = Math.min(300_000, s.intervalMs + 5_000);
        s.nextPollAt = this.now() + s.intervalMs;
      } else {
        s.status =
          code === 'access_denied' ? 'denied' : code === 'expired_token' ? 'expired' : 'error';
        s.error = code;
        this.clearSecrets(s);
      }
    }
    if (this.sessions.get(s.id) !== s) throw new GrokProtocolError('authorization_not_found', 404);
    return this.status(s.id, s.owner);
  }
  private get(id: string, owner: string): Session {
    const s = this.sessions.get(id);
    if (!s || !owner || s.owner !== owner)
      throw new GrokProtocolError('authorization_not_found', 404);
    if (this.now() >= s.expiresAt && s.status !== 'applied') {
      s.status = 'expired';
      this.clearSecrets(s);
    }
    return s;
  }
  private clearSecrets(s: Session): void {
    s.tokens = undefined;
    s.device = undefined;
    s.userCode = '';
    s.verificationUri = '';
  }
  private cleanup(): void {
    for (const [id, s] of this.sessions)
      if (this.now() >= s.expiresAt) {
        this.clearSecrets(s);
        this.sessions.delete(id);
      }
  }
}
