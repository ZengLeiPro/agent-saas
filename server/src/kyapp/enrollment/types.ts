import type { EnrollmentOperationState, P256PublicJwk } from '@kaiyan/ky-app-contract';

export interface EnrollmentOperation {
  operationId: string;
  installationId: string;
  actorUserId: string;
  requestDigest: string;
  deploymentId: string | null;
  keyId: string | null;
  publicJwk: P256PublicJwk | null;
  origin: string | null;
  callbackUrl: string | null;
  callbackState: string | null;
  pkceChallenge: string | null;
  grantedScopes: string[];
  status: EnrollmentOperationState;
  version: number;
  codeExpiresAt: string | null;
  codeConsumedAt: string | null;
  grantJti: string | null;
  result: Record<string, unknown>;
  lastErrorCode: string | null;
  diagnosticId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VerifiedEnrollmentChallenge {
  deploymentId: string;
  keyId: string;
  publicJwk: P256PublicJwk;
  origin: string;
  callbackUrl: string;
  callbackState: string;
  pkceChallenge: string;
  scopes: string[];
}

export interface DeploymentKeyRecord {
  installationId: string;
  keyId: string;
  deploymentId: string;
  publicJwk: P256PublicJwk;
  status: 'current' | 'next' | 'previous' | 'revoked';
  notBefore: string;
  acceptUntil: string | null;
  revokedAt: string | null;
  generation: number;
}
