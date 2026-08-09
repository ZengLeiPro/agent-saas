import type { GovernanceCredential } from '../data/credentials/types.js';
import type { SecretVault, VaultCaller } from '../security/secretVault.js';

export type CredentialBrokerErrorCode =
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_SUSPENDED'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_VALIDATION_FAILED'
  | 'CREDENTIAL_TENANT_MISMATCH'
  | 'CREDENTIAL_CONNECTOR_MISMATCH'
  | 'CREDENTIAL_INFRASTRUCTURE_FORBIDDEN'
  | 'CREDENTIAL_ACCESS_DENIED'
  | 'VAULT_UNAVAILABLE';

export class CredentialBrokerError extends Error {
  constructor(readonly code: CredentialBrokerErrorCode, readonly credentialId?: string) {
    super(code);
    this.name = 'CredentialBrokerError';
  }
}

export interface ResolvedCredential {
  credentialId: string;
  generation: number;
  /** 一次性明文；调用方用后即弃，不得落入日志、Run Snapshot 或响应体。 */
  secret: string;
  resolvedAt: string;
}

interface CredentialReader {
  get(credentialId: string): Promise<GovernanceCredential | null>;
}

export interface CredentialBrokerRequest {
  credentialId: string;
  tenantId: string;
  connectorId: string;
  channel: 'connector' | 'mcp';
  /** 运行态委托用户（Run Snapshot 中的 human subject 或其 delegated user）。 */
  delegatedUserId: string;
  purpose: string;
}

export interface CredentialBrokerOptions {
  credentialStore: CredentialReader;
  vault: SecretVault;
  /** AccessEvaluator/Assignment 的窄适配器。不存在默认放行路径。 */
  authorizeUse: (request: CredentialBrokerRequest, credential: GovernanceCredential) => Promise<boolean>;
  now?: () => Date;
}

/**
 * Server-side Credential Broker（后端改造分析 §11.2）。
 * 每次调用重读 Credential + Access/Assignment，再向 Vault 取一次 Secret；不缓存明文。
 */
export class CredentialBroker {
  constructor(private readonly options: CredentialBrokerOptions) {}

  async resolve(request: CredentialBrokerRequest): Promise<ResolvedCredential> {
    const credential = await this.options.credentialStore.get(request.credentialId);
    if (!credential) throw new CredentialBrokerError('CREDENTIAL_NOT_FOUND');
    if (credential.tenantId !== request.tenantId) {
      throw new CredentialBrokerError('CREDENTIAL_TENANT_MISMATCH', credential.credentialId);
    }
    if (credential.connectorId !== request.connectorId) {
      throw new CredentialBrokerError('CREDENTIAL_CONNECTOR_MISMATCH', credential.credentialId);
    }
    if (credential.kind === 'infrastructure') {
      // infrastructure secret 只能走指定 Provider Service Principal，不进通用 Connector Broker。
      throw new CredentialBrokerError('CREDENTIAL_INFRASTRUCTURE_FORBIDDEN', credential.credentialId);
    }
    if (credential.status === 'suspended') throw new CredentialBrokerError('CREDENTIAL_SUSPENDED', credential.credentialId);
    if (credential.status === 'revoked') throw new CredentialBrokerError('CREDENTIAL_REVOKED', credential.credentialId);
    if (credential.status === 'expired') throw new CredentialBrokerError('CREDENTIAL_EXPIRED', credential.credentialId);
    if (credential.status === 'validation_failed') {
      throw new CredentialBrokerError('CREDENTIAL_VALIDATION_FAILED', credential.credentialId);
    }
    const now = (this.options.now ?? (() => new Date()))();
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= now.getTime()) {
      throw new CredentialBrokerError('CREDENTIAL_EXPIRED', credential.credentialId);
    }
    if (!(await this.options.authorizeUse(request, credential))) {
      throw new CredentialBrokerError('CREDENTIAL_ACCESS_DENIED', credential.credentialId);
    }
    let secret: string;
    try {
      secret = await this.options.vault.getSecret(credential.secretRef, this.vaultCaller(credential, request));
    } catch {
      throw new CredentialBrokerError('VAULT_UNAVAILABLE', credential.credentialId);
    }
    return {
      credentialId: credential.credentialId,
      generation: credential.generation,
      secret,
      resolvedAt: now.toISOString(),
    };
  }

  private vaultCaller(credential: GovernanceCredential, request: CredentialBrokerRequest): VaultCaller {
    return {
      actor: request.channel === 'mcp' ? 'mcp_proxy' : 'connector_proxy',
      userId: credential.ownerUserId ?? request.delegatedUserId,
      tenantId: request.tenantId,
      scopes: [`secret:${request.channel}:read`],
    };
  }
}
