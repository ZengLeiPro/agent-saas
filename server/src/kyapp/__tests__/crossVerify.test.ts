/**
 * WP2a DoD 硬条件：平台签发 ↔ 定制项目 SDK 验签的交叉测试（规范 §3.1、§3.2、§9.3、附录 I）。
 *
 * 平台侧用 `server/src/kyapp` 的实现签发 SAT / 校验安装证明；
 * 验签侧直接用 `@kaiyan/ky-app-server`（定制项目真正会装的那个包），
 * JWKS 通过内存 fetch 指向平台 `KyAppSigningKeyService.jwks()` 的真实输出。
 * 两侧任何一处不一致，这个文件就会红。
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  APH_VECTORS,
  REJECT_VECTORS,
  aph,
  canonicalizeText,
  parseIJson,
} from '@kaiyan/ky-app-contract';
import {
  MemoryJtiStore,
  createJwksClient,
  issueAttestation,
  deriveInstallationKeys,
  verifySat,
  type KyAppConfig as SdkConfig,
} from '@kaiyan/ky-app-server';

import { InMemorySecretVault } from '../../security/secretVault.js';
import { verifyKyAppAttestation } from '../attest/verify.js';
import { resolveKyAppConfig, type KyAppPlatformConfig } from '../config.js';
import { KyAppSigningKeyService } from '../keys/service.js';
import { KyAppSatIssuer } from '../sat/issuer.js';
import { KyAppSuspensionRegistry } from '../sat/suspension.js';
import type { KyAppInstallation } from '../systems/types.js';
import { FakeSigningKeyStore } from './signingKeyStoreDouble.js';

const TENANT_ID = 't_demo';
const SYSTEM_ID = 'demo-erp';
const INSTALLATION_ID = 'tsi_01';
const ORIGIN = 'https://erp.example.com';
const JWKS_URL = 'https://api.agent.kaiyan.net/.well-known/ky-app-jwks.json';
const MANIFEST_DIGEST = 'a'.repeat(64);
const PATH_PREFIXES = { user: ['/api/app/'], admin: ['/api/admin/'] };

const platformConfig = resolveKyAppConfig({
  kyApp: { environment: 'prod' },
}) as KyAppPlatformConfig;

const installation: KyAppInstallation = {
  installationId: INSTALLATION_ID,
  tenantId: TENANT_ID,
  systemId: SYSTEM_ID,
  baseUrl: ORIGIN,
  origin: ORIGIN,
  techContactUserId: 'u_tech',
  status: 'enabled',
  domainVerificationToken: null,
  domainVerifiedAt: null,
  registeredDigest: MANIFEST_DIGEST,
  stateVersion: 2,
  createdAt: '2026-09-06T00:00:00.000Z',
  createdBy: 'admin',
  updatedAt: '2026-09-06T00:00:00.000Z',
  updatedBy: 'admin',
};

const installationKey = randomBytes(32);

function sdkConfig(overrides: Partial<SdkConfig> = {}): SdkConfig {
  return {
    env: 'prod',
    systemId: SYSTEM_ID,
    tenantId: TENANT_ID,
    installationId: INSTALLATION_ID,
    origin: ORIGIN,
    serviceCredential: 'svc-token',
    issuer: platformConfig.issuer,
    jwksUrl: JWKS_URL,
    installationKey,
    installationKeyVersion: 'v1',
    localLoginEnabled: false,
    ...overrides,
  };
}

/** 平台侧 JWKS 输出直接喂给 SDK 的 JWKS 客户端，中间不做任何加工。 */
function jwksFetch(service: KyAppSigningKeyService) {
  return async (url: string): Promise<Response> => {
    expect(url).toBe(JWKS_URL);
    const document = await service.jwks();
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=600' },
    });
  };
}

function createPlatform() {
  let counter = 0;
  const keys = new KyAppSigningKeyService({
    store: new FakeSigningKeyStore() as never,
    vault: new InMemorySecretVault(),
    generateKid: () => `ky-cross-${(counter += 1)}`,
  });
  const issuer = new KyAppSatIssuer({
    config: platformConfig,
    keys,
    suspensions: new KyAppSuspensionRegistry(),
    guard: {
      getUser: async () => ({ disabled: false }),
      getMembership: async () => ({ status: 'active' }),
      getInstallation: async () => installation,
      validatesAuthEpoch: () => true,
    },
  });
  return { keys, issuer };
}

function verifyOptions(
  service: KyAppSigningKeyService,
  request: { method: string; pathname: string; requestId?: string },
  overrides: { config?: SdkConfig; jtiStore?: MemoryJtiStore } = {},
) {
  return {
    config: overrides.config ?? sdkConfig(),
    jwks: createJwksClient({ url: JWKS_URL, fetch: jwksFetch(service) }),
    jtiStore: overrides.jtiStore ?? new MemoryJtiStore(),
    request,
    pathPrefixes: PATH_PREFIXES,
    manifestDigest: MANIFEST_DIGEST,
  };
}

const userInput = {
  act: 'user' as const,
  tenantId: TENANT_ID,
  installationId: INSTALLATION_ID,
  systemId: SYSTEM_ID,
  userId: 'u_8f3a',
  tadm: true,
  pathPrefixes: PATH_PREFIXES,
  authBinding: { authEpoch: 1, generation: 1 },
};

const agentInput = {
  act: 'agent' as const,
  tenantId: TENANT_ID,
  installationId: INSTALLATION_ID,
  systemId: SYSTEM_ID,
  userId: 'u_8f3a',
  tadm: false,
  cap: 'order.create',
  lcid: 'lc_9c2',
  dig: MANIFEST_DIGEST,
  sid: 'sess_77',
  rid: 'req_x',
};

const platformInput = {
  act: 'platform' as const,
  tenantId: TENANT_ID,
  installationId: INSTALLATION_ID,
  systemId: SYSTEM_ID,
  rid: 'req_y',
};

describe('平台签发 ↔ 定制项目 SDK 验签交叉测试', () => {
  it('① 三种 act 的 SAT 都能被 SDK 用平台 JWKS 验签通过', async () => {
    const { keys, issuer } = createPlatform();

    const user = await issuer.issue(userInput);
    const userIdentity = await verifySat(
      user.token,
      verifyOptions(keys, { method: 'GET', pathname: '/ky/v1/me' }),
    );
    expect(userIdentity).toMatchObject({ act: 'user', sub: 'u_8f3a', tadm: true });
    expect(userIdentity.pfx).toEqual(['/api/app/', '/api/admin/']);
    // tadm=true 的 user 可以走 admin 前缀。
    await expect(
      verifySat(user.token, verifyOptions(keys, { method: 'GET', pathname: '/api/admin/roles' })),
    ).resolves.toMatchObject({ act: 'user' });

    const agent = await issuer.issue(agentInput);
    const agentIdentity = await verifySat(
      agent.token,
      verifyOptions(keys, {
        method: 'POST',
        pathname: '/ky/v1/capabilities/order.create',
        requestId: 'req_x',
      }),
    );
    expect(agentIdentity).toMatchObject({ act: 'agent', cap: 'order.create', lcid: 'lc_9c2' });

    const platform = await issuer.issue(platformInput);
    const platformIdentity = await verifySat(
      platform.token,
      verifyOptions(keys, { method: 'POST', pathname: '/ky/v1/events', requestId: 'req_y' }),
    );
    expect(platformIdentity).toMatchObject({ act: 'platform', tadm: false });
  });

  it('② §9.3-2 负向：错 iss/aud/tid/iid、过期、未来 nbf、未知 kid、越权路径全部被拒', async () => {
    const { keys, issuer } = createPlatform();
    const user = await issuer.issue(userInput);
    const request = { method: 'GET', pathname: '/ky/v1/me' };

    for (const [field, value] of [
      ['systemId', 'other-erp'],
      ['tenantId', 't_other'],
      ['installationId', 'tsi_99'],
      ['issuer', 'https://staging.agent.kaiyan.net'],
    ] as const) {
      await expect(
        verifySat(
          user.token,
          verifyOptions(keys, request, { config: sdkConfig({ [field]: value }) }),
        ),
      ).rejects.toThrow();
    }

    // 过期：user 的 exp 容忍是 0，TTL 5 分钟。
    const expired = new Date(Date.now() + 6 * 60 * 1000);
    await expect(
      verifySat(user.token, { ...verifyOptions(keys, request), now: () => expired.getTime() }),
    ).rejects.toThrow();

    // 未来 nbf：user 的 nbf 容忍 30 s，退回 5 分钟必然不生效。
    await expect(
      verifySat(user.token, {
        ...verifyOptions(keys, request),
        now: () => Date.now() - 5 * 60 * 1000,
      }),
    ).rejects.toThrow();

    // 未知 kid：换一套完全独立的平台密钥去签，验签端的 JWKS 里没有它。
    const other = createPlatform();
    const foreign = await other.issuer.issue(userInput);
    await expect(verifySat(foreign.token, verifyOptions(keys, request))).rejects.toThrow();

    // user 不能走能力端点；agent 不能走 /ky/v1/me；platform 的 rid 必须与请求头一致。
    await expect(
      verifySat(
        user.token,
        verifyOptions(keys, { method: 'POST', pathname: '/ky/v1/capabilities/order.create' }),
      ),
    ).rejects.toThrow();
    const agent = await issuer.issue(agentInput);
    await expect(
      verifySat(agent.token, verifyOptions(keys, { method: 'GET', pathname: '/ky/v1/me' })),
    ).rejects.toThrow();
    const platform = await issuer.issue(platformInput);
    await expect(
      verifySat(
        platform.token,
        verifyOptions(keys, { method: 'POST', pathname: '/ky/v1/events', requestId: 'req_wrong' }),
      ),
    ).rejects.toThrow();

    // agent 的 dig 必须等于当前 manifest digest，否则 409 digest_mismatch。
    const staleDigest = await issuer.issue({ ...agentInput, dig: 'b'.repeat(64) });
    await expect(
      verifySat(
        staleDigest.token,
        verifyOptions(keys, {
          method: 'POST',
          pathname: '/ky/v1/capabilities/order.create',
          requestId: 'req_x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'digest_mismatch' });

    // jti 单次消费：同一 agent SAT 第二次使用被判重放。
    const jtiStore = new MemoryJtiStore();
    const replayRequest = {
      method: 'POST',
      pathname: '/ky/v1/capabilities/order.create',
      requestId: 'req_x',
    };
    await expect(
      verifySat(agent.token, verifyOptions(keys, replayRequest, { jtiStore })),
    ).resolves.toMatchObject({ act: 'agent' });
    await expect(
      verifySat(agent.token, verifyOptions(keys, replayRequest, { jtiStore })),
    ).rejects.toMatchObject({ code: 'token_replayed' });
  });

  it('③ 轮换：next 进 JWKS 后新旧 kid 都可验，revoke 后旧 kid 立即被拒', async () => {
    const { keys, issuer } = createPlatform();
    const request = { method: 'GET', pathname: '/ky/v1/me' };
    const oldKey = await keys.ensureActive();
    const beforeRotate = await issuer.issue(userInput);

    const rotated = await keys.rotate();
    expect((await keys.jwks()).keys).toHaveLength(2);
    await keys.promote(rotated.newKid, rotated.newKid);
    const afterRotate = await issuer.issue(userInput);
    expect(afterRotate.kid).toBe(rotated.newKid);

    // 旧 kid 仍是 retiring，仍在 JWKS，旧令牌照常可验。
    await expect(
      verifySat(beforeRotate.token, verifyOptions(keys, request)),
    ).resolves.toMatchObject({
      kid: oldKey.kid,
    });
    await expect(verifySat(afterRotate.token, verifyOptions(keys, request))).resolves.toMatchObject(
      {
        kid: rotated.newKid,
      },
    );

    // 紧急撤销后旧 kid 立刻出 JWKS，旧令牌不再可验；新 kid 不受影响。
    await keys.revoke(oldKey.kid);
    expect((await keys.jwks()).keys).toHaveLength(1);
    await expect(verifySat(beforeRotate.token, verifyOptions(keys, request))).rejects.toThrow();
    await expect(verifySat(afterRotate.token, verifyOptions(keys, request))).resolves.toMatchObject(
      {
        kid: rotated.newKid,
      },
    );
  });

  it('④ SDK 出票的安装证明能被平台校验，篡改 origin/iid/kid 与过期一律被拒', async () => {
    const nonce = randomBytes(16).toString('base64url');
    const sdkKeys = deriveInstallationKeys(installationKey, 'v1');
    const nowMs = Date.parse('2026-09-06T00:00:00Z');
    const token = await issueAttestation({
      nonce,
      dig: MANIFEST_DIGEST,
      origin: ORIGIN,
      iid: INSTALLATION_ID,
      audience: platformConfig.issuer,
      keys: sdkKeys,
      nowMs,
    });
    const base = {
      token,
      installationId: INSTALLATION_ID,
      expectedOrigin: ORIGIN,
      audience: platformConfig.issuer,
      nonce,
      keys: [{ keyVersion: 'v1', installationKey }],
      nowMs,
    };
    await expect(verifyKyAppAttestation(base)).resolves.toMatchObject({
      iid: INSTALLATION_ID,
      origin: ORIGIN,
      nonce,
      dig: MANIFEST_DIGEST,
    });

    await expect(
      verifyKyAppAttestation({ ...base, expectedOrigin: 'https://evil.example.com' }),
    ).rejects.toMatchObject({ reason: 'origin_mismatch' });
    await expect(
      verifyKyAppAttestation({ ...base, installationId: 'tsi_99' }),
    ).rejects.toMatchObject({ reason: 'iss_mismatch' });
    await expect(
      verifyKyAppAttestation({ ...base, nonce: 'other-nonce-0123456789' }),
    ).rejects.toMatchObject({
      reason: 'nonce_mismatch',
    });
    // exp = iat + 60，容忍 0。
    await expect(verifyKyAppAttestation({ ...base, nowMs: nowMs + 61_000 })).rejects.toMatchObject({
      reason: 'signature_invalid',
    });
    await expect(
      verifyKyAppAttestation({ ...base, keys: [{ keyVersion: 'v2', installationKey }] }),
    ).rejects.toMatchObject({ reason: 'unknown_kid' });
    await expect(
      verifyKyAppAttestation({
        ...base,
        keys: [{ keyVersion: 'v1', installationKey: randomBytes(32) }],
      }),
    ).rejects.toMatchObject({ reason: 'signature_invalid' });
  });

  it('⑤ 附录 I 六个 aph 向量与三个拒绝向量在 server 侧经契约包复算一致', () => {
    for (const vector of APH_VECTORS) {
      const parsed = parseIJson(vector.json) as { cap: string; input: unknown };
      expect(aph({ cap: parsed.cap, input: parsed.input })).toBe(vector.aph);
      if (vector.canonical) expect(canonicalizeText(vector.json)).toBe(vector.canonical);
    }
    for (const vector of REJECT_VECTORS) {
      expect(() => parseIJson(vector.json)).toThrowError(
        expect.objectContaining({ code: vector.code }),
      );
    }
  });
});
