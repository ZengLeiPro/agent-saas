import type { SecretVault, VaultCaller, VaultOperation } from '../../security/secretVault.js';
import { hashAccountBinding } from './subscriptionAccountBinding.js';
import { GROK_OAUTH_ISSUER, GrokProtocolError, isRecord, requiredString } from './grokProtocol.js';
import {
  GROK_SECRET_KIND,
  GrokCredentialError,
  type GrokTokenBundle,
} from './grokCredentialTypes.js';
import type { GrokOAuthTokens } from './grokOAuthClient.js';
function caller(operation: VaultOperation): VaultCaller {
  return {
    actor: 'system',
    userId: '__system__',
    scopes: [`secret:${GROK_SECRET_KIND}:${operation}`],
  };
}
/** Tokens never cross this server-side boundary; kind/owner are checked independently of ref possession. */
export class GrokCredentialRepository {
  constructor(private readonly vault: SecretVault) {}
  async read(ref: string, generation = 0): Promise<GrokTokenBundle> {
    try {
      this.vault.invalidate?.(ref);
      if (!this.vault.inspectRef) throw new GrokProtocolError('vault_metadata_unavailable');
      const metadata = await this.vault.inspectRef(ref, caller('read'));
      if (!metadata || metadata.revokedAt)
        throw new GrokCredentialError('credential_unavailable', generation);
      if (metadata.kind !== GROK_SECRET_KIND || metadata.ownerId !== 'global')
        throw new GrokCredentialError('credential_scope_mismatch', generation);
      return parseBundle(await this.vault.getSecret(ref, caller('read')));
    } catch (error) {
      if (error instanceof GrokCredentialError || error instanceof GrokProtocolError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (/secret not found|secret revoked|access denied/i.test(message))
        throw new GrokCredentialError('credential_unavailable', generation);
      throw new GrokProtocolError('vault_read_failed');
    }
  }
  async create(tokens: GrokOAuthTokens, metadata: Record<string, unknown> = {}) {
    const bundle: GrokTokenBundle = { ...tokens, generation: 1 };
    parseBundle(JSON.stringify(bundle));
    const ref = await this.vault.putSecret(
      'global',
      GROK_SECRET_KIND,
      JSON.stringify(bundle),
      caller('write'),
      {
        ...metadata,
        accountBindingHash: hashAccountBinding(tokens.accountId),
      },
    );
    return { credentialRef: ref.id, bundle };
  }
  async rotate(ref: string, bundle: GrokTokenBundle): Promise<void> {
    const { credentialRef: _runtimeRef, ...stored } = bundle;
    await this.vault.rotateSecret(ref, JSON.stringify(stored), caller('rotate'));
    this.vault.invalidate?.(ref);
  }
  async revoke(ref: string): Promise<void> {
    await this.vault.revokeSecret(ref, caller('revoke'));
    this.vault.invalidate?.(ref);
  }
}
function parseBundle(raw: string): GrokTokenBundle {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.issuer !== GROK_OAUTH_ISSUER ||
      !Number.isSafeInteger(value.generation) ||
      Number(value.generation) < 1
    )
      throw new Error();
    const expiresAt = requiredString(value.expiresAt, 64);
    if (!Number.isFinite(Date.parse(expiresAt))) throw new Error();
    return {
      accessToken: requiredString(value.accessToken),
      refreshToken: requiredString(value.refreshToken),
      accountId: requiredString(value.accountId, 512),
      clientId: requiredString(value.clientId, 256),
      issuer: GROK_OAUTH_ISSUER,
      expiresAt,
      generation: Number(value.generation),
      ...(value.idToken ? { idToken: requiredString(value.idToken) } : {}),
      ...(value.email ? { email: requiredString(value.email, 254) } : {}),
    };
  } catch {
    throw new GrokCredentialError('credential_invalid');
  }
}
