/** KY App V2 enrollment 与动态绑定的公开类型。 */

export const ENROLLMENT_OPERATION_STATES = [
  'created',
  'challenge_verified',
  'awaiting_consent',
  'code_issued',
  'exchanged',
  'activating',
  'ready',
  'expired',
  'cancelled',
  'failed_retryable',
  'needs_human',
] as const;
export type EnrollmentOperationState = (typeof ENROLLMENT_OPERATION_STATES)[number];

export const INSTALLATION_BINDING_STATES = [
  'activating',
  'connected',
  'degraded',
  'revoked',
] as const;
export type InstallationBindingState = (typeof INSTALLATION_BINDING_STATES)[number];

export const INSTALLATION_AUTH_MODES = ['v1_symmetric', 'v2_asymmetric'] as const;
export type InstallationAuthMode = (typeof INSTALLATION_AUTH_MODES)[number];

export interface P256PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  alg?: 'ES256';
  use?: 'sig';
  kid?: string;
  key_ops?: string[];
}

export interface EnrollmentRequestClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  tid: string;
  iid: string;
  sid: string;
  deployment_id: string;
  origin: string;
  callback_uri: string;
  nonce: string;
  code_challenge_method: 'S256';
  code_challenge: string;
  key_id: string;
  public_jwk: P256PublicJwk;
  scope: string[];
}

export interface InstallationGrantClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  tid: string;
  iid: string;
  sid: string;
  client_id: string;
  origin: string;
  key_id: string;
  scope: string[];
  registered_digest: string;
  generation: number;
}

export interface InstallationBinding {
  installationId: string;
  tenantId: string;
  systemId: string;
  deploymentId: string;
  origin: string;
  platformIssuer: string;
  platformApiBaseUrl: string;
  keyId: string;
  grantedScopes: string[];
  registeredDigest: string | null;
  generation: number;
  state: InstallationBindingState;
  updatedAt: string;
}
