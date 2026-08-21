import type { GovernanceCredential } from '../data/credentials/types.js';

export interface GovernanceCredentialReader {
  listForOwner(tenantId: string, ownerUserId: string): Promise<GovernanceCredential[]>;
}

export function isUsableGovernanceCredential(credential: GovernanceCredential): boolean {
  if (!['active', 'rotation_due'].includes(credential.status)) return false;
  if (!credential.expiresAt) return true;
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export async function listPersonalGovernanceCredentials(
  reader: GovernanceCredentialReader,
  context: { userId: string; tenantId: string },
  connectorId: string,
): Promise<GovernanceCredential[]> {
  return (await reader.listForOwner(context.tenantId, context.userId))
    .filter(credential => credential.tenantId === context.tenantId
      && credential.ownerUserId === context.userId
      && credential.connectorId === connectorId
      && credential.kind === 'personal_grant')
    .sort((left, right) => {
      const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return updatedDelta || right.credentialId.localeCompare(left.credentialId);
    });
}
