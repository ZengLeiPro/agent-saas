import type { P256PublicJwk } from './enrollment.js';

export interface ClientAssertionClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  iid: string;
  key_id: string;
}

export interface WorkloadAccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  tid: string;
  iid: string;
  sid: string;
  client_id: string;
  scope: string;
  cnf: { jkt: string };
  generation: number;
}

export interface DpopProofClaims {
  htm: string;
  htu: string;
  iat: number;
  jti: string;
  ath?: string;
  nonce?: string;
}

export interface DpopProtectedHeader {
  alg: 'ES256';
  typ: 'dpop+jwt';
  jwk: P256PublicJwk;
}

export interface V2AttestClaims {
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
  key_id: string;
  generation: number;
  nonce: string;
  manifest_digest: string;
  ready: boolean;
}
