import { randomBytes, randomUUID } from 'node:crypto';

import {
  V2_ENDPOINTS,
  decodeV2Jws,
  p256JwkThumbprint,
  verifyV2Attestation,
  type P256PublicJwk,
} from '@kaiyan/ky-app-contract';

import {
  governanceDigest,
  recordGovernanceIntent,
  recordGovernanceOutcome,
  type GovernanceActor,
} from '../../data/governance-audit/recorder.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import type { KyAppPlatformConfig } from '../config.js';
import type { KyAppInstallationService } from '../installations/service.js';
import type { KyAppOutbound } from '../outbound.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { KyAppV2Authenticator } from '../workload/authenticator.js';
import type { PgDeploymentKeyStore } from '../workload/deploymentKeyStore.js';

const PREVIOUS_WINDOW_MS = 24 * 60 * 60 * 1000;

export class KyAppKeyLifecycleError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'KyAppKeyLifecycleError';
  }
}

export interface InstanceKeyObservation {
  instanceId: string;
  keyId: string;
  generation: number;
}

export class KyAppV2KeyLifecycleService {
  private readonly apiBase: string;
  private readonly tokenEndpoint: string;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      config: KyAppPlatformConfig;
      systems: PgKyAppSystemStore;
      keys: PgDeploymentKeyStore;
      authenticator: KyAppV2Authenticator;
      installations: KyAppInstallationService;
      outbound: KyAppOutbound;
      audit?: GovernanceAuditStore;
      now?: () => number;
    },
  ) {
    this.apiBase = new URL(options.config.jwksUrl).origin;
    this.tokenEndpoint = new URL(V2_ENDPOINTS.token, this.apiBase).toString();
    this.now = options.now ?? Date.now;
  }

  async prepare(input: {
    installationId: string;
    accessToken: string;
    currentDpopProof: string;
    nextPublicJwk: P256PublicJwk;
    nextClientAssertion: string;
    nextDpopProof: string;
    generation: number;
  }) {
    const path = V2_ENDPOINTS.prepareKey.replace(':iid', input.installationId);
    const { installation } = await this.options.authenticator.authenticateResource({
      accessToken: input.accessToken,
      dpopProof: input.currentDpopProof,
      method: 'POST',
      requestUrl: new URL(path, this.apiBase).toString(),
      requiredScope: 'installation.keys.rotate',
    });
    const current = await this.options.keys.current(input.installationId);
    const nextKeyId = p256JwkThumbprint(input.nextPublicJwk);
    if (current && current.keyId === nextKeyId && input.generation === current.generation) {
      await this.options.authenticator.authenticateTokenRequest({
        installationId: installation.installationId,
        deploymentId: current.deploymentId,
        keyId: current.keyId,
        publicJwk: current.publicJwk,
        clientAssertion: input.nextClientAssertion,
        dpopProof: input.nextDpopProof,
      });
      return current;
    }
    if (!current || input.generation !== current.generation + 1) {
      throw new KyAppKeyLifecycleError('轮换代次已变化', 'key_generation_mismatch');
    }
    await this.options.authenticator.authenticateTokenRequest({
      installationId: installation.installationId,
      deploymentId: current.deploymentId,
      keyId: nextKeyId,
      publicJwk: input.nextPublicJwk,
      clientAssertion: input.nextClientAssertion,
      dpopProof: input.nextDpopProof,
    });
    return this.options.keys.prepareNext({
      installationId: installation.installationId,
      keyId: nextKeyId,
      deploymentId: current.deploymentId,
      publicJwk: input.nextPublicJwk,
      generation: input.generation,
    });
  }

  async commit(input: {
    installationId: string;
    accessToken: string;
    currentDpopProof: string;
    nextClientAssertion: string;
    nextDpopProof: string;
    expectedInstanceIds: string[];
    observations: InstanceKeyObservation[];
    generation: number;
  }) {
    const path = V2_ENDPOINTS.commitKey.replace(':iid', input.installationId);
    await this.options.authenticator.authenticateResource({
      accessToken: input.accessToken,
      dpopProof: input.currentDpopProof,
      method: 'POST',
      requestUrl: new URL(path, this.apiBase).toString(),
      requiredScope: 'installation.keys.rotate',
    });
    const [current, next] = await Promise.all([
      this.options.keys.current(input.installationId),
      this.options.keys.next(input.installationId),
    ]);
    const assertedNextKeyId = next
      ? null
      : decodeV2Jws(input.nextClientAssertion).protectedHeader.kid;
    if (
      current &&
      !next &&
      assertedNextKeyId === current.keyId &&
      current.generation === input.generation
    ) {
      await this.options.authenticator.authenticateTokenRequest({
        installationId: input.installationId,
        deploymentId: current.deploymentId,
        keyId: current.keyId,
        publicJwk: current.publicJwk,
        clientAssertion: input.nextClientAssertion,
        dpopProof: input.nextDpopProof,
      });
      this.assertAllInstancesReady(
        input.expectedInstanceIds,
        input.observations,
        current.keyId,
        current.generation,
      );
      return current;
    }
    if (!current || !next || next.generation !== input.generation) {
      throw new KyAppKeyLifecycleError('找不到待切换密钥', 'key_prepare_required');
    }
    await this.options.authenticator.authenticateTokenRequest({
      installationId: input.installationId,
      deploymentId: next.deploymentId,
      keyId: next.keyId,
      publicJwk: next.publicJwk,
      clientAssertion: input.nextClientAssertion,
      dpopProof: input.nextDpopProof,
    });
    this.assertAllInstancesReady(
      input.expectedInstanceIds,
      input.observations,
      next.keyId,
      next.generation,
    );
    const promoted = await this.options.keys.commitNext({
      installationId: input.installationId,
      currentKeyId: current.keyId,
      nextKeyId: next.keyId,
      generation: next.generation,
      previousAcceptUntil: new Date(this.now() + PREVIOUS_WINDOW_MS),
    });
    this.options.installations.signalIdentityChanged(input.installationId);
    return promoted;
  }

  async finalize(input: {
    installationId: string;
    accessToken: string;
    dpopProof: string;
  }): Promise<number> {
    const path = V2_ENDPOINTS.commitKey.replace(':iid', input.installationId);
    const { installation } = await this.options.authenticator.authenticateResource({
      accessToken: input.accessToken,
      dpopProof: input.dpopProof,
      method: 'POST',
      requestUrl: new URL(path, this.apiBase).toString(),
      requiredScope: 'installation.keys.rotate',
    });
    const current = await this.options.keys.current(input.installationId);
    const definition = await this.options.systems.getDefinition(installation.systemId);
    if (!current || !definition?.publishedDigest) {
      throw new KyAppKeyLifecycleError('当前密钥或版本不可用', 'key_id_mismatch');
    }
    const nonce = randomBytes(24).toString('base64url');
    const response = await this.options.outbound.request({
      baseUrl: installation.baseUrl,
      path: `/ky/v2/attest?iid=${encodeURIComponent(input.installationId)}&nonce=${encodeURIComponent(nonce)}`,
      method: 'GET',
      requestId: randomUUID(),
    });
    const attestation =
      response.json && typeof response.json === 'object'
        ? (response.json as { attestation?: unknown }).attestation
        : null;
    if (response.status !== 200 || typeof attestation !== 'string') {
      throw new KyAppKeyLifecycleError(
        '尚未观察到新密钥的真实证明',
        'rotation_observation_required',
      );
    }
    verifyV2Attestation(attestation, {
      deploymentPublicJwk: current.publicJwk,
      deploymentId: current.deploymentId,
      keyId: current.keyId,
      platformAudience: this.options.config.issuer,
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      systemId: installation.systemId,
      generation: current.generation,
      nonce,
      manifestDigest: definition.publishedDigest,
      now: Math.floor(this.now() / 1000),
    });
    return this.options.keys.revokePrevious(input.installationId);
  }

  async revoke(installationId: string, actor: GovernanceActor) {
    const installation = await this.options.systems.getInstallation(installationId);
    if (!installation || installation.status === 'deleted') {
      throw new KyAppKeyLifecycleError('安装实例不存在', 'installation_not_found');
    }
    const intent = await recordGovernanceIntent(this.options.audit, actor, {
      action: 'ky_app.deployment_identity.revoke',
      targetType: 'system_installation',
      targetId: installationId,
      targetTenantId: installation.tenantId,
      purpose: 'deployment_identity_revocation',
      beforeDigest: governanceDigest({
        status: installation.status,
        generation: installation.identityGeneration ?? 0,
      }),
      metadata: { systemId: installation.systemId },
    });
    try {
      await this.options.keys.revokeAll(installationId);
      const disabled =
        installation.status === 'disabled'
          ? installation
          : await this.options.installations.setStatus({
              installationId,
              status: 'disabled',
              actor,
            });
      this.options.installations.signalIdentityChanged(installationId);
      await recordGovernanceOutcome(this.options.audit!, intent, 'succeeded', {
        afterDigest: governanceDigest({ status: disabled.status, revoked: true }),
        metadata: {},
      });
      return disabled;
    } catch (error) {
      await recordGovernanceOutcome(this.options.audit!, intent, 'failed', {
        metadata: { failureKind: error instanceof Error ? error.name : 'unknown' },
      }).catch(() => undefined);
      throw error;
    }
  }

  private assertAllInstancesReady(
    expected: string[],
    observed: InstanceKeyObservation[],
    keyId: string,
    generation: number,
  ): void {
    const expectedSet = new Set(expected);
    const observedSet = new Set(
      observed
        .filter((item) => item.keyId === keyId && item.generation === generation)
        .map((item) => item.instanceId),
    );
    if (
      expectedSet.size === 0 ||
      expectedSet.size !== expected.length ||
      observedSet.size !== expectedSet.size ||
      [...expectedSet].some((instanceId) => !observedSet.has(instanceId))
    ) {
      throw new KyAppKeyLifecycleError('仍有运行实例未加载下一把密钥', 'instances_not_ready');
    }
  }
}
