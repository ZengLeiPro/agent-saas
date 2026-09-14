import { randomBytes, randomUUID } from 'node:crypto';

import {
  V2_ENDPOINTS,
  manifestDigest,
  validateMe,
  verifyV2Attestation,
  type Manifest,
} from '@kaiyan/ky-app-contract';

import type { GovernanceActor } from '../../data/governance-audit/recorder.js';
import type { KyAppPlatformConfig } from '../config.js';
import type { PgKyAppInstallationRuntimeStore } from '../installations/runtimeStore.js';
import type { KyAppInstallationService } from '../installations/service.js';
import type { KyAppOutbound } from '../outbound.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { KyAppV2Authenticator } from '../workload/authenticator.js';
import type { PgDeploymentKeyStore } from '../workload/deploymentKeyStore.js';
import type { KyAppSatIssuer } from '../sat/issuer.js';
import type { PgEnrollmentStore } from './store.js';

export class KyAppActivationError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'KyAppActivationError';
  }
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field !== '' ? field : null;
}

export class KyAppV2ActivationService {
  constructor(
    private readonly options: {
      config: KyAppPlatformConfig;
      systems: PgKyAppSystemStore;
      operations: PgEnrollmentStore;
      deploymentKeys: PgDeploymentKeyStore;
      authenticator: KyAppV2Authenticator;
      issuer: KyAppSatIssuer;
      outbound: KyAppOutbound;
      runtimeStore: PgKyAppInstallationRuntimeStore;
      installations: KyAppInstallationService;
      now?: () => number;
    },
  ) {}

  async activate(input: {
    installationId: string;
    accessToken: string;
    dpopProof: string;
    manifestDigest: string;
    appVersion: string;
    keyId: string;
    generation: number;
  }) {
    const apiBase = new URL(this.options.config.jwksUrl).origin;
    const path = V2_ENDPOINTS.activate.replace(':iid', input.installationId);
    const authenticated = await this.options.authenticator.authenticateResource({
      accessToken: input.accessToken,
      dpopProof: input.dpopProof,
      method: 'POST',
      requestUrl: new URL(path, apiBase).toString(),
      requiredScope: 'installation.activate',
      allowedStatuses: ['pending'],
    });
    const installation = authenticated.installation;
    if (installation.installationId !== input.installationId) {
      throw new KyAppActivationError('授权身份与安装实例不一致', 'installation_binding_mismatch');
    }
    if (
      installation.currentKeyId !== input.keyId ||
      installation.identityGeneration !== input.generation
    ) {
      throw new KyAppActivationError('部署身份已变化，请重新授权', 'key_generation_mismatch');
    }
    const definition = await this.options.systems.getDefinition(installation.systemId);
    if (!definition?.publishedDigest || definition.publishedDigest !== input.manifestDigest) {
      throw new KyAppActivationError('业务系统版本不是当前发布版本', 'manifest_digest_mismatch');
    }
    const version = await this.options.systems.getVersion(
      installation.systemId,
      definition.publishedDigest,
    );
    if (!version || version.status !== 'published') {
      throw new KyAppActivationError('当前发布版本不可读取', 'system_not_published');
    }
    const manifest = version.manifest as unknown as Manifest;
    const key = await this.options.deploymentKeys.current(input.installationId);
    if (!key || key.keyId !== input.keyId || key.generation !== input.generation) {
      throw new KyAppActivationError('当前部署公钥不可用', 'key_id_mismatch');
    }

    const nonce = randomBytes(24).toString('base64url');
    const attest = await this.options.outbound.request({
      baseUrl: installation.baseUrl,
      path: `/ky/v2/attest?iid=${encodeURIComponent(input.installationId)}&nonce=${encodeURIComponent(nonce)}`,
      method: 'GET',
      requestId: randomUUID(),
    });
    const attestation = stringField(attest.json, 'attestation');
    if (attest.status !== 200 || !attestation) {
      throw new KyAppActivationError('业务系统身份确认失败', 'attestation_failed');
    }
    verifyV2Attestation(attestation, {
      deploymentPublicJwk: key.publicJwk,
      deploymentId: key.deploymentId,
      keyId: key.keyId,
      platformAudience: this.options.config.issuer,
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      systemId: installation.systemId,
      generation: key.generation,
      nonce,
      manifestDigest: definition.publishedDigest,
      now: Math.floor((this.options.now ?? Date.now)() / 1000),
    });

    const requestId = randomUUID();
    const sat = await this.options.issuer.issue({
      act: 'platform',
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      systemId: installation.systemId,
      rid: requestId,
      dig: definition.publishedDigest,
    });
    const ready = await this.options.outbound.request({
      baseUrl: installation.baseUrl,
      path: '/ky/v1/health/ready',
      method: 'GET',
      requestId,
      headers: { authorization: `Bearer ${sat.token}` },
    });
    if (
      ready.status !== 200 ||
      stringField(ready.json, 'manifestDigest') !== definition.publishedDigest
    ) {
      throw new KyAppActivationError('业务系统尚未准备完成', 'readiness_failed');
    }
    const manifestRequestId = randomUUID();
    const manifestSat = await this.options.issuer.issue({
      act: 'platform',
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      systemId: installation.systemId,
      rid: manifestRequestId,
      dig: definition.publishedDigest,
    });
    const observedManifest = await this.options.outbound.request({
      baseUrl: installation.baseUrl,
      path: '/ky/v1/manifest',
      method: 'GET',
      requestId: manifestRequestId,
      headers: { authorization: `Bearer ${manifestSat.token}` },
    });
    if (
      observedManifest.status !== 200 ||
      !observedManifest.json ||
      manifestDigest(observedManifest.json) !== definition.publishedDigest
    ) {
      throw new KyAppActivationError(
        '业务系统公开版本与平台登记不一致',
        'manifest_digest_mismatch',
      );
    }
    const meRequestId = randomUUID();
    const userSat = await this.options.issuer.issue({
      act: 'user',
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      systemId: installation.systemId,
      userId: installation.techContactUserId,
      tadm: false,
      pathPrefixes: manifest.pathPrefixes,
      authBinding: null,
      activationProbe: true,
    });
    const me = await this.options.outbound.request({
      baseUrl: installation.baseUrl,
      path: '/ky/v1/me',
      method: 'GET',
      requestId: meRequestId,
      headers: { authorization: `Bearer ${userSat.token}` },
    });
    const checkedMe = validateMe(me.json, manifest);
    const observedUserId =
      me.json && typeof me.json === 'object'
        ? (me.json as { user?: { id?: unknown } }).user?.id
        : undefined;
    if (me.status !== 200 || !checkedMe.ok || observedUserId !== installation.techContactUserId) {
      throw new KyAppActivationError('组织联系人无法以正确身份进入业务系统', 'me_probe_failed');
    }
    await this.options.runtimeStore.recordReady({
      installationId: installation.installationId,
      status: 'ok',
      manifestDigest: definition.publishedDigest,
      appVersion: input.appVersion,
    });
    let current = installation;
    if (current.registeredDigest !== definition.publishedDigest) {
      current = await this.options.installations.setRegisteredDigest({
        installationId: current.installationId,
        digest: definition.publishedDigest,
        observedDigest: definition.publishedDigest,
        expectedRegisteredDigest: current.registeredDigest,
        actor: { sub: '__ky_app_activation__', role: 'service' } as GovernanceActor,
      });
    }
    if (current.status !== 'enabled') {
      current = await this.options.installations.setStatus({
        installationId: current.installationId,
        status: 'enabled',
        actor: { sub: '__ky_app_activation__', role: 'service' } as GovernanceActor,
      });
    }
    await this.options.operations.markReady(input.installationId, {
      manifestDigest: definition.publishedDigest,
      appVersion: input.appVersion,
      generation: input.generation,
    });
    return current;
  }
}
