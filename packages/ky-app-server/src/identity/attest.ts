import { V2_JWT_TYP, V2_TTL_SECONDS, type InstallationBinding } from '@kaiyan/ky-app-contract';

import { randomId, signDeploymentJws } from './jws.js';
import type { DeploymentKeyStore } from './types.js';

const noncePattern = /^[A-Za-z0-9_-]{22,128}$/u;

export async function issueV2Attestation(input: {
  binding: InstallationBinding;
  nonce: string;
  manifestDigest: string;
  ready: boolean;
  keys: DeploymentKeyStore;
  now?: number;
}): Promise<string> {
  if (!noncePattern.test(input.nonce)) throw new Error('invalid_nonce');
  if (input.binding.state === 'revoked') throw new Error('installation_revoked');
  const current = await input.keys.current();
  if (
    current.keyId !== input.binding.keyId ||
    current.deploymentId !== input.binding.deploymentId
  ) {
    throw new Error('deployment_key_generation_mismatch');
  }
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  return signDeploymentJws({
    keys: input.keys,
    keyRef: current.keyRef,
    protectedHeader: { alg: 'ES256', typ: V2_JWT_TYP.attest, kid: current.keyId },
    payload: {
      iss: current.deploymentId,
      sub: input.binding.installationId,
      aud: input.binding.platformIssuer,
      iat: now,
      exp: now + V2_TTL_SECONDS.attest,
      jti: randomId(),
      tid: input.binding.tenantId,
      iid: input.binding.installationId,
      sid: input.binding.systemId,
      deployment_id: input.binding.deploymentId,
      key_id: input.binding.keyId,
      generation: input.binding.generation,
      nonce: input.nonce,
      manifest_digest: input.manifestDigest,
      ready: input.ready,
    },
  });
}
