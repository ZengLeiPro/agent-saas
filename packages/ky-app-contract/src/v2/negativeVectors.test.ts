import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { P256PublicJwk } from '../types/enrollment.js';
import { accessTokenHash, p256JwkThumbprint, verifyPkceS256 } from './crypto.js';
import { V2ContractError } from './errors.js';
import {
  verifyEnrollmentRequest,
  verifyInstallationGrant,
  verifyV2Attestation,
} from './enrollment.js';
import {
  assertReplayReservation,
  verifyClientAssertion,
  verifyDpopProof,
  verifyWorkloadAccessToken,
} from './workload.js';

interface SourceVector {
  id: string;
  signer: 'platform' | 'deployment';
  protected: Record<string, unknown>;
  payload: Record<string, unknown>;
}
interface NegativeCase {
  id: string;
  source: string;
  mutation: Record<string, unknown>;
  expectedError: string;
  stage: string;
}
interface Fixture {
  verificationTime: string;
  keys: { platform: { keyId: string }; deployment: { keyId: string } };
  context: Record<string, string>;
  vectors: SourceVector[];
}

const vectorRoot = new URL('../../test-vectors/v2/', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('positive.json', vectorRoot), 'utf8')) as Fixture;
const negative = JSON.parse(await readFile(new URL('negative.json', vectorRoot), 'utf8')) as {
  cases: NegativeCase[];
};

const makeKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey as P256PublicJwk;
  return { privateKey, publicJwk, keyId: p256JwkThumbprint(publicJwk) };
};
const keys = { platform: makeKey(), deployment: makeKey() };

const rewriteIdentity = (value: unknown): unknown => {
  if (typeof value === 'string') {
    if (value === fixture.keys.platform.keyId) return keys.platform.keyId;
    if (value === fixture.keys.deployment.keyId) return keys.deployment.keyId;
    return value;
  }
  if (Array.isArray(value)) return value.map(rewriteIdentity);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.kty === 'EC' && record.crv === 'P-256' && record.x && record.y) {
      return { ...keys.deployment.publicJwk };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, rewriteIdentity(item)]),
    );
  }
  return value;
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signCompact = (
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
) => {
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${signingInput}.${signature}`;
};

interface RuntimeVector extends SourceVector {
  compact: string;
}
const runtimeVectors = new Map<string, RuntimeVector>();
for (const item of fixture.vectors) {
  const header = rewriteIdentity(structuredClone(item.protected)) as Record<string, unknown>;
  const payload = rewriteIdentity(structuredClone(item.payload)) as Record<string, unknown>;
  if (item.id === 'dpop-resource-valid') {
    payload.ath = accessTokenHash(runtimeVectors.get('workload-token-valid')!.compact);
  }
  runtimeVectors.set(item.id, {
    ...item,
    protected: header,
    payload,
    compact: signCompact(header, payload, keys[item.signer].privateKey),
  });
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = rewriteIdentity(value);
}

function mutate(testCase: NegativeCase): { compact: string; context: Record<string, unknown> } {
  const source = runtimeVectors.get(testCase.source)!;
  const header = structuredClone(source.protected);
  const payload = structuredClone(source.payload);
  const mutation = testCase.mutation as {
    replaceProtected?: Record<string, unknown>;
    replacePayload?: Record<string, unknown>;
    deletePayload?: string[];
    resignWith?: 'platform' | 'deployment';
    requestContext?: Record<string, unknown>;
  };
  for (const [path, value] of Object.entries(mutation.replaceProtected ?? {})) {
    setPath(header, path, value);
  }
  for (const [path, value] of Object.entries(mutation.replacePayload ?? {})) {
    setPath(payload, path, value);
  }
  for (const path of mutation.deletePayload ?? []) delete payload[path];
  const compact = mutation.resignWith
    ? signCompact(header, payload, keys[mutation.resignWith].privateKey)
    : `${encode(header)}.${encode(payload)}.${source.compact.split('.')[2]}`;
  return { compact, context: mutation.requestContext ?? {} };
}

const now = Date.parse(fixture.verificationTime) / 1000;
const common = fixture.context;
const platformAudience = `${common.platformIssuer}/ky-app-prober`;
const manifestDigest = '5f1f28fb6b66646fd604fb9d124f2cbd6d3d3c5d8db14f967f22721b8fbd37f7';

function verifyNegative(testCase: NegativeCase): void {
  const { compact, context } = mutate(testCase);
  switch (testCase.source) {
    case 'enrollment-request-valid': {
      const result = verifyEnrollmentRequest(compact, {
        platformIssuer: common.platformIssuer!,
        tenantId: common.tenantId!,
        installationId: common.installationId!,
        systemId: common.systemId!,
        deploymentId: common.deploymentId!,
        origin: common.origin!,
        callbackUrl: common.callback!,
        nonce: 'platform-challenge-nonce-001',
        now,
      });
      if (context.codeVerifier)
        verifyPkceS256(String(context.codeVerifier), result.claims.code_challenge);
      return;
    }
    case 'installation-grant-valid':
      if (context.verifier === 'verifyWorkloadAccessToken') {
        verifyWorkloadAccessToken(compact, workloadOptions());
        return;
      }
      verifyInstallationGrant(compact, {
        platformPublicJwk: keys.platform.publicJwk,
        platformKeyId: keys.platform.keyId,
        platformIssuer: common.platformIssuer!,
        deploymentId: common.deploymentId!,
        tenantId: common.tenantId!,
        installationId: common.installationId!,
        systemId: common.systemId!,
        origin: common.origin!,
        keyId: keys.deployment.keyId,
        now,
      });
      return;
    case 'client-assertion-valid': {
      verifyClientAssertion(compact, {
        deploymentPublicJwk: keys.deployment.publicJwk,
        deploymentId: common.deploymentId!,
        installationId: common.installationId!,
        keyId: keys.deployment.keyId,
        tokenEndpoint: common.tokenEndpoint!,
        now: context.verificationTime ? Date.parse(String(context.verificationTime)) / 1000 : now,
      });
      if (testCase.mutation.replay) assertReplayReservation(false, 'client_assertion');
      return;
    }
    case 'workload-token-valid':
      verifyWorkloadAccessToken(compact, workloadOptions(context));
      return;
    case 'dpop-token-endpoint-valid':
    case 'dpop-resource-valid': {
      const resource = testCase.source === 'dpop-resource-valid';
      verifyDpopProof(compact, {
        method: resource ? 'GET' : 'POST',
        requestUrl: resource ? common.resourceRequestUrl! : common.tokenEndpoint!,
        now,
        ...(resource
          ? {
              accessToken:
                context.accessToken === undefined
                  ? runtimeVectors.get('workload-token-valid')!.compact
                  : String(context.accessToken),
              expectedKeyId: String(context.tokenCnfJkt ?? keys.deployment.keyId),
            }
          : { nonce: 'platform-dpop-nonce-001' }),
      });
      if (testCase.mutation.replay) assertReplayReservation(false, 'dpop');
      return;
    }
    case 'attest-valid':
      verifyV2Attestation(compact, {
        deploymentPublicJwk: keys.deployment.publicJwk,
        deploymentId: common.deploymentId!,
        keyId: keys.deployment.keyId,
        platformAudience,
        tenantId: common.tenantId!,
        installationId: common.installationId!,
        systemId: common.systemId!,
        generation: 1,
        nonce: 'attest-nonce-001',
        manifestDigest,
        now,
      });
      return;
    default:
      throw new Error(`未知 source ${testCase.source}`);
  }
}

function workloadOptions(context: Record<string, unknown> = {}) {
  return {
    platformPublicJwk: keys.platform.publicJwk,
    platformKeyId: keys.platform.keyId,
    platformIssuer: common.platformIssuer!,
    tenantId: common.tenantId!,
    installationId: String(context.installationId ?? common.installationId),
    systemId: common.systemId!,
    deploymentId: common.deploymentId!,
    keyId: keys.deployment.keyId,
    generation: Number(context.currentGeneration ?? 1),
    installationStatus: (context.installationStatus ?? 'enabled') as
      'enabled' | 'disabled' | 'revoked',
    authorizationScheme: String(context.authorizationScheme ?? 'DPoP'),
    now,
  };
}

describe('38 个冻结负向向量由 V2 verifier fail closed', () => {
  it.each(negative.cases)('$id -> $expectedError', (testCase) => {
    try {
      verifyNegative(testCase);
      throw new Error(`${testCase.id} 应拒绝但成功`);
    } catch (error) {
      expect(error, testCase.id).toBeInstanceOf(V2ContractError);
      expect((error as V2ContractError).code, testCase.id).toBe(testCase.expectedError);
      expect((error as V2ContractError).stage, testCase.id).toBe(testCase.stage);
    }
  });
});

describe('DPoP iat 类型安全', () => {
  it('拒绝签名有效但 iat 为字符串的 proof', () => {
    const source = runtimeVectors.get('dpop-token-endpoint-valid')!;
    const compact = signCompact(
      source.protected,
      { ...source.payload, iat: 'not-a-time' },
      keys.deployment.privateKey,
    );

    expect(() =>
      verifyDpopProof(compact, {
        method: 'POST',
        requestUrl: common.tokenEndpoint!,
        nonce: 'platform-dpop-nonce-001',
        now,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_claims', stage: 'claims' }));
  });
});
