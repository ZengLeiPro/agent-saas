import type { AddressInfo } from 'node:net';

import {
  V2_JWT_TYP,
  V2_WORKLOAD_AUDIENCE,
  accessTokenHash,
  normalizeDpopHtu,
  p256JwkThumbprint,
  type P256PublicJwk,
} from '@kaiyan/ky-app-contract';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import type { KyAppCredentialManager } from '../installations/credentials.js';
import type { KyAppInstallation } from '../systems/types.js';
import { KyAppV2Authenticator } from '../workload/authenticator.js';
import type { ReplayReservationStore } from '../workload/replayStore.js';
import { createKyAppDirectoryRouter } from './directory.js';

const nowMs = Date.parse('2026-09-14T08:00:00.000Z');
const now = Math.floor(nowMs / 1000);
const issuer = 'https://platform.example.com';
const installation: KyAppInstallation = {
  installationId: 'install-v2',
  tenantId: 'tenant-v2',
  systemId: 'demo-erp',
  baseUrl: 'https://business.example.com',
  origin: 'https://business.example.com',
  techContactUserId: 'admin-1',
  status: 'enabled',
  domainVerificationToken: null,
  domainVerifiedAt: new Date(nowMs).toISOString(),
  registeredDigest: 'a'.repeat(64),
  stateVersion: 1,
  authMode: 'v2_asymmetric',
  deploymentId: 'deployment-v2',
  currentKeyId: null,
  identityGeneration: 1,
  createdAt: new Date(nowMs).toISOString(),
  createdBy: 'admin-1',
  updatedAt: new Date(nowMs).toISOString(),
  updatedBy: 'admin-1',
};

const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('V2 directory resource server', () => {
  it('轮换窗口内用 previous workload token + DPoP 拉取分页，且不读取 V1 安装秘密', async () => {
    const platform = await generateKeyPair('ES256', { extractable: true });
    const deployment = await generateKeyPair('ES256', { extractable: true });
    const platformJwk = (await exportJWK(platform.publicKey)) as P256PublicJwk;
    const deploymentJwk = (await exportJWK(deployment.publicKey)) as P256PublicJwk;
    const platformKeyId = p256JwkThumbprint(platformJwk);
    const deploymentKeyId = p256JwkThumbprint(deploymentJwk);
    const currentKeyId = 'N'.repeat(43);
    installation.currentKeyId = currentKeyId;
    installation.identityGeneration = 2;
    let acceptPrevious = true;
    const used = new Set<string>();
    const replays: ReplayReservationStore = {
      reserve: async ({ keyId, jti }) => {
        const key = `${keyId}:${jti}`;
        if (used.has(key)) return false;
        used.add(key);
        return true;
      },
      reserveMany: async () => 'reserved',
      deleteExpired: async () => 0,
    };
    const authenticator = new KyAppV2Authenticator({
      issuer,
      tokenEndpoint: `${issuer}/api/app-contract/v2/oauth/token`,
      installations: { getInstallation: async () => installation } as never,
      deploymentKeys: {
        listAccepted: async () => [
          {
            installationId: installation.installationId,
            deploymentId: installation.deploymentId!,
            keyId: currentKeyId,
            publicJwk: deploymentJwk,
            status: 'current',
            notBefore: new Date(nowMs).toISOString(),
            acceptUntil: null,
            revokedAt: null,
            generation: 2,
          },
          ...(acceptPrevious
            ? [
                {
                  installationId: installation.installationId,
                  deploymentId: installation.deploymentId!,
                  keyId: deploymentKeyId,
                  publicJwk: deploymentJwk,
                  status: 'previous',
                  notBefore: new Date(nowMs).toISOString(),
                  acceptUntil: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
                  revokedAt: null,
                  generation: 1,
                } as const,
              ]
            : []),
        ],
      },
      platformKeys: {
        get: async () => ({
          publicJwk: platformJwk as unknown as Record<string, unknown>,
          status: 'active',
        }),
      },
      replays,
      now: () => nowMs,
    });
    const accessToken = await new SignJWT({
      tid: installation.tenantId,
      iid: installation.installationId,
      sid: installation.systemId,
      client_id: installation.deploymentId,
      scope: 'directory.snapshot',
      cnf: { jkt: deploymentKeyId },
      generation: 1,
    })
      .setProtectedHeader({ alg: 'ES256', typ: V2_JWT_TYP.workloadAccessToken, kid: platformKeyId })
      .setIssuer(issuer)
      .setSubject(installation.installationId)
      .setAudience(V2_WORKLOAD_AUDIENCE)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 300)
      .setJti('workload-jti-0001')
      .sign(platform.privateKey);

    let baseUrl = '';
    const publicApiBaseUrl = 'https://api.example.test';
    const credentials = {
      authenticate: async () => {
        throw new Error('V1 credential must not be read');
      },
      listAcceptableInstallationKeys: async () => {
        throw new Error('V1 installation key must not be read');
      },
    } as unknown as KyAppCredentialManager;
    const app = express();
    app.use(
      '/api/app-contract/v1',
      createKyAppDirectoryRouter({
        credentials,
        getInstallation: async () => installation,
        snapshots: {
          readPage: async ({ page }) =>
            page === 0
              ? {
                  snapshotSeq: 8,
                  users: [
                    {
                      userId: 'user-1',
                      displayName: '测试用户',
                      status: 'active',
                      isTenantAdmin: false,
                      groupIds: [],
                    },
                  ],
                  groups: [],
                  hasMore: true,
                }
              : {
                  snapshotSeq: 8,
                  users: [],
                  groups: [{ groupId: 'group-1', displayName: '测试部门', status: 'active' }],
                  hasMore: false,
                },
        },
        changes: {
          retentionFloorSeq: async () => 0,
          listAfter: async () => ({ records: [], nextSeq: 0, hasMore: false }),
        },
        now: () => nowMs,
        pageSize: 1,
        v2: {
          authenticator,
          apiBaseUrl: publicApiBaseUrl,
          pageTokenKeys: async () => [
            { keyVersion: 'platform:test', installationKey: new Uint8Array(32).fill(7) },
          ],
        },
      }),
    );
    const server = app.listen(0);
    servers.push(server);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const requestPage = async (url: string, jti: string) => {
      const proofUrl = `${publicApiBaseUrl}${new URL(url).pathname}${new URL(url).search}`;
      const proof = await new SignJWT({
        htm: 'GET',
        htu: normalizeDpopHtu(proofUrl),
        iat: now,
        jti,
        ath: accessTokenHash(accessToken),
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: deploymentJwk })
        .sign(deployment.privateKey);
      return fetch(url, { headers: { authorization: `DPoP ${accessToken}`, dpop: proof } });
    };
    const firstUrl = `${baseUrl}/api/app-contract/v1/directory/snapshot`;
    const first = await requestPage(firstUrl, 'dpop-directory-page-1');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { pageToken?: string; users: unknown[] };
    expect(firstBody.users).toHaveLength(1);
    expect(firstBody.pageToken).toBeTypeOf('string');
    const secondUrl = `${firstUrl}?pageToken=${encodeURIComponent(firstBody.pageToken!)}`;
    const second = await requestPage(secondUrl, 'dpop-directory-page-2');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ snapshotSeq: 8, groups: [{ groupId: 'group-1' }] });
    acceptPrevious = false;
    const expired = await requestPage(firstUrl, 'dpop-directory-after-window');
    expect(expired.status).toBe(401);
  });
});
