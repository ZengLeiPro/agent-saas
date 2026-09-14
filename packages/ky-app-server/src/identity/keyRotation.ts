import {
  V2_JWT_TYP,
  V2_TTL_SECONDS,
  type InstallationBinding,
  type P256PublicJwk,
} from '@kaiyan/ky-app-contract';

import { randomId, signDeploymentJws } from './jws.js';
import type { DeploymentKeyStore, InstallationBindingProvider } from './types.js';
import type { InstallationRuntimeManager } from './runtimeManager.js';
import { createDpopProof } from '../workload/proof.js';
import type { KyAppWorkloadClient } from '../workload/client.js';

export interface RotationInstanceObservation {
  instanceId: string;
  keyId: string;
  generation: number;
}

/**
 * next 私钥始终留在业务系统密钥提供方；平台只收到公钥与两把钥匙分别生成的短期证明。
 * 调用方负责从真实实例心跳构造 observations，不能用期望列表自行伪造。
 */
export class V2DeploymentKeyRotation {
  private readonly now: () => number;

  constructor(
    private readonly options: {
      keys: DeploymentKeyStore;
      bindings: InstallationBindingProvider;
      runtimes: InstallationRuntimeManager;
      workload: KyAppWorkloadClient;
      instanceObservations: (
        keyId: string,
        generation: number,
      ) => Promise<{
        expectedInstanceIds: string[];
        observations: RotationInstanceObservation[];
      }>;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  async rotate(installationId: string): Promise<InstallationBinding> {
    const binding = await this.options.bindings.get(installationId);
    if (!binding || binding.state !== 'connected') throw new Error('installation_inactive');
    const current = await this.options.keys.current();
    if (current.keyId !== binding.keyId || current.deploymentId !== binding.deploymentId)
      throw new Error('deployment_key_generation_mismatch');
    const next = await this.options.keys.prepareRotation();
    if (next.deploymentId !== current.deploymentId || next.keyId === current.keyId)
      throw new Error('rotation_candidate_invalid');
    const generation = binding.generation + 1;
    const tokenEndpoint = `${binding.platformApiBaseUrl}/api/app-contract/v2/oauth/token`;
    const prepareUrl = `${binding.platformApiBaseUrl}/api/app-contract/v2/installations/${encodeURIComponent(installationId)}/keys/prepare`;
    const prepareProofs = await this.nextProofs(next, installationId, tokenEndpoint);
    const prepared = await this.options.workload.request(
      binding,
      'installation.keys.rotate',
      prepareUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nextPublicJwk: next.publicJwk,
          nextClientAssertion: prepareProofs.assertion,
          nextDpopProof: prepareProofs.dpop,
          generation,
        }),
      },
      true,
    );
    if (!prepared.ok) throw new Error(`key_prepare_${prepared.status}`);

    const heartbeat = await this.options.instanceObservations(next.keyId, generation);
    const commitUrl = `${binding.platformApiBaseUrl}/api/app-contract/v2/installations/${encodeURIComponent(installationId)}/keys/commit`;
    const commitProofs = await this.nextProofs(next, installationId, tokenEndpoint);
    const committed = await this.options.workload.request(
      binding,
      'installation.keys.rotate',
      commitUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'switch',
          nextClientAssertion: commitProofs.assertion,
          nextDpopProof: commitProofs.dpop,
          generation,
          ...heartbeat,
        }),
      },
      true,
    );
    if (!committed.ok) throw new Error(`key_commit_${committed.status}`);

    await this.options.keys.commitRotation(next.keyId);
    const rotated = {
      ...binding,
      keyId: next.keyId,
      generation,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.options.runtimes.install(rotated);
    const active = (await this.options.bindings.get(installationId)) ?? rotated;
    const finalized = await this.options.workload.request(
      active,
      'installation.keys.rotate',
      commitUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'finalize' }),
      },
      true,
    );
    if (!finalized.ok) throw new Error(`key_finalize_${finalized.status}`);
    this.options.workload.clear(installationId);
    return active;
  }

  private async nextProofs(
    key: { deploymentId: string; keyId: string; keyRef: string; publicJwk: P256PublicJwk },
    installationId: string,
    tokenEndpoint: string,
  ) {
    const now = Math.floor(this.now() / 1000);
    const assertion = await signDeploymentJws({
      keys: this.options.keys,
      keyRef: key.keyRef,
      protectedHeader: { alg: 'ES256', typ: V2_JWT_TYP.clientAssertion, kid: key.keyId },
      payload: {
        iss: key.deploymentId,
        sub: key.deploymentId,
        aud: tokenEndpoint,
        iat: now,
        exp: now + V2_TTL_SECONDS.clientAssertion,
        jti: randomId(),
        iid: installationId,
        key_id: key.keyId,
      },
    });
    const dpop = await createDpopProof({
      keys: this.options.keys,
      keyRef: key.keyRef,
      publicJwk: key.publicJwk,
      method: 'POST',
      url: tokenEndpoint,
      now: this.now(),
    });
    return { assertion, dpop };
  }
}
