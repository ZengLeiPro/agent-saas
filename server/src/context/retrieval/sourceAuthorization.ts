import type { ContextObject } from '../store/types.js';

/** Server-authenticated identity. Callers must not populate this from model/client input. */
export interface ContextSourceAuthorizationSubject {
  tenantId: string;
  userId: string;
}

/**
 * Typed, source-neutral locator passed to native source authorization.
 * Source-specific fields are derived from persisted context metadata, never request input.
 */
export interface ContextSourceLocator {
  sourceKind: string;
  sourceId: string;
  collectionId: string;
  recordId: string;
  revision: number;
  recordType: 'snapshot' | 'event';
  resourceType: 'board' | 'task' | 'unknown';
  boardId?: string;
  taskId?: string;
  sourceEventId?: string;
  eventType?: string;
  ownerPrincipal?: string;
  aclPrincipals?: readonly string[];
  deleted: boolean;
  metadata: ContextObject;
}

export type ContextSourceAuthorizationDenyReason =
  | 'context_source_authorizer_missing'
  | 'context_source_authorization_error';

export interface ContextSourceAuthorizationDecision {
  authorized: boolean;
  reason?: ContextSourceAuthorizationDenyReason;
}

export interface ContextSourceAuthorizer<TLocator extends ContextSourceLocator = ContextSourceLocator> {
  authorize?(subject: ContextSourceAuthorizationSubject, locator: TLocator): Promise<boolean>;
  authorizeBatch?(
    subject: ContextSourceAuthorizationSubject,
    locators: readonly TLocator[],
  ): Promise<readonly boolean[]>;
}

/**
 * Injectable registry for read-time native ACL checks. Unknown sources and exceptions
 * are represented as denials; callers can surface a non-sensitive degraded reason.
 */
export class ContextSourceAuthorizationRegistry {
  private readonly authorizers = new Map<string, ContextSourceAuthorizer>();

  constructor(
    entries: Readonly<Record<string, ContextSourceAuthorizer>>
      | Iterable<readonly [string, ContextSourceAuthorizer]> = {},
  ) {
    const values = Symbol.iterator in Object(entries)
      ? entries as Iterable<readonly [string, ContextSourceAuthorizer]>
      : Object.entries(entries);
    for (const [sourceKind, authorizer] of values) this.register(sourceKind, authorizer);
  }

  register(sourceKind: string, authorizer: ContextSourceAuthorizer): this {
    const normalized = normalizeSourceKind(sourceKind);
    if (!normalized) throw new Error('CONTEXT_SOURCE_KIND_REQUIRED');
    this.authorizers.set(normalized, authorizer);
    return this;
  }

  has(sourceKind: string): boolean {
    return this.authorizers.has(normalizeSourceKind(sourceKind));
  }

  async authorize(
    subject: ContextSourceAuthorizationSubject,
    locator: ContextSourceLocator,
  ): Promise<ContextSourceAuthorizationDecision> {
    const [decision] = await this.authorizeBatch(subject, [locator]);
    return decision!;
  }

  async authorizeBatch(
    subject: ContextSourceAuthorizationSubject,
    locators: readonly ContextSourceLocator[],
  ): Promise<readonly ContextSourceAuthorizationDecision[]> {
    const decisions: ContextSourceAuthorizationDecision[] = locators.map(() => ({ authorized: false }));
    const groups = new Map<string, Array<{ index: number; locator: ContextSourceLocator }>>();
    locators.forEach((locator, index) => {
      const kind = normalizeSourceKind(locator.sourceKind);
      const group = groups.get(kind) ?? [];
      group.push({ index, locator });
      groups.set(kind, group);
    });

    await Promise.all([...groups.entries()].map(async ([kind, group]) => {
      const authorizer = this.authorizers.get(kind);
      if (!authorizer) {
        for (const entry of group) decisions[entry.index] = {
          authorized: false,
          reason: 'context_source_authorizer_missing',
        };
        return;
      }
      try {
        const locators = group.map(entry => entry.locator);
        const result = authorizer.authorizeBatch
          ? await authorizer.authorizeBatch(subject, locators)
          : await Promise.all(locators.map(locator => authorizer.authorize!(subject, locator)));
        if (result.length !== group.length) throw new Error('CONTEXT_SOURCE_AUTHORIZATION_RESULT_MISMATCH');
        result.forEach((authorized, resultIndex) => {
          decisions[group[resultIndex]!.index] = { authorized: authorized === true };
        });
      } catch {
        for (const entry of group) decisions[entry.index] = {
          authorized: false,
          reason: 'context_source_authorization_error',
        };
      }
    }));

    return decisions;
  }
}

export function contextSourceLocatorFromRow(row: Record<string, unknown>): ContextSourceLocator {
  const metadata = objectValue(row.metadata_json);
  const content = objectValue(row.content_json);
  const eventType = firstRowString(row, ['event_type'])
    ?? firstString(metadata, ['eventType', 'event_type', 'type'])
    ?? firstString(content, ['changeType', 'eventType', 'event_type']);
  const sourceEventId = firstRowString(row, ['source_event_id'])
    ?? firstString(metadata, ['sourceEventId', 'source_event_id']);
  const explicitRecordType = firstRowString(row, ['record_kind'])
    ?? firstString(metadata, ['recordType', 'record_type']);
  const kind = firstString(metadata, ['kind']);
  const recordType = explicitRecordType === 'event' || kind === 'event' || Boolean(eventType)
    ? 'event'
    : 'snapshot';
  const explicitResource = firstRowString(row, ['entity_type'])
    ?? firstString(metadata, ['resourceType', 'resource_type', 'entityType', 'entity_type', 'objectType']);
  const nativeId = firstRowString(row, ['native_id']) ?? firstString(metadata, ['nativeId', 'native_id']);
  const boardId = firstString(metadata, ['boardId', 'board_id', 'projectId', 'project_id'])
    ?? (explicitResource === 'board' || explicitResource === 'project' ? nativeId : undefined);
  const taskId = firstString(metadata, ['taskId', 'task_id'])
    ?? (explicitResource === 'task' ? nativeId : undefined);
  const ownerPrincipal = firstRowString(row, ['owner_principal'])
    ?? firstString(metadata, ['ownerPrincipal', 'owner_principal']);
  const aclPrincipals = stringArray(row.acl_principals)
    ?? stringArray(metadata.aclPrincipals)
    ?? stringArray(metadata.acl_principals)
    ?? [];
  const resourceType = explicitResource === 'board' || explicitResource === 'project' || (!taskId && Boolean(boardId))
    ? 'board'
    : explicitResource === 'task' || Boolean(taskId)
      ? 'task'
      : 'unknown';
  return {
    sourceKind: String(row.source_kind ?? ''),
    sourceId: String(row.source_id ?? ''),
    collectionId: String(row.collection_id ?? ''),
    recordId: String(row.record_id ?? ''),
    revision: Number(row.current_revision ?? row.revision ?? 0),
    recordType,
    resourceType,
    ...(boardId ? { boardId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(sourceEventId ? { sourceEventId } : {}),
    ...(eventType ? { eventType } : {}),
    ...(ownerPrincipal ? { ownerPrincipal } : {}),
    aclPrincipals,
    deleted: row.deleted === true || metadata.deleted === true,
    metadata,
  };
}

function normalizeSourceKind(value: string): string {
  return value.trim().toLowerCase();
}

function objectValue(value: unknown): ContextObject {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ContextObject : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] | undefined {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return undefined;
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim()))].sort();
  } catch {
    return undefined;
  }
}

function firstRowString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function firstString(value: ContextObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
