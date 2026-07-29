import { randomUUID } from 'node:crypto';

import {
  CODEX_AUTH_BASE_URL,
  CODEX_DEVICE_VERIFICATION_URI,
  CODEX_OAUTH_CLIENT_ID,
  readOAuthTokenResponse,
  type CodexOAuthTokens,
} from './codexCredentialManager.js';

const DEVICE_USER_CODE_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_REDIRECT_URI = `${CODEX_AUTH_BASE_URL}/deviceauth/callback`;
const TOKEN_URL = `${CODEX_AUTH_BASE_URL}/oauth/token`;
const DEVICE_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

interface DeviceSession {
  id: string;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
  completedTokens?: CodexOAuthTokens;
}

export type CodexDevicePollResult =
  | { status: 'pending'; retryAfterMs: number }
  | { status: 'completed'; tokens: CodexOAuthTokens }
  | { status: 'expired' };

export class CodexDeviceAuthService {
  private readonly sessions = new Map<string, DeviceSession>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async start(signal?: AbortSignal): Promise<{
    sessionId: string;
    userCode: string;
    verificationUri: string;
    intervalSeconds: number;
    expiresAt: string;
  }> {
    const response = await this.fetchImpl(DEVICE_USER_CODE_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Codex device login 启动失败（HTTP ${response.status}）`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const deviceAuthId = typeof payload.device_auth_id === 'string' ? payload.device_auth_id : '';
    const userCode = typeof payload.user_code === 'string' ? payload.user_code : '';
    const intervalSeconds = typeof payload.interval === 'number'
      ? payload.interval
      : Number(payload.interval);
    if (!deviceAuthId || !userCode) {
      throw new Error('Codex device login 响应字段不完整');
    }
    const normalizedIntervalSeconds = Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds
      : DEFAULT_POLL_INTERVAL_SECONDS;
    const now = Date.now();
    const session: DeviceSession = {
      id: randomUUID(),
      deviceAuthId,
      userCode,
      intervalMs: Math.max(1_000, normalizedIntervalSeconds * 1_000),
      nextPollAt: now,
      expiresAt: now + DEVICE_SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    this.pruneExpired(now);
    return {
      sessionId: session.id,
      userCode,
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: Math.ceil(session.intervalMs / 1_000),
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async poll(sessionId: string, signal?: AbortSignal): Promise<CodexDevicePollResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Codex device login 会话不存在或已结束');
    const now = Date.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(sessionId);
      return { status: 'expired' };
    }
    if (session.completedTokens) return { status: 'completed', tokens: session.completedTokens };
    if (session.nextPollAt > now) {
      return { status: 'pending', retryAfterMs: session.nextPollAt - now };
    }
    // Advance before the HTTP call so duplicate admin polling cannot create concurrent token polls.
    session.nextPollAt = now + session.intervalMs;
    const response = await this.fetchImpl(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        device_auth_id: session.deviceAuthId,
        user_code: session.userCode,
      }),
      ...(signal ? { signal } : {}),
    });
    if (response.ok) {
      const payload = await response.json() as Record<string, unknown>;
      const authorizationCode = typeof payload.authorization_code === 'string'
        ? payload.authorization_code
        : '';
      const codeVerifier = typeof payload.code_verifier === 'string' ? payload.code_verifier : '';
      const codeChallenge = typeof payload.code_challenge === 'string' ? payload.code_challenge : '';
      if (!authorizationCode || !codeVerifier || !codeChallenge) {
        throw new Error('Codex device login 完成响应字段不完整');
      }
      const tokenResponse = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CODEX_OAUTH_CLIENT_ID,
          code: authorizationCode,
          code_verifier: codeVerifier,
          redirect_uri: DEVICE_REDIRECT_URI,
        }),
        ...(signal ? { signal } : {}),
      });
      session.completedTokens = await readOAuthTokenResponse(tokenResponse, 'exchange');
      return { status: 'completed', tokens: session.completedTokens };
    }

    const text = await response.text().catch(() => '');
    let errorCode = '';
    try {
      const parsed = JSON.parse(text) as { error?: string | { code?: string } };
      errorCode = typeof parsed.error === 'string' ? parsed.error : parsed.error?.code ?? '';
    } catch {
      // Status codes below are the stable pending signal; body is optional.
    }
    if (
      response.status === 403
      || response.status === 404
      || errorCode === 'deviceauth_authorization_pending'
    ) {
      return { status: 'pending', retryAfterMs: session.intervalMs };
    }
    if (errorCode === 'slow_down') {
      session.intervalMs += 5_000;
      session.nextPollAt = Date.now() + session.intervalMs;
      return { status: 'pending', retryAfterMs: session.intervalMs };
    }
    throw new Error(`Codex device login 轮询失败（HTTP ${response.status}）`);
  }

  complete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  cancel(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private pruneExpired(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}
