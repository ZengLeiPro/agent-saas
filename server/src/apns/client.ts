import http2 from 'node:http2';
import jwt from 'jsonwebtoken';

import type { ApnsEnvironment } from '../app/pushConfigSchema.js';

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};
/** Apple 要求 provider token 20～60 分钟内刷新；50 分钟留足余量。 */
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_COLLAPSE_ID_BYTES = 64;
const PROVIDER_TOKEN_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

export interface ApnsAlertRequest {
  deviceToken: string;
  title: string;
  body: string;
  /** apns-collapse-id：同一事件多次投递只保留一条。 */
  collapseId: string;
  /** 站内相对路径，随 payload 下发供 App 深链。 */
  url: string;
  ttlSeconds?: number;
}

export type ApnsSendResult = { ok: true } | { ok: false; status: number; reason: string };

export interface ApnsPushClient {
  send(request: ApnsAlertRequest): Promise<ApnsSendResult>;
  close(): void;
}

export interface ApnsHttp2ClientOptions {
  teamId: string;
  keyId: string;
  /** .p8 PEM 全文。 */
  privateKey: string;
  bundleId: string;
  environment: ApnsEnvironment;
  /** 测试注入；默认 node:http2。 */
  connect?: typeof http2.connect;
  now?: () => number;
}

/**
 * APNs HTTP/2 直发（Token-based 鉴权）。单个 session 长连接复用，断开后按需重连；
 * provider token 过期/无效时刷新一次并重试，其它错误原样返回给调用方决定是否失效设备。
 */
export class ApnsHttp2Client implements ApnsPushClient {
  private session: http2.ClientHttp2Session | undefined;
  private providerToken: { value: string; issuedAt: number } | undefined;
  private readonly connectFn: typeof http2.connect;
  private readonly now: () => number;

  constructor(private readonly options: ApnsHttp2ClientOptions) {
    this.connectFn = options.connect ?? http2.connect;
    this.now = options.now ?? Date.now;
  }

  get host(): string {
    return APNS_HOSTS[this.options.environment];
  }

  async send(request: ApnsAlertRequest): Promise<ApnsSendResult> {
    const first = await this.request(request, false);
    if (!first.ok && first.status === 403 && PROVIDER_TOKEN_REASONS.has(first.reason)) {
      return this.request(request, true);
    }
    return first;
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
  }

  private currentProviderToken(forceRefresh: boolean): string {
    const issuedAt = this.now();
    if (
      !forceRefresh &&
      this.providerToken &&
      issuedAt - this.providerToken.issuedAt < PROVIDER_TOKEN_TTL_MS
    ) {
      return this.providerToken.value;
    }
    const value = jwt.sign(
      { iss: this.options.teamId, iat: Math.floor(issuedAt / 1000) },
      this.options.privateKey,
      { algorithm: 'ES256', keyid: this.options.keyId },
    );
    this.providerToken = { value, issuedAt };
    return value;
  }

  private getSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = this.connectFn(this.host);
    const forget = () => {
      if (this.session === session) this.session = undefined;
    };
    session.on('error', forget);
    session.on('close', forget);
    session.on('goaway', forget);
    this.session = session;
    return session;
  }

  private request(request: ApnsAlertRequest, refreshToken: boolean): Promise<ApnsSendResult> {
    const token = this.currentProviderToken(refreshToken);
    const payload = JSON.stringify({
      aps: {
        alert: { title: request.title.slice(0, 120), body: request.body.slice(0, 120) },
        sound: 'default',
      },
      url: request.url,
    });
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${request.deviceToken}`,
      authorization: `bearer ${token}`,
      'apns-topic': this.options.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(this.now() / 1000) + (request.ttlSeconds ?? 3600)),
      'apns-collapse-id': truncateBytes(request.collapseId, MAX_COLLAPSE_ID_BYTES),
      'content-type': 'application/json',
    };

    return new Promise<ApnsSendResult>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      let stream: http2.ClientHttp2Stream;
      try {
        stream = this.getSession().request(headers);
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        settle(() => reject(new Error('APNs 请求超时')));
      }, REQUEST_TIMEOUT_MS);

      let status = 0;
      const chunks: Buffer[] = [];
      stream.on('response', (responseHeaders) => {
        status = Number(responseHeaders[':status'] ?? 0);
      });
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      stream.on('end', () => {
        settle(() => {
          if (status === 200) {
            resolve({ ok: true });
            return;
          }
          resolve({
            ok: false,
            status,
            reason: parseReason(Buffer.concat(chunks).toString('utf8')),
          });
        });
      });
      stream.on('error', (error) => {
        settle(() => reject(error));
      });
      stream.end(payload);
    });
  }
}

export function createApnsClients(
  config: Omit<ApnsHttp2ClientOptions, 'environment'>,
): (environment: ApnsEnvironment) => ApnsPushClient {
  const clients = new Map<ApnsEnvironment, ApnsPushClient>();
  return (environment) => {
    let client = clients.get(environment);
    if (!client) {
      client = new ApnsHttp2Client({ ...config, environment });
      clients.set(environment, client);
    }
    return client;
  };
}

function parseReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : 'Unknown';
  } catch {
    return body.trim().slice(0, 120) || 'Unknown';
  }
}

function truncateBytes(value: string, maxBytes: number): string {
  let out = value;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}
