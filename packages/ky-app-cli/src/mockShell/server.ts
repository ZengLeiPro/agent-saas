/**
 * mock 壳服务：JWKS + 壳宿主页 + 壳侧握手校验 + 令牌签发 + mock 目录服务。
 *
 * 全部跑在一个随机高位端口上（`@hono/node-server`）。它扮演 KY Agent 平台侧：
 * - `GET /.well-known/ky-app-jwks.json`：ES256 公钥（§3.1-5）
 * - `GET /shell`：壳宿主页（§5.1 的 iframe 属性、§5.2 的 URL 注入、§5.4 的握手）
 * - `POST /shell/api/nonce`：分配并绑定 ≥128 bit 的握手 nonce（绑壳会话 + 用户 + iid）
 * - `POST /shell/api/verify`：§5.4-3 壳侧校验安装证明（同 nonce 同 attestation 返回缓存结果）
 * - `GET  /shell/api/token`：签一枚 `act=user` 的 SAT（可指定 TTL 与「已过期但谎报 exp」）
 * - `/api/app-contract/v1/*`：mock 目录服务（附录 L）
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

import {
  decodeInstallationKey,
  createLocalKeyRing,
  verifyAttestation,
} from '@kaiyan/ky-app-server';
import type { KyAppConfig } from '@kaiyan/ky-app-server';

import { createMockDirectory, type MockDirectory } from './directory.js';
import { createMockSigner, type MockSigner } from './keys.js';
import { platformClaims, randomNonce, userClaims, type AppIdentity } from './sat.js';

export interface MockShellOptions {
  /** 壳自己的端口（随机高位端口，由调用方分配）。 */
  port: number;
  /** 被测项目的 origin（`KY_ORIGIN`）。 */
  appOrigin: string;
  /** 系统显示名，用于错误页文案。 */
  systemName: string;
  app: AppIdentity;
  /** 32 字节安装密钥的 hex 编码。 */
  installationKeyHex: string;
  installationKeyVersion: string;
  serviceCredential: string;
  externalLinkHosts: string[];
  /** 壳内当前登录用户（`init.user`）。 */
  user: { id: string; displayName: string; isTenantAdmin: boolean };
}

export interface NonceRecord {
  nonce: string;
  sub: string;
  iid: string;
  createdAt: number;
  /** 首次通过校验的 attestation，用于「同 nonce 同 attestation 返回缓存结果」。 */
  attestation?: string;
  result?: VerifyVerdict;
}

export interface VerifyVerdict {
  ok: boolean;
  reason?: string;
  /** 命中缓存（重复提交同一 attestation）。 */
  cached?: boolean;
  claims?: Record<string, unknown>;
}

export interface MockShell {
  origin: string;
  /** JWKS 地址，作为被测项目的 `KY_JWKS_URL`。 */
  jwksUrl: string;
  /** 目录接口基址，作为被测项目的 `KY_DIRECTORY_URL`。 */
  directoryBaseUrl: string;
  /** 壳宿主页地址。 */
  shellUrl(query?: Record<string, string>): string;
  signer: MockSigner;
  directory: MockDirectory;
  app: AppIdentity;
  /** 已分配的 nonce（供一致性测试断言绑定关系）。 */
  nonces: Map<string, NonceRecord>;
  /** 直接做一次壳侧握手校验（Node 侧调用，不经 HTTP）。 */
  verify(input: {
    nonce: string;
    attestation: string;
    installationId: string;
  }): Promise<VerifyVerdict>;
  allocateNonce(input: { sub: string; iid: string }): NonceRecord;
  close(): Promise<void>;
}

function assetUrl(file: string): URL {
  // dist/mockShell/server.js → 包根/assets；src/mockShell/server.ts → 同样退两级。
  return new URL(`../../assets/${file}`, import.meta.url);
}

async function readAsset(file: string): Promise<string> {
  return readFile(fileURLToPath(assetUrl(file)), 'utf8');
}

/** 起 mock 壳。返回后即可访问。 */
export async function createMockShell(options: MockShellOptions): Promise<MockShell> {
  const signer = await createMockSigner();
  const origin = `http://127.0.0.1:${String(options.port)}`;
  const directory = createMockDirectory({
    serviceCredential: options.serviceCredential,
    installationId: options.app.installationId,
  });
  const nonces = new Map<string, NonceRecord>();

  // 壳侧校验安装证明需要与被测项目同一套安装密钥（§3.2）。
  const attestConfig = {
    env: 'test',
    systemId: options.app.systemId,
    tenantId: options.app.tenantId,
    installationId: options.app.installationId,
    origin: options.appOrigin,
    serviceCredential: options.serviceCredential,
    issuer: options.app.issuer,
    jwksUrl: `${origin}/.well-known/ky-app-jwks.json`,
    installationKey: decodeInstallationKey(options.installationKeyHex, 'KY_INSTALLATION_KEY'),
    installationKeyVersion: options.installationKeyVersion,
    localLoginEnabled: true,
  } satisfies KyAppConfig;
  const keyRing = createLocalKeyRing(attestConfig);

  function allocateNonce(input: { sub: string; iid: string }): NonceRecord {
    const record: NonceRecord = {
      nonce: randomNonce(),
      sub: input.sub,
      iid: input.iid,
      createdAt: Date.now(),
    };
    nonces.set(record.nonce, record);
    return record;
  }

  async function verify(input: {
    nonce: string;
    attestation: string;
    installationId: string;
  }): Promise<VerifyVerdict> {
    const record = nonces.get(input.nonce);
    if (record === undefined) return { ok: false, reason: 'nonce 未登记或已失效' };
    // ≥ 128 bit（base64url ≥ 22 字符）且绑定壳会话 + 用户 + iid。
    if (record.nonce.length < 22) return { ok: false, reason: 'nonce 不足 128 bit' };
    if (record.iid !== input.installationId) {
      return { ok: false, reason: 'ready.installationId 与 nonce 绑定的 iid 不符' };
    }
    if (record.attestation !== undefined) {
      if (record.attestation === input.attestation) {
        return { ...(record.result ?? { ok: false }), cached: true };
      }
      return { ok: false, reason: '同一 nonce 收到了不同的 attestation' };
    }
    let verdict: VerifyVerdict;
    try {
      const claims = await verifyAttestation(input.attestation, {
        config: attestConfig,
        keys: keyRing,
        nonce: input.nonce,
      });
      verdict = { ok: true, claims: claims as unknown as Record<string, unknown> };
    } catch (error) {
      verdict = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    record.attestation = input.attestation;
    record.result = verdict;
    return verdict;
  }

  const shellHtml = await readAsset('shell.html');
  const forgerHtml = await readAsset('forger.html');

  const server = new Hono();

  server.get('/.well-known/ky-app-jwks.json', (c) =>
    c.json(signer.jwks(), 200, { 'cache-control': 'max-age=600' }),
  );

  server.get('/shell', (c) => c.html(shellHtml));
  server.get('/shell/forger.html', (c) => c.html(forgerHtml));

  server.get('/shell/api/config', (c) =>
    c.json({
      appOrigin: options.appOrigin,
      installationId: options.app.installationId,
      systemId: options.app.systemId,
      systemName: options.systemName,
      externalLinkHosts: options.externalLinkHosts,
      user: options.user,
    }),
  );

  server.post('/shell/api/nonce', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { sub?: string; iid?: string };
    const record = allocateNonce({
      sub: body.sub ?? options.user.id,
      iid: body.iid ?? options.app.installationId,
    });
    return c.json({ nonce: record.nonce });
  });

  server.post('/shell/api/verify', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      nonce?: string;
      attestation?: string;
      installationId?: string;
    } | null;
    if (body === null || typeof body.nonce !== 'string' || typeof body.attestation !== 'string') {
      return c.json({ ok: false, reason: '缺少 nonce 或 attestation' }, 400);
    }
    return c.json(
      await verify({
        nonce: body.nonce,
        attestation: body.attestation,
        installationId: body.installationId ?? options.app.installationId,
      }),
    );
  });

  server.get('/shell/api/token', async (c) => {
    const sub = c.req.query('sub') ?? options.user.id;
    const tadm = c.req.query('tadm') === '1';
    const ttlSeconds = Number.parseInt(c.req.query('ttl') ?? '300', 10);
    // skew > 0：签一枚**已经过期**的令牌，但对外谎报一个很远的 tokenExp，
    // 用来触发 §9.3-10 的「401 → 单飞续期 → 重放一次 GET」。
    const skew = Number.parseInt(c.req.query('skew') ?? '0', 10);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims = userClaims(options.app, {
      sub,
      tadm,
      nowSeconds: skew > 0 ? nowSeconds - skew : nowSeconds,
      ttlSeconds: skew > 0 ? Math.max(1, Math.floor(skew / 2)) : ttlSeconds,
    });
    return c.json({
      token: await signer.sign(claims),
      tokenExp: skew > 0 ? nowSeconds + 3600 : nowSeconds + ttlSeconds,
    });
  });

  // 供壳页面之外的诊断用：签一枚 platform SAT（doctor 也能直接调 signer）。
  server.get('/shell/api/platform-token', async (c) =>
    c.json({ token: await signer.sign(platformClaims(options.app, { rid: 'req_shell' })) }),
  );

  server.all('/api/app-contract/v1/*', async (c) => {
    const response = await directory.handle(c.req.raw);
    return response ?? c.json({ ok: false, error: { code: 'not_found' } }, 404);
  });

  const instance: ServerType = serve({
    fetch: server.fetch,
    port: options.port,
    hostname: '127.0.0.1',
  });

  return {
    origin,
    jwksUrl: `${origin}/.well-known/ky-app-jwks.json`,
    directoryBaseUrl: origin,
    shellUrl(query = {}) {
      const url = new URL('/shell', origin);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      return url.toString();
    },
    signer,
    directory,
    app: options.app,
    nonces,
    verify,
    allocateNonce,
    close: () =>
      new Promise<void>((resolve) => {
        instance.close(() => {
          resolve();
        });
      }),
  };
}
