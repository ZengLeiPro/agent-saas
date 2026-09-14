import type { P256PublicJwk } from '@kaiyan/ky-app-contract';

export interface EnrollmentChallengeInput {
  operationId: string;
  nonce: string;
  platformIssuer: string;
  installationId: string;
  tenantId: string;
  systemId: string;
  origin: string;
  callbackUrl: string;
}

export interface EnrollmentAttempt {
  operationId: string;
  installationId: string;
  tenantId: string;
  systemId: string;
  stateHash: string;
  verifierRef: string;
  keyId: string;
  deploymentId: string;
  publicJwk: P256PublicJwk;
  status: 'pending' | 'exchanging' | 'consumed' | 'expired' | 'failed';
  expiresAt: number;
}

export interface EnrollmentAttemptStore {
  create(attempt: EnrollmentAttempt): Promise<EnrollmentAttempt>;
  get(operationId: string): Promise<EnrollmentAttempt | null>;
  getByStateHash(stateHash: string): Promise<EnrollmentAttempt | null>;
  beginExchange(operationId: string, now: number): Promise<boolean>;
  finish(operationId: string, status: 'consumed' | 'failed'): Promise<void>;
}

/** PKCE verifier 等短期秘密放入业务系统自己的 secret store，数据库只留 ref。 */
export interface EphemeralSecretStore {
  put(value: string, expiresAt: number): Promise<string>;
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string, expiresAt: number): Promise<void>;
  delete(ref: string): Promise<void>;
}

export interface PlatformChallengeVerifier {
  verify(token: string, input: EnrollmentChallengeInput): Promise<void>;
}
