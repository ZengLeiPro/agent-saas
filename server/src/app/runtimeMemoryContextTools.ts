import { MemoryCommandToolProvider } from '../agent/memoryCommandToolProvider.js';
import { ContextSearchToolProvider } from '../agent/contextSearchToolProvider.js';
import {
  AssignmentContextRecallScopeResolver,
  PgContextRecallService,
  type ContextCollectionAssignmentReader,
} from '../context/retrieval/index.js';
import type { ContextPgPool, ContextStore } from '../context/store/index.js';
import type { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatchTypes.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { ToolProvider } from '../agent/toolRuntime.js';

interface RuntimeMemoryContextToolsOptions {
  contextStore?: ContextStore;
  assignments?: ContextCollectionAssignmentReader;
  pool?: ContextPgPool;
  tablePrefix?: string;
  sessionCatalog: SessionCatalog;
  memoryStore?: PgMemoryConsolidationStore;
  memoryIndexService?: MemoryIndexService | null;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

type RuntimeMemoryContextTools = Pick<
  RawRuntimeRunDispatchConfig,
  'memoryControlProviders' | 'resolveOrgAgentCollectionAssignments'
>;

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
  if (options.contextStore && options.assignments && options.pool) {
    memoryControlProviders.push(new ContextSearchToolProvider(
      new PgContextRecallService({
        pool: options.pool,
        ...(options.tablePrefix ? { tablePrefix: options.tablePrefix } : {}),
      }),
      new AssignmentContextRecallScopeResolver(options.assignments, {
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
    ));
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
