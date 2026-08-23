import { MemoryCommandToolProvider } from '../agent/memoryCommandToolProvider.js';
import { ContextSearchToolProvider } from '../agent/contextSearchToolProvider.js';
import {
  AssignmentContextRecallScopeResolver,
  PgContextRecallService,
  type ContextCollectionAssignmentReader,
  type ContextRecallScopeResolver,
  type ContextRecallService,
  type ContextSourceAuthorizationRegistry,
} from '../context/retrieval/index.js';
import type { ContextPgPool, ContextStore } from '../context/store/index.js';
import type { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatchTypes.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { ToolProvider } from '../agent/toolRuntime.js';
export { createRuntimeContextPlane } from './runtimeContextPlane.js';

interface RuntimeMemoryContextToolsOptions {
  contextStore?: ContextStore;
  assignments?: ContextCollectionAssignmentReader;
  pool?: ContextPgPool;
  tablePrefix?: string;
  recallIdSigningKey?: string;
  sessionCatalog: Pick<SessionCatalog, 'get'>;
  sourceAuthorizationRegistry?: ContextSourceAuthorizationRegistry;
  memoryStore?: PgMemoryConsolidationStore;
  memoryIndexService?: MemoryIndexService | null;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

type RuntimeMemoryContextTools = Pick<
  RawRuntimeRunDispatchConfig,
  'memoryControlProviders' | 'resolveOrgAgentCollectionAssignments'
>;

export interface ContextRecallRuntime {
  recall: ContextRecallService;
  scopes: ContextRecallScopeResolver;
}

/** Shared construction keeps model tools and the user-facing citation API on one ACL path. */
export function createContextRecallRuntime(
  options: Pick<RuntimeMemoryContextToolsOptions,
    'contextStore' | 'assignments' | 'pool' | 'tablePrefix' | 'recallIdSigningKey' | 'sessionCatalog' | 'sourceAuthorizationRegistry'>,
): ContextRecallRuntime | undefined {
  if (!options.contextStore || !options.assignments || !options.pool) return undefined;
  return {
    recall: new PgContextRecallService({
      pool: options.pool,
      ...(options.tablePrefix ? { tablePrefix: options.tablePrefix } : {}),
      ...(options.recallIdSigningKey ? { idSigningKey: options.recallIdSigningKey } : {}),
      ...(options.sourceAuthorizationRegistry ? { sourceAuthorizationRegistry: options.sourceAuthorizationRegistry } : {}),
    }),
    scopes: new AssignmentContextRecallScopeResolver(options.assignments, {
      resourceTypes: ['org_knowledge'],
      resolveSessionPin: async subject => {
        if (!subject.sessionId) return null;
        const session = await options.sessionCatalog.get(subject.sessionId);
        if (!session) return null;
        return {
          tenantId: session.tenantId ?? '',
          userId: session.userId,
          ...(session.orgAgentId ? { orgAgentId: session.orgAgentId } : {}),
          ...(session.orgAgentSnapshot?.collectionAssignments
            ? { collectionAssignments: session.orgAgentSnapshot.collectionAssignments }
            : {}),
        };
      },
    }),
  };
}

export function createRuntimeMemoryContextTools(
  options: RuntimeMemoryContextToolsOptions,
): RuntimeMemoryContextTools {
  const memoryControlProviders: ToolProvider[] = [];
  if (options.memoryStore) {
    memoryControlProviders.push(new MemoryCommandToolProvider({
      store: options.memoryStore,
      memoryIndexService: options.memoryIndexService,
      logger: options.logger,
    }));
  }
  const contextRecall = createContextRecallRuntime(options);
  if (contextRecall) {
    memoryControlProviders.push(new ContextSearchToolProvider(contextRecall.recall, contextRecall.scopes));
  }

  return {
    ...(memoryControlProviders.length > 0 ? { memoryControlProviders } : {}),
    ...(options.assignments ? {
      resolveOrgAgentCollectionAssignments: async ({ tenantId, userId, agentId }) =>
        (await options.assignments!.listEffectiveResourceIds(tenantId, userId, 'org_knowledge', agentId))
          .map(binding => ({
            collectionId: binding.resourceId,
            assignmentVersion: binding.assignmentVersion,
            resourceType: 'org_knowledge' as const,
          })),
    } : {}),
  };
}
