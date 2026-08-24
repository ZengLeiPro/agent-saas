import type { ContextRecallScopeResolver, ContextRecallScopeRequest } from './ports.js';
import type {
  ContextRecallCollectionScope,
  ContextRecallResolvedScope,
  ContextRecallSubject,
} from './types.js';

export type ContextCollectionAssignmentResourceType = 'org_knowledge' | 'org_memory';

/** Narrow structural port implemented by PgAssignmentStore.listEffectiveResourceIds. */
export interface ContextCollectionAssignmentReader {
  listEffectiveResourceIds(
    tenantId: string,
    userId: string,
    resourceType: ContextCollectionAssignmentResourceType,
    agentId?: string,
  ): Promise<ReadonlyArray<{
    resourceId: string;
    assignmentVersion: number;
  }>>;
}

export interface ContextRecallSessionPin {
  tenantId: string;
  userId: string;
  orgAgentId?: string;
  /** Undefined marks a legacy snapshot created before collection pins existed. */
  collectionAssignments?: readonly ContextRecallCollectionScope[];
}

export interface ContextRecallAccessDecision {
  activeMembership: boolean;
  organizationKnowledgeEnabled: boolean;
}

export interface AssignmentContextRecallScopeResolverOptions {
  resourceTypes?: readonly ContextCollectionAssignmentResourceType[];
  now?: () => Date;
  /** Trusted, live membership/policy lookup. It must not derive tenant identity from client input. */
  resolveAccess?: (subject: ContextRecallSubject) => Promise<ContextRecallAccessDecision>;
  /** Trusted session lookup. When configured, a missing/mismatched session fails closed. */
  resolveSessionPin?: (subject: ContextRecallSubject) => Promise<ContextRecallSessionPin | null>;
}

export class ContextRecallScopeDriftError extends Error {
  constructor(readonly code:
    | 'CONTEXT_RECALL_SESSION_UNAVAILABLE'
    | 'CONTEXT_RECALL_SESSION_SUBJECT_MISMATCH'
    | 'CONTEXT_RECALL_MEMBERSHIP_INACTIVE'
    | 'CONTEXT_RECALL_ASSIGNMENT_PIN_DRIFT') {
    super(code);
    this.name = 'ContextRecallScopeDriftError';
  }
}

/**
 * Resolves effective collection assignments on every call. PgAssignmentStore applies
 * deny-overrides-allow in SQL. Authorization lookup errors are propagated, and an org
 * Agent snapshot pin must exactly match the fresh assignment versions.
 */
export class AssignmentContextRecallScopeResolver implements ContextRecallScopeResolver {
  private readonly resourceTypes: readonly ContextCollectionAssignmentResourceType[];
  private readonly now: () => Date;

  constructor(
    private readonly assignments: ContextCollectionAssignmentReader,
    private readonly options: AssignmentContextRecallScopeResolverOptions = {},
  ) {
    this.resourceTypes = options.resourceTypes ?? ['org_knowledge'];
    this.now = options.now ?? (() => new Date());
  }

  async resolve(
    subject: ContextRecallSubject,
    _request: ContextRecallScopeRequest,
  ): Promise<ContextRecallResolvedScope> {
    if (this.options.resolveAccess) {
      const access = await this.options.resolveAccess(subject);
      if (!access.activeMembership) {
        throw new ContextRecallScopeDriftError('CONTEXT_RECALL_MEMBERSHIP_INACTIVE');
      }
      // Policy is deliberately evaluated before session pins and assignments. A live
      // disable therefore reduces even an old pinned session to an empty current scope.
      if (!access.organizationKnowledgeEnabled) return this.emptyScope();
    }

    let agentId = subject.orgAgentId;
    let pin: readonly ContextRecallCollectionScope[] | undefined;
    if (this.options.resolveSessionPin) {
      const session = await this.options.resolveSessionPin(subject);
      if (!session) throw new ContextRecallScopeDriftError('CONTEXT_RECALL_SESSION_UNAVAILABLE');
      if (session.tenantId !== subject.tenantId || session.userId !== subject.userId) {
        throw new ContextRecallScopeDriftError('CONTEXT_RECALL_SESSION_SUBJECT_MISMATCH');
      }
      agentId = session.orgAgentId;
      pin = session.collectionAssignments;
    }

    const groups = await Promise.all(this.resourceTypes.map(async resourceType => {
      const assignments = await this.assignments.listEffectiveResourceIds(
        subject.tenantId,
        subject.userId,
        resourceType,
        agentId,
      );
      return assignments.map((assignment): ContextRecallCollectionScope => ({
        collectionId: assignment.resourceId,
        assignmentVersion: assignment.assignmentVersion,
        resourceType,
      }));
    }));

    const collections = dedupeCollections(groups.flat());
    // Legacy org Agent sessions have no pin; they remain compatible but use only the
    // fresh assignment authority. Once a pin exists, any addition/removal/version drift
    // rejects the whole query so an old snapshot can never retain broader authority.
    if (pin !== undefined && !sameAssignmentPin(pin, collections)) {
      throw new ContextRecallScopeDriftError('CONTEXT_RECALL_ASSIGNMENT_PIN_DRIFT');
    }

    return {
      collections,
      resolvedAt: this.now().toISOString(),
      degraded: false,
      degradationReasons: [],
    };
  }

  private emptyScope(): ContextRecallResolvedScope {
    return {
      collections: [],
      resolvedAt: this.now().toISOString(),
      degraded: false,
      degradationReasons: [],
    };
  }
}

function dedupeCollections(collections: readonly ContextRecallCollectionScope[]): ContextRecallCollectionScope[] {
  const byCollection = new Map<string, ContextRecallCollectionScope>();
  for (const collection of collections) {
    const existing = byCollection.get(collection.collectionId);
    if (!existing || collection.assignmentVersion > existing.assignmentVersion) {
      byCollection.set(collection.collectionId, collection);
    }
  }
  return [...byCollection.values()].sort((a, b) => a.collectionId.localeCompare(b.collectionId));
}

function sameAssignmentPin(
  pin: readonly ContextRecallCollectionScope[],
  current: readonly ContextRecallCollectionScope[],
): boolean {
  const normalize = (items: readonly ContextRecallCollectionScope[]) => items
    .map(item => `${item.resourceType ?? 'org_knowledge'}\u0000${item.collectionId}\u0000${item.assignmentVersion}`)
    .sort();
  const left = normalize(pin);
  const right = normalize(current);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
