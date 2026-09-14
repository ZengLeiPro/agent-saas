export const V2_CONTRACT_ERROR_CODES = [
  'invalid_alg',
  'malformed_jose',
  'private_jwk_rejected',
  'key_id_mismatch',
  'invalid_pkce',
  'callback_mismatch',
  'invalid_origin',
  'invalid_issuer',
  'invalid_audience',
  'installation_binding_mismatch',
  'invalid_token_time',
  'invalid_key_source',
  'invalid_typ',
  'assertion_replayed',
  'dpop_required',
  'installation_inactive',
  'key_generation_mismatch',
  'invalid_dpop_proof',
  'dpop_replayed',
  'dpop_key_mismatch',
  'v2_downgrade_rejected',
  'nonce_mismatch',
  'manifest_digest_mismatch',
  'invalid_signature',
  'invalid_claims',
  'insufficient_scope',
  'operation_conflict',
  'authorization_code_expired',
  'authorization_code_replayed',
] as const;

export type V2ContractErrorCode = (typeof V2_CONTRACT_ERROR_CODES)[number];

export class V2ContractError extends Error {
  constructor(
    readonly code: V2ContractErrorCode,
    readonly stage: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'V2ContractError';
  }
}

export function v2Fail(
  code: V2ContractErrorCode,
  stage: string,
  message?: string,
): never {
  throw new V2ContractError(code, stage, message);
}
