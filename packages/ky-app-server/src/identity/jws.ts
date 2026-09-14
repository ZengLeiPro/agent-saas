import { randomBytes } from 'node:crypto';

import type { P256PublicJwk } from '@kaiyan/ky-app-contract';

import type { DeploymentKeyStore } from './types.js';

const encoder = new TextEncoder();

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function randomId(): string {
  return randomBytes(16).toString('base64url');
}

/** 生成 compact JWS；签名适配 KMS/HSM，SDK 从不读取私钥。 */
export async function signDeploymentJws(input: {
  keys: DeploymentKeyStore;
  keyRef: string;
  protectedHeader: Record<string, unknown>;
  payload: Record<string, unknown>;
}): Promise<string> {
  const signingInput = `${encode(input.protectedHeader)}.${encode(input.payload)}`;
  const signature = await input.keys.sign(input.keyRef, encoder.encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

export function publicOnlyJwk(jwk: P256PublicJwk): P256PublicJwk {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x,
    y: jwk.y,
    alg: 'ES256',
    use: 'sig',
  };
}
