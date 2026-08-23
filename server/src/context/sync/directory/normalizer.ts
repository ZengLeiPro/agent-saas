import { createHash } from 'node:crypto';

import type { ContextObject } from '../../store/types.js';
import type { DirectoryContextRecord, DirectoryPerson } from './types.js';

export const DIRECTORY_COLLECTION_ID = 'directory-people';
export const DIRECTORY_EXTERNAL_KEY = 'directory-people';
export const DIRECTORY_PARTITION_KEY = 'inventory';

export function directorySourceId(tenantId: string): string {
  return `directory:${createHash('sha256').update(tenantId).digest('hex').slice(0, 24)}`;
}

export function directoryPersonRecordId(userId: string): string {
  return `person:${createHash('sha256').update(userId).digest('hex')}`;
}

function personContent(person: DirectoryPerson): ContextObject {
  return {
    userId: person.userId,
    username: person.username,
    ...(person.displayName ? { displayName: person.displayName } : {}),
    ...(person.position ? { position: person.position } : {}),
    ...(person.role ? { role: person.role } : {}),
    status: person.status,
  };
}

/**
 * Directory projection intentionally excludes phone, password hash, permissions and connector credentials.
 * Stable userId is the only identity key; names are display fields and never become same_as evidence.
 */
export function normalizeDirectoryPerson(person: DirectoryPerson, observedAt: string): DirectoryContextRecord {
  const active = person.status === 'active';
  return {
    recordId: directoryPersonRecordId(person.userId),
    externalRecordId: person.userId,
    content: personContent(person),
    metadata: {
      source: 'directory',
      identityAuthority: 'native_user_id',
      status: person.status,
    },
    entityType: 'person',
    recordKind: 'snapshot',
    nativeId: person.userId,
    ownerPrincipal: `user:${person.userId}`,
    aclPrincipals: [`org:${person.tenantId}`],
    revoked: !active,
    sourceUpdatedAt: person.updatedAt,
    observedAt,
    evidence: [{
      evidenceId: 'directory-record',
      kind: 'source_locator',
      data: {
        source: 'directory',
        entityType: 'person',
        nativeId: person.userId,
      },
    }],
  } as DirectoryContextRecord;
}

export function normalizeMissingDirectoryPerson(
  tenantId: string,
  userId: string,
  observedAt: string,
): DirectoryContextRecord {
  return {
    recordId: directoryPersonRecordId(userId),
    externalRecordId: userId,
    content: { userId, status: 'offboarded' },
    metadata: { source: 'directory', identityAuthority: 'native_user_id', status: 'offboarded' },
    entityType: 'person',
    recordKind: 'snapshot',
    nativeId: userId,
    ownerPrincipal: `user:${userId}`,
    aclPrincipals: [`org:${tenantId}`],
    revoked: true,
    observedAt,
    evidence: [{
      evidenceId: 'directory-inventory',
      kind: 'inventory_tombstone',
      data: { source: 'directory', entityType: 'person', nativeId: userId },
    }],
  } as DirectoryContextRecord;
}
