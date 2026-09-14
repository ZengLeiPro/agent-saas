import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { P256PublicJwk } from '../types/enrollment.js';
import { pkceS256 } from './crypto.js';
import { V2ContractError } from './errors.js';
import { verifyEnrollmentRequest, verifyInstallationGrant, verifyV2Attestation } from './enrollment.js';
import { parseJsonWithoutDuplicateKeys } from './json.js';
import { verifyClientAssertion, verifyDpopProof, verifyWorkloadAccessToken } from './workload.js';

interface Vector {
  id: string;
  compact: string;
}

interface Fixture {
  verificationTime: string;
  keys: {
    platform: { keyId: string; publicJwk: P256PublicJwk };
    deployment: { keyId: string; publicJwk: P256PublicJwk };
  };
  context: Record<string, string>;
  vectors: Vector[];
}

const fixture = JSON.parse(
  await readFile(new URL('../../test-vectors/v2/positive.json', import.meta.url), 'utf8'),
) as Fixture;
const vector = (id: string) => {
  const found = fixture.vectors.find((item) => item.id === id);
  if (!found) throw new Error(`缺少测试向量 ${id}`);
  return found.compact;
};
const now = Date.parse(fixture.verificationTime) / 1000;
const context = fixture.context;

describe('KY App V2 冻结正向向量', () => {
  it('PKCE 测试 verifier 可复算', () => {
    expect(pkceS256(context.pkceVerifier!)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('enrollment request 绑定组织、实例、部署、公钥和 callback', () => {
    expect(
      verifyEnrollmentRequest(vector('enrollment-request-valid'), {
        platformIssuer: context.platformIssuer!,
        tenantId: context.tenantId!,
        installationId: context.installationId!,
        systemId: context.systemId!,
        deploymentId: context.deploymentId!,
        origin: context.origin!,
        callbackUrl: context.callback!,
        nonce: 'platform-challenge-nonce-001',
        now,
      }).keyId,
    ).toBe(fixture.keys.deployment.keyId);
  });

  it('平台 grant 与 workload token 只能由平台 key 验证', () => {
    expect(
      verifyInstallationGrant(vector('installation-grant-valid'), {
        platformPublicJwk: fixture.keys.platform.publicJwk,
        platformKeyId: fixture.keys.platform.keyId,
        platformIssuer: context.platformIssuer!,
        deploymentId: context.deploymentId!,
        tenantId: context.tenantId!,
        installationId: context.installationId!,
        systemId: context.systemId!,
        origin: context.origin!,
        keyId: fixture.keys.deployment.keyId,
        now,
      }).generation,
    ).toBe(1);
    expect(
      verifyWorkloadAccessToken(vector('workload-token-valid'), {
        platformPublicJwk: fixture.keys.platform.publicJwk,
        platformKeyId: fixture.keys.platform.keyId,
        platformIssuer: context.platformIssuer!,
        tenantId: context.tenantId!,
        installationId: context.installationId!,
        systemId: context.systemId!,
        deploymentId: context.deploymentId!,
        keyId: fixture.keys.deployment.keyId,
        generation: 1,
        requiredScope: 'directory.snapshot',
        installationStatus: 'enabled',
        authorizationScheme: 'DPoP',
        now,
      }).cnf.jkt,
    ).toBe(fixture.keys.deployment.keyId);
  });

  it('client assertion、token endpoint DPoP 和资源 DPoP 全部有效', () => {
    expect(
      verifyClientAssertion(vector('client-assertion-valid'), {
        deploymentPublicJwk: fixture.keys.deployment.publicJwk,
        deploymentId: context.deploymentId!,
        installationId: context.installationId!,
        keyId: fixture.keys.deployment.keyId,
        tokenEndpoint: context.tokenEndpoint!,
        now,
      }).replayKey,
    ).toContain(fixture.keys.deployment.keyId);
    expect(
      verifyDpopProof(vector('dpop-token-endpoint-valid'), {
        method: 'POST',
        requestUrl: context.tokenEndpoint!,
        nonce: 'platform-dpop-nonce-001',
        now,
      }).keyId,
    ).toBe(fixture.keys.deployment.keyId);
    expect(
      verifyDpopProof(vector('dpop-resource-valid'), {
        method: 'GET',
        requestUrl: context.resourceRequestUrl!,
        accessToken: vector('workload-token-valid'),
        expectedKeyId: fixture.keys.deployment.keyId,
        now,
      }).keyId,
    ).toBe(fixture.keys.deployment.keyId);
  });

  it('ES256 attest 绑定当前 digest、nonce 和 generation', () => {
    expect(
      verifyV2Attestation(vector('attest-valid'), {
        deploymentPublicJwk: fixture.keys.deployment.publicJwk,
        deploymentId: context.deploymentId!,
        keyId: fixture.keys.deployment.keyId,
        platformAudience: `${context.platformIssuer}/ky-app-prober`,
        tenantId: context.tenantId!,
        installationId: context.installationId!,
        systemId: context.systemId!,
        generation: 1,
        nonce: 'attest-nonce-001',
        manifestDigest: '5f1f28fb6b66646fd604fb9d124f2cbd6d3d3c5d8db14f967f22721b8fbd37f7',
        now,
      }).ready,
    ).toBe(true);
  });
});

describe('KY App V2 fail closed 边界', () => {
  const expectCode = (run: () => unknown, code: string) => {
    try {
      run();
      throw new Error('应拒绝但成功');
    } catch (error) {
      expect(error).toBeInstanceOf(V2ContractError);
      expect((error as V2ContractError).code).toBe(code);
    }
  };

  it('拒绝重复 JSON key', () => {
    expectCode(() => parseJsonWithoutDuplicateKeys('{"alg":"ES256","alg":"none"}'), 'malformed_jose');
  });

  it('拒绝 Bearer 降级、停用安装、scope 越权和错误 generation', () => {
    const base = {
      platformPublicJwk: fixture.keys.platform.publicJwk,
      platformKeyId: fixture.keys.platform.keyId,
      platformIssuer: context.platformIssuer!,
      tenantId: context.tenantId!,
      installationId: context.installationId!,
      systemId: context.systemId!,
      deploymentId: context.deploymentId!,
      keyId: fixture.keys.deployment.keyId,
      generation: 1,
      now,
    };
    expectCode(
      () => verifyWorkloadAccessToken(vector('workload-token-valid'), { ...base, authorizationScheme: 'Bearer' }),
      'dpop_required',
    );
    expectCode(
      () => verifyWorkloadAccessToken(vector('workload-token-valid'), { ...base, installationStatus: 'revoked' }),
      'installation_inactive',
    );
    expectCode(
      () => verifyWorkloadAccessToken(vector('workload-token-valid'), { ...base, requiredScope: 'installation.keys.rotate' }),
      'insufficient_scope',
    );
    expectCode(
      () => verifyWorkloadAccessToken(vector('workload-token-valid'), { ...base, generation: 2 }),
      'key_generation_mismatch',
    );
  });

  it('资源 DPoP 拒绝错 token、错 key 和错 method', () => {
    const base = { method: 'GET', requestUrl: context.resourceRequestUrl!, now };
    expectCode(
      () => verifyDpopProof(vector('dpop-resource-valid'), { ...base, accessToken: 'wrong' }),
      'invalid_dpop_proof',
    );
    expectCode(
      () => verifyDpopProof(vector('dpop-resource-valid'), { ...base, expectedKeyId: fixture.keys.platform.keyId }),
      'dpop_key_mismatch',
    );
    expectCode(
      () => verifyDpopProof(vector('dpop-resource-valid'), { ...base, method: 'POST' }),
      'invalid_dpop_proof',
    );
  });
});
