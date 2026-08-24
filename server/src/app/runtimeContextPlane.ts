import { DerivedContextStore } from '../context/derived/index.js';
import {
  AzerothContextPrincipalResolver,
  ContextSourceAuthorizationRegistry,
  DirectoryContextSourceAuthorizer,
  PrincipalContextSourceAuthorizer,
  TaskboardContextSourceAuthorizer,
} from '../context/retrieval/index.js';
import { ContextPlanePhase2Runtime } from '../context/sync/runtime.js';
import type { ContextStore, ContextPgPool } from '../context/store/index.js';
import type { PgAssignmentStore } from '../data/assignments/store.js';
import type { PgMembershipStore } from '../data/memberships/store.js';
import type { UserStore } from '../data/users/store.js';
import type { PgTaskboardStore } from '../taskboard/store.js';

export interface RuntimeContextPlaneOptions {
  contextStore?: ContextStore;
  taskboardStore?: PgTaskboardStore;
  membershipStore?: PgMembershipStore;
  assignmentStore?: PgAssignmentStore;
  userStore?: UserStore;
  pool?: ContextPgPool;
  tablePrefix?: string;
  fetchImpl?: typeof fetch;
  enableWorker: boolean;
  logger: { info(message: string): void; warn(message: string): void };
}

export interface RuntimeContextPlane {
  authorizationRegistry: ContextSourceAuthorizationRegistry;
  derivedStore?: DerivedContextStore;
  syncRuntime?: ContextPlanePhase2Runtime;
}

export function createRuntimeContextPlane(options: RuntimeContextPlaneOptions): RuntimeContextPlane {
  const authorizationRegistry = new ContextSourceAuthorizationRegistry();
  if (options.taskboardStore) {
    authorizationRegistry.register('taskboard', new TaskboardContextSourceAuthorizer(options.taskboardStore));
  }
  if (options.membershipStore) {
    authorizationRegistry.register('directory', new DirectoryContextSourceAuthorizer({
      isActive: async (tenantId, userId) =>
        (await options.membershipStore!.getMembership(tenantId, userId))?.status === 'active',
    }));
  }
  if (options.userStore) {
    authorizationRegistry.register('azeroth', new PrincipalContextSourceAuthorizer(
      new AzerothContextPrincipalResolver({ users: options.userStore }),
    ));
  }

  const derivedStore = options.pool && options.membershipStore
    ? new DerivedContextStore({
        pool: options.pool,
        ...(options.tablePrefix ? { tablePrefix: options.tablePrefix } : {}),
        roleGate: {
          mayCorrectOrganization: async ({ tenantId, actorId }) => {
            const membership = await options.membershipStore!.getMembership(tenantId, actorId);
            return membership?.status === 'active' && membership.persona === 'org_admin';
          },
        },
      })
    : undefined;

  const syncRuntime = options.contextStore && options.membershipStore
    && options.assignmentStore && options.userStore
    ? new ContextPlanePhase2Runtime({
        contextStore: options.contextStore,
        ...(options.taskboardStore ? { taskboardStore: options.taskboardStore } : {}),
        membershipStore: options.membershipStore,
        assignmentStore: options.assignmentStore,
        userStore: options.userStore,
        derivedStore,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        logger: options.logger,
      })
    : undefined;
  if (options.enableWorker) syncRuntime?.start();
  return { authorizationRegistry, derivedStore, syncRuntime };
}
