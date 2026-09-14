import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import type { KyAppEnrollmentService } from '../enrollment/service.js';
import type { EnrollmentOperation } from '../enrollment/types.js';
import type { KyAppOutbound } from '../outbound.js';
import type { KyAppSatIssuer } from '../sat/issuer.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { KyAppInstallation } from '../systems/types.js';
import { createKyAppEnrollmentRouter, createKyAppV2TokenRouter } from './enrollment.js';

const user = {
  sub: 'platform-admin',
  username: 'platform',
  role: 'admin',
  tenantId: 'pantheon',
} as const;
const installation: KyAppInstallation = {
  installationId: 'install-demo',
  tenantId: 'tenant-a',
  systemId: 'demo-erp',
  baseUrl: 'https://erp.example.com',
  origin: 'https://erp.example.com',
  techContactUserId: 'tech-a',
  status: 'pending',
  domainVerificationToken: null,
  domainVerifiedAt: '2026-09-14T00:00:00.000Z',
  registeredDigest: null,
  stateVersion: 1,
  authMode: 'v1_symmetric',
  deploymentId: null,
  currentKeyId: null,
  identityGeneration: 0,
  createdAt: '2026-09-14T00:00:00.000Z',
  createdBy: 'platform-admin',
  updatedAt: '2026-09-14T00:00:00.000Z',
  updatedBy: 'platform-admin',
};
const operation: EnrollmentOperation = {
  operationId: 'op-demo-001',
  installationId: installation.installationId,
  actorUserId: user.sub,
  requestDigest: 'a'.repeat(64),
  deploymentId: 'deployment-demo',
  keyId: 'A'.repeat(43),
  publicJwk: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
  origin: installation.origin,
  callbackUrl: `${installation.origin}/ky/v2/enrollment/callback`,
  callbackState: 'state-value-with-enough-entropy',
  pkceChallenge: 'p'.repeat(43),
  grantedScopes: ['installation.activate'],
  status: 'awaiting_consent',
  version: 2,
  codeExpiresAt: null,
  codeConsumedAt: null,
  grantJti: null,
  result: {},
  lastErrorCode: null,
  diagnosticId: null,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
};

const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function dependencies() {
  const systems = {
    getInstallation: vi.fn().mockResolvedValue(installation),
    getDefinition: vi.fn().mockResolvedValue({
      systemId: 'demo-erp',
      name: '演示 ERP',
      publishedDigest: 'd'.repeat(64),
    }),
  } as unknown as PgKyAppSystemStore;
  const enrollment = {
    create: vi
      .fn()
      .mockResolvedValue({ operation: { ...operation, status: 'created' }, created: true }),
    acceptChallenge: vi.fn().mockResolvedValue(operation),
    getOperation: vi.fn().mockResolvedValue(operation),
    approve: vi.fn().mockResolvedValue({
      code: 'one-time-authorization-code',
      callbackUrl: operation.callbackUrl,
      state: operation.callbackState,
      operation: { ...operation, status: 'code_issued' },
    }),
  } as unknown as KyAppEnrollmentService;
  const issuer = {
    issue: vi
      .fn()
      .mockResolvedValue({ token: 'platform-sat', kid: 'kid', jti: 'jti', expiresAt: 1 }),
  } as unknown as KyAppSatIssuer;
  const outbound = {
    request: vi.fn().mockResolvedValue({
      status: 200,
      json: { enrollmentRequest: 'signed.'.repeat(30), state: operation.callbackState },
    }),
  } as unknown as KyAppOutbound;
  let auditId = 0;
  const audit = {
    append: vi.fn().mockImplementation(async (event) => ({
      ...event,
      auditId: `audit-${++auditId}`,
      occurredAt: new Date().toISOString(),
    })),
  } as unknown as GovernanceAuditStore;
  return { systems, enrollment, issuer, outbound, audit };
}

function start(router: express.Router, authenticated = true) {
  const app = express();
  app.use(express.json());
  if (authenticated)
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  app.use('/api/app-contract/v2', router);
  const server = app.listen(0);
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/api/app-contract/v2`;
}

describe('KY App V2 enrollment routes', () => {
  it('创建 operation 后安全取得 challenge，响应只含脱敏身份', async () => {
    const deps = dependencies();
    const base = start(
      createKyAppEnrollmentRouter({
        ...deps,
        platformIssuer: 'https://agent.example.com',
        reauthenticate: vi.fn().mockResolvedValue(true),
        tenantName: () => '示例组织',
      }),
    );
    const response = await fetch(`${base}/installations/install-demo/enrollment-operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: operation.operationId }),
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).toContain('示例组织');
    expect(text).toContain(operation.keyId!.slice(0, 8));
    expect(text).not.toContain('publicJwk');
    expect(text).not.toContain('platform-sat');
    expect(deps.outbound.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/ky/v2/enrollment/challenge',
        headers: { authorization: 'Bearer platform-sat' },
        jsonBody: expect.objectContaining({ callbackUrl: operation.callbackUrl }),
      }),
    );
  });

  it('批准时重新确认当前权限和密码，返回地址只有 code 与 state', async () => {
    const deps = dependencies();
    const reauthenticate = vi.fn().mockResolvedValue(true);
    const base = start(
      createKyAppEnrollmentRouter({
        ...deps,
        platformIssuer: 'https://agent.example.com',
        reauthenticate,
      }),
    );
    const response = await fetch(`${base}/enrollment-operations/${operation.operationId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'current-password' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { redirectUrl: string };
    const redirect = new URL(body.redirectUrl);
    expect([...redirect.searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(JSON.stringify(body)).not.toContain('current-password');
    expect(reauthenticate).toHaveBeenCalledWith(user, 'current-password');
    expect(deps.audit.append).toHaveBeenCalledTimes(2);
  });

  it('token 端点要求 DPoP，并把 token 作为 no-store 响应返回', async () => {
    const exchangeAuthorizationCode = vi.fn().mockResolvedValue({
      accessToken: 'short-access-token',
      installationGrant: 'one-time-grant',
      tokenType: 'DPoP',
      expiresIn: 300,
      installationId: 'install-demo',
    });
    const enrollment = { exchangeAuthorizationCode } as unknown as KyAppEnrollmentService;
    const base = start(createKyAppV2TokenRouter({ enrollment }), false);
    const request = {
      grant_type: 'authorization_code',
      code: 'authorization-code-value',
      code_verifier: 'v'.repeat(43),
      client_assertion: 'assertion.'.repeat(12),
    };
    expect(
      (
        await fetch(`${base}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(400);
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', dpop: 'proof.'.repeat(20) },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ token_type: 'DPoP', expires_in: 300 });
  });
});
