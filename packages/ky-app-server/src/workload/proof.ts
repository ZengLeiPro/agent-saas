import {
  V2_JWT_TYP,
  accessTokenHash,
  normalizeDpopHtu,
  type P256PublicJwk,
} from '@kaiyan/ky-app-contract';

import { publicOnlyJwk, randomId, signDeploymentJws } from '../identity/jws.js';
import type { DeploymentKeyStore } from '../identity/types.js';

export async function createDpopProof(input: {
  keys: DeploymentKeyStore;
  keyRef: string;
  publicJwk: P256PublicJwk;
  method: string;
  url: string;
  accessToken?: string;
  nonce?: string;
  now?: number;
}): Promise<string> {
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  return signDeploymentJws({
    keys: input.keys,
    keyRef: input.keyRef,
    protectedHeader: {
      alg: 'ES256',
      typ: V2_JWT_TYP.dpop,
      jwk: publicOnlyJwk(input.publicJwk),
    },
    payload: {
      htm: input.method.toUpperCase(),
      htu: normalizeDpopHtu(input.url),
      iat: now,
      jti: randomId(),
      ...(input.accessToken ? { ath: accessTokenHash(input.accessToken) } : {}),
      ...(input.nonce ? { nonce: input.nonce } : {}),
    },
  });
}
