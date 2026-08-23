import type {
  ContextCollection,
  ContextSource,
  ContextSyncPartition,
  CreateContextCollectionInput,
  CreateContextSourceInput,
  EnsureContextPartitionInput,
  IngestContextPageInput,
  IngestContextPageResult,
} from '../../store/index.js';
import type {
  TaskboardBoardRow,
  TaskboardChangeRow,
  TaskboardPage,
  TaskboardTaskRow,
} from './types.js';

export interface TaskboardContextReader {
  listTenantIds(): Promise<string[]>;
  listBoards(tenantId: string, cursor: string | undefined, limit: number): Promise<TaskboardPage<TaskboardBoardRow>>;
  listTasks(tenantId: string, cursor: string | undefined, limit: number): Promise<TaskboardPage<TaskboardTaskRow>>;
  getBoard(tenantId: string, boardId: string): Promise<TaskboardBoardRow | null>;
  getTask(tenantId: string, taskId: string): Promise<TaskboardTaskRow | null>;
  getChangeUpperBound(tenantId: string): Promise<string>;
  listChanges(
    tenantId: string,
    afterSeq: string,
    throughSeq: string,
    limit: number,
  ): Promise<TaskboardPage<TaskboardChangeRow>>;
}

/** The public ContextStore surface used by this worker. */
export interface TaskboardContextStore {
  getSource(tenantId: string, sourceId: string): Promise<ContextSource | null>;
  createSource(input: CreateContextSourceInput): Promise<ContextSource>;
  getCollection(tenantId: string, sourceId: string, collectionId: string): Promise<ContextCollection | null>;
  createCollection(input: CreateContextCollectionInput): Promise<ContextCollection>;
  ensurePartition(input: EnsureContextPartitionInput): Promise<ContextSyncPartition>;
  getPartition(tenantId: string, sourceId: string, collectionId: string, partitionKey: string): Promise<ContextSyncPartition | null>;
  acquirePartitionLease(input: {
    tenantId: string;
    sourceId: string;
    collectionId: string;
    partitionKey: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<ContextSyncPartition | null>;
  ingestPage(input: IngestContextPageInput): Promise<IngestContextPageResult>;
}

export interface TaskboardClock {
  now(): Date;
}
