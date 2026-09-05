export const CREDENTIAL_RESOLUTION_FAILED = 'CREDENTIAL_RESOLUTION_FAILED' as const;

/**
 * SecretVault 解析失败的安全边界错误。
 *
 * 只保留代码和受控配置字段；不得附带 ref、Vault 原始错误或 cause，避免日志、audit
 * 与管理 API 在二次解析失败时持久化凭据标识。
 */
export class CredentialResolutionError extends Error {
  readonly code = CREDENTIAL_RESOLUTION_FAILED;

  constructor(readonly field: string) {
    super(`${field} 凭据解析失败`);
    this.name = 'CredentialResolutionError';
  }
}
