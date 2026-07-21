import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import pg, { type PoolClient } from "pg";
import { z } from "zod";

import {
  demoPublicEvidenceSchema,
  type DemoPublicEvidence,
} from "../../../../shared/src/index.js";

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export type WorkflowDemoRunStatus = "running" | "waiting" | "passed" | "failed";
export type WorkflowDemoEventPhase =
  | "trigger" | "observe" | "judge" | "approval" | "act"
  | "wait" | "resume" | "verify" | "compensate" | "handoff";
export type WorkflowDemoReviewDecision = "approved" | "rejected";

export interface WorkflowDemoObjectState {
  id: string;
  label: string;
  state: string;
  version: number;
}

export interface WorkflowDemoAgentProvenance {
  runtimeSessionId: string;
  runtimeRunId: string;
  toolInvocationId: string;
  toolCallId: string;
  toolId: "WorkflowDemoStep";
  toolName: "WorkflowDemoStep";
  toolInputDigest: string;
  workflowEventId: string;
  actionBindingDigest: string;
  tenantId: string;
  actorUserId: string;
}

export interface WorkflowDemoEventRecord {
  sequence: number;
  eventId: string;
  eventDigest: string;
  phase: WorkflowDemoEventPhase;
  label: string;
  summary: string;
  state: string;
  actorRole: string;
  targetObjectId: string;
  mutation: boolean;
  approvalRequired: boolean;
  idempotencyKeyHash: string;
  readBackVerified: boolean;
  receiptId: string;
  source: "agent" | "external";
  recordedByUserId: string;
  cycleId?: string;
  observationKind?: "normal" | "exception";
  observedAt?: string;
  sourceSnapshotDigest?: string;
  externalSignalId?: string;
  externalTransactionDigest?: string;
  agentProvenance?: WorkflowDemoAgentProvenance;
  createdAt: string;
}

export interface WorkflowDemoVerification {
  readBackVerified: boolean;
  beforeObjectCount: number;
  afterObjectCount: number;
  eventCount: number;
  receiptCount: number;
  verifiedAt: string;
  evidenceHash: string;
}

export interface WorkflowDemoPublicReplay extends DemoPublicEvidence {
  replayVersion: 1;
  status: "passed";
  startedAt: string;
  completedAt: string;
  verification: WorkflowDemoVerification;
}

export const workflowDemoPublicReplaySchema = demoPublicEvidenceSchema.extend({
  replayVersion: z.literal(1),
  status: z.literal("passed"),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  verification: z.object({
    readBackVerified: z.literal(true),
    beforeObjectCount: z.number().int().nonnegative(),
    afterObjectCount: z.number().int().nonnegative(),
    eventCount: z.number().int().positive(),
    receiptCount: z.number().int().nonnegative(),
    verifiedAt: z.string().datetime(),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();

const workflowDemoAgentProvenanceSchema = z.object({
  runtimeSessionId: z.string().min(1),
  runtimeRunId: z.string().min(1),
  toolInvocationId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolId: z.literal("WorkflowDemoStep"),
  toolName: z.literal("WorkflowDemoStep"),
  toolInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  workflowEventId: z.string().min(1),
  actionBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
}).strict();

/** 面向 Engine/HTTP 的运行 DTO；永远不包含 execution/public token 或其 hash。 */
export interface WorkflowDemoRunRecord {
  runId: string;
  demoId: string;
  workflowId: string;
  catalogScenarioId: string;
  tenantId: string;
  actorUserId: string;
  /** 首次可信 Agent 工具调用绑定的会话；外部信号据此恢复同一会话。 */
  runtimeSessionId?: string;
  idempotencyKeyHash: string;
  requestDigest: string;
  definitionVersion: string;
  manifestDigest: string;
  actionDigest: string;
  approvalDigest?: string;
  status: WorkflowDemoRunStatus;
  startedAt: string;
  completedAt?: string;
  failureReason?: string;
}

export interface WorkflowDemoRuntimeContinuationRequest {
  run: WorkflowDemoRunRecord;
  externalEvent: WorkflowDemoEventRecord;
  externalSignalId: string;
  nextEventId: string;
}

export type WorkflowDemoRuntimeContinuationHandler = (
  request: WorkflowDemoRuntimeContinuationRequest,
) => Promise<void>;

export interface CreateWorkflowDemoRunInput {
  demoId: string;
  workflowId: string;
  catalogScenarioId: string;
  tenantId: string;
  actorUserId: string;
  idempotencyKey: string;
  definitionVersion: string;
  manifestDigest: string;
  actionDigest: string;
  approvalDigest?: string;
}

export interface CreateWorkflowDemoRunResult {
  run: WorkflowDemoRunRecord;
  replayed: boolean;
  /** 只在成功创建新 run 时出现一次；调用方必须自行保管至运行结束。 */
  executionToken?: string;
}

export type AppendWorkflowDemoEventInput = Omit<
  WorkflowDemoEventRecord,
  "sequence" | "createdAt" | "eventDigest" | "source" | "recordedByUserId"
>;

export interface AppendWorkflowDemoEventResult {
  event: WorkflowDemoEventRecord;
  replayed: boolean;
}

export interface WorkflowDemoMutationInput {
  mutationId: string;
  workflowActionId?: string;
  objectId: string;
  expectedVersion: number;
  nextLabel?: string;
  nextState: string;
  receiptId: string;
  actionDigest: string;
}

export interface WorkflowDemoMutationRecord {
  mutationId: string;
  workflowActionId?: string;
  mutationDigest: string;
  objectId: string;
  before: WorkflowDemoObjectState;
  after: WorkflowDemoObjectState;
  receiptId: string;
  actionDigest: string;
  source: "agent" | "external";
  recordedByUserId: string;
  agentProvenance?: WorkflowDemoAgentProvenance;
  createdAt: string;
}

export interface WorkflowDemoMutationResult {
  mutation: WorkflowDemoMutationRecord;
  replayed: boolean;
}

export interface ApplyWorkflowDemoExternalSignalInput {
  runId: string;
  externalActorUserId: string;
  signalId: string;
  signalDigest: string;
  transactionDigest: string;
  mutations: WorkflowDemoMutationInput[];
  wait?: {
    waitId: string;
    expectedResumeConditionDigest: string;
  };
  event: AppendWorkflowDemoEventInput;
  /** 与外部事件同事务写入的 durable continuation；没有后续 Agent 步骤时省略。 */
  continuation?: {
    externalSignalId: string;
    nextEventId: string;
  };
}

export interface ApplyWorkflowDemoExternalSignalResult {
  run: WorkflowDemoRunRecord;
  event: WorkflowDemoEventRecord;
  mutations: WorkflowDemoMutationRecord[];
  wait?: WorkflowDemoWaitRecord;
  objects: WorkflowDemoObjectState[];
  replayed: boolean;
}

export interface WorkflowDemoWaitInput {
  waitId: string;
  reason: string;
  resumeConditionDigest: string;
  agentProvenance?: WorkflowDemoAgentProvenance;
}

export interface WorkflowDemoWaitRecord extends WorkflowDemoWaitInput {
  runId: string;
  status: "waiting" | "resumed";
  startedAt: string;
  resumedAt?: string;
  resumeEventDigest?: string;
  resumedByUserId?: string;
}

export interface WorkflowDemoReplaySnapshot {
  replayId: string;
  runId: string;
  demoId: string;
  workflowId: string;
  catalogScenarioId: string;
  definitionVersion: string;
  contentHash: string;
  replay: WorkflowDemoPublicReplay;
  createdAt: string;
}

export interface CompleteWorkflowDemoRunResult {
  run: WorkflowDemoRunRecord;
  snapshot: WorkflowDemoReplaySnapshot;
  replayed: boolean;
}

export interface ReviewWorkflowDemoReplayInput {
  runId: string;
  reviewerUserId: string;
  decision: WorkflowDemoReviewDecision;
  contentHash: string;
}

export interface WorkflowDemoReplayReview {
  replayId: string;
  reviewerUserId: string;
  decision: WorkflowDemoReviewDecision;
  contentHash: string;
  reviewedAt: string;
}

export interface PublishWorkflowDemoReplayInput {
  runId: string;
  publisherUserId: string;
  supersedesReplayId?: string;
}

export interface WorkflowDemoReplayPublication {
  replayId: string;
  publisherUserId: string;
  publishedAt: string;
  supersedesReplayId?: string;
}

export interface WorkflowDemoPublishedReplay {
  snapshot: WorkflowDemoReplaySnapshot;
  review: WorkflowDemoReplayReview;
  publication: WorkflowDemoReplayPublication;
}

export interface PublishWorkflowDemoReplayResult {
  published: WorkflowDemoPublishedReplay;
  replayed: boolean;
  /** 只在首次公开时出现一次；存储层只保存 SHA-256 hash。 */
  publicToken?: string;
}

export interface WorkflowDemoStore {
  getOrCreateRun(input: CreateWorkflowDemoRunInput): Promise<CreateWorkflowDemoRunResult>;
  getByRunId(runId: string): Promise<WorkflowDemoRunRecord | null>;
  abandonUnboundRun(
    runId: string,
    tenantId: string,
    actorUserId: string,
    reason: string,
  ): Promise<WorkflowDemoRunRecord>;
  expireUnboundRuns(beforeIso: string): Promise<number>;
  bindRuntimeSession(runId: string, provenance: WorkflowDemoAgentProvenance): Promise<WorkflowDemoRunRecord>;
  setRuntimeContinuationHandler(handler: WorkflowDemoRuntimeContinuationHandler): void;
  requestRuntimeContinuation(request: WorkflowDemoRuntimeContinuationRequest): Promise<boolean>;
  retryPendingRuntimeContinuations(limit?: number): Promise<number>;
  seedObjects(runId: string, executionToken: string, objects: WorkflowDemoObjectState[]): Promise<WorkflowDemoObjectState[]>;
  readObjects(runId: string): Promise<WorkflowDemoObjectState[]>;
  readObjectsAuthorized(runId: string, provenance: WorkflowDemoAgentProvenance): Promise<WorkflowDemoObjectState[]>;
  mutateObject(runId: string, provenance: WorkflowDemoAgentProvenance, input: WorkflowDemoMutationInput): Promise<WorkflowDemoMutationResult>;
  mutateObjectByExternalActor(runId: string, externalActorUserId: string, input: WorkflowDemoMutationInput): Promise<WorkflowDemoMutationResult>;
  readMutations(runId: string): Promise<WorkflowDemoMutationRecord[]>;
  appendEvent(runId: string, provenance: WorkflowDemoAgentProvenance, event: AppendWorkflowDemoEventInput): Promise<AppendWorkflowDemoEventResult>;
  appendExternalEvent(runId: string, externalActorUserId: string, event: AppendWorkflowDemoEventInput): Promise<AppendWorkflowDemoEventResult>;
  applyExternalSignal(input: ApplyWorkflowDemoExternalSignalInput): Promise<ApplyWorkflowDemoExternalSignalResult>;
  readEvents(runId: string): Promise<WorkflowDemoEventRecord[]>;
  beginWait(runId: string, provenance: WorkflowDemoAgentProvenance, input: WorkflowDemoWaitInput): Promise<WorkflowDemoWaitRecord>;
  readWaits(runId: string): Promise<WorkflowDemoWaitRecord[]>;
  resumeRunBySignal(runId: string, externalActorUserId: string, waitId: string, resumeEventDigest: string): Promise<WorkflowDemoWaitRecord>;
  completeRun(runId: string, provenance: WorkflowDemoAgentProvenance, replay: WorkflowDemoPublicReplay): Promise<CompleteWorkflowDemoRunResult>;
  failRun(runId: string, executionToken: string, reason: string): Promise<WorkflowDemoRunRecord>;
  getReplayByRunId(runId: string): Promise<WorkflowDemoReplaySnapshot | null>;
  reviewReplay(input: ReviewWorkflowDemoReplayInput): Promise<WorkflowDemoReplayReview>;
  publishReplay(input: PublishWorkflowDemoReplayInput): Promise<PublishWorkflowDemoReplayResult>;
  getByPublicToken(token: string): Promise<WorkflowDemoPublishedReplay | null>;
  getPublishedByReplayId(replayId: string): Promise<WorkflowDemoPublishedReplay | null>;
  getLatestPublishedByCatalog(catalogScenarioId: string): Promise<WorkflowDemoPublishedReplay | null>;
}

export class WorkflowDemoStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "WorkflowDemoStoreError";
  }
}

export class WorkflowDemoConflictError extends WorkflowDemoStoreError {
  constructor(message: string, code = "WORKFLOW_DEMO_CONFLICT") {
    super(message, code, 409);
    this.name = "WorkflowDemoConflictError";
  }
}

export function hashWorkflowDemoIdempotencyKey(value: string): string {
  return sha256(value);
}

export function canonicalWorkflowDemoRequestDigest(input: CreateWorkflowDemoRunInput): string {
  return digestCanonical({
    definitionVersion: input.definitionVersion,
    demoId: input.demoId,
    workflowId: input.workflowId,
    catalogScenarioId: input.catalogScenarioId,
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    manifestDigest: input.manifestDigest,
    actionDigest: input.actionDigest,
    approvalDigest: input.approvalDigest ?? null,
  });
}

interface InMemoryRunState {
  record: WorkflowDemoRunRecord;
  executionTokenHash: string;
  seedDigest?: string;
}

interface InMemoryPublicationState {
  record: WorkflowDemoReplayPublication;
  publicTokenHash: string;
}

const DEFAULT_UNBOUND_LAUNCH_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_UNBOUND_LAUNCH_SWEEP_INTERVAL_MS = 30_000;
const RETRYABLE_UNBOUND_LAUNCH_FAILURES = new Set([
  "launch_not_acknowledged",
  "launch_expired_before_runtime_ack",
]);

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${label} 必须是正数`);
  return duration;
}

function isRetryableUnboundLaunch(run: WorkflowDemoRunRecord): boolean {
  return run.status === "failed"
    && !run.runtimeSessionId
    && RETRYABLE_UNBOUND_LAUNCH_FAILURES.has(run.failureReason ?? "");
}

export interface WorkflowDemoLaunchMaintenanceOptions {
  unboundLaunchTtlMs?: number;
  unboundLaunchSweepIntervalMs?: number;
}

export class InMemoryWorkflowDemoStore implements WorkflowDemoStore {
  private readonly runs = new Map<string, InMemoryRunState>();
  private readonly runKeys = new Map<string, string>();
  private readonly objects = new Map<string, WorkflowDemoObjectState[]>();
  private readonly events = new Map<string, WorkflowDemoEventRecord[]>();
  private readonly mutations = new Map<string, WorkflowDemoMutationRecord[]>();
  private runtimeContinuationHandler?: WorkflowDemoRuntimeContinuationHandler;
  private runtimeContinuationTimer?: ReturnType<typeof setInterval>;
  private readonly unboundLaunchTtlMs: number;
  private readonly unboundLaunchSweepIntervalMs: number;
  private unboundLaunchSweepTimer?: ReturnType<typeof setInterval>;
  private readonly continuations = new Map<string, {
    request: WorkflowDemoRuntimeContinuationRequest;
    status: "pending" | "delivered";
    attempts: number;
    lastError?: string;
  }>();
  private readonly waits = new Map<string, WorkflowDemoWaitRecord>();
  private readonly snapshots = new Map<string, WorkflowDemoReplaySnapshot>();
  private readonly runSnapshots = new Map<string, string>();
  private readonly reviews = new Map<string, WorkflowDemoReplayReview>();
  private readonly publications = new Map<string, InMemoryPublicationState>();
  private readonly publicTokenIndex = new Map<string, string>();

  constructor(options: WorkflowDemoLaunchMaintenanceOptions = {}) {
    this.unboundLaunchTtlMs = positiveDuration(
      options.unboundLaunchTtlMs,
      DEFAULT_UNBOUND_LAUNCH_TTL_MS,
      "unboundLaunchTtlMs",
    );
    this.unboundLaunchSweepIntervalMs = positiveDuration(
      options.unboundLaunchSweepIntervalMs,
      DEFAULT_UNBOUND_LAUNCH_SWEEP_INTERVAL_MS,
      "unboundLaunchSweepIntervalMs",
    );
    this.startUnboundLaunchReconciler();
  }

  async getOrCreateRun(input: CreateWorkflowDemoRunInput): Promise<CreateWorkflowDemoRunResult> {
    assertCreateInput(input);
    const keyHash = hashWorkflowDemoIdempotencyKey(input.idempotencyKey);
    const requestDigest = canonicalWorkflowDemoRequestDigest(input);
    const compoundKey = stableStringify([input.tenantId, input.actorUserId, keyHash]);
    const existingRunId = this.runKeys.get(compoundKey);
    if (existingRunId) {
      const state = this.requireRunState(existingRunId);
      const existing = state.record;
      if (existing.requestDigest !== requestDigest) {
        throw new WorkflowDemoConflictError(
          "同一幂等键对应了不同的 Workflow Demo 请求",
          "WORKFLOW_DEMO_IDEMPOTENCY_CONFLICT",
        );
      }
      if (isRetryableUnboundLaunch(existing)) {
        const executionToken = createToken();
        state.executionTokenHash = sha256(executionToken);
        state.record.status = "running";
        state.record.startedAt = new Date().toISOString();
        delete state.record.completedAt;
        delete state.record.failureReason;
        return { run: clone(state.record), replayed: false, executionToken };
      }
      return { run: clone(existing), replayed: true };
    }

    const executionToken = createToken();
    const record: WorkflowDemoRunRecord = {
      runId: randomUUID(),
      demoId: input.demoId,
      workflowId: input.workflowId,
      catalogScenarioId: input.catalogScenarioId,
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      idempotencyKeyHash: keyHash,
      requestDigest,
      definitionVersion: input.definitionVersion,
      manifestDigest: input.manifestDigest,
      actionDigest: input.actionDigest,
      ...(input.approvalDigest ? { approvalDigest: input.approvalDigest } : {}),
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.runs.set(record.runId, {
      record: clone(record),
      executionTokenHash: sha256(executionToken),
    });
    this.runKeys.set(compoundKey, record.runId);
    return { run: clone(record), replayed: false, executionToken };
  }

  async getByRunId(runId: string): Promise<WorkflowDemoRunRecord | null> {
    const state = this.runs.get(runId);
    return state ? clone(state.record) : null;
  }

  async abandonUnboundRun(
    runId: string,
    tenantId: string,
    actorUserId: string,
    reason: string,
  ): Promise<WorkflowDemoRunRecord> {
    const state = this.requireRunState(runId);
    if (state.record.tenantId !== tenantId || state.record.actorUserId !== actorUserId) {
      throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
    }
    if (state.record.runtimeSessionId) {
      throw new WorkflowDemoConflictError("Workflow Demo 已进入 Agent Runtime，不能按启动失败回收", "WORKFLOW_DEMO_ALREADY_BOUND");
    }
    if (state.record.status === "passed") throw terminalStateError(state.record.status);
    if (state.record.status !== "failed") {
      state.record.status = "failed";
      state.record.failureReason = reason;
      state.record.completedAt = new Date().toISOString();
    }
    return clone(state.record);
  }

  async expireUnboundRuns(beforeIso: string): Promise<number> {
    const before = Date.parse(beforeIso);
    if (!Number.isFinite(before)) throw new Error("Workflow Demo 过期时间无效");
    let expired = 0;
    for (const state of this.runs.values()) {
      if (!state.record.runtimeSessionId
        && state.record.status === "running"
        && Date.parse(state.record.startedAt) < before) {
        state.record.status = "failed";
        state.record.failureReason = "launch_expired_before_runtime_ack";
        state.record.completedAt = new Date().toISOString();
        expired += 1;
      }
    }
    return expired;
  }

  close(): void {
    if (this.runtimeContinuationTimer) clearInterval(this.runtimeContinuationTimer);
    if (this.unboundLaunchSweepTimer) clearInterval(this.unboundLaunchSweepTimer);
  }

  private startUnboundLaunchReconciler(): void {
    void this.reconcileUnboundLaunches();
    this.unboundLaunchSweepTimer = setInterval(() => {
      void this.reconcileUnboundLaunches();
    }, this.unboundLaunchSweepIntervalMs);
    this.unboundLaunchSweepTimer.unref?.();
  }

  private async reconcileUnboundLaunches(): Promise<void> {
    const beforeIso = new Date(Date.now() - this.unboundLaunchTtlMs).toISOString();
    await this.expireUnboundRuns(beforeIso);
  }

  setRuntimeContinuationHandler(handler: WorkflowDemoRuntimeContinuationHandler): void {
    this.runtimeContinuationHandler = handler;
    void this.retryPendingRuntimeContinuations();
    if (!this.runtimeContinuationTimer) {
      this.runtimeContinuationTimer = setInterval(() => {
        void this.retryPendingRuntimeContinuations();
      }, 5_000);
      this.runtimeContinuationTimer.unref?.();
    }
  }

  async requestRuntimeContinuation(request: WorkflowDemoRuntimeContinuationRequest): Promise<boolean> {
    const id = workflowDemoContinuationId(request.run.runId, request.externalSignalId, request.nextEventId);
    const pending = this.continuations.get(id);
    if (!pending || pending.status === "delivered") return pending?.status === "delivered";
    if (!request.run.runtimeSessionId || !this.runtimeContinuationHandler) return false;
    try {
      await this.runtimeContinuationHandler(clone(request));
      pending.status = "delivered";
      pending.attempts += 1;
      delete pending.lastError;
      return true;
    } catch (error) {
      pending.attempts += 1;
      pending.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async retryPendingRuntimeContinuations(limit = 50): Promise<number> {
    let delivered = 0;
    for (const pending of [...this.continuations.values()]
      .filter((item) => item.status === "pending")
      .slice(0, Math.max(0, limit))) {
      if (await this.requestRuntimeContinuation(pending.request)) delivered += 1;
    }
    return delivered;
  }

  async bindRuntimeSession(
    runId: string,
    provenance: WorkflowDemoAgentProvenance,
  ): Promise<WorkflowDemoRunRecord> {
    const state = this.requireRunState(runId);
    assertAgentProvenance(state.record, provenance);
    if (state.record.runtimeSessionId && state.record.runtimeSessionId !== provenance.runtimeSessionId) {
      throw new WorkflowDemoConflictError(
        "Workflow Demo run 已绑定其他会话",
        "WORKFLOW_DEMO_SESSION_BINDING_CONFLICT",
      );
    }
    state.record.runtimeSessionId = provenance.runtimeSessionId;
    return clone(state.record);
  }

  async seedObjects(
    runId: string,
    executionToken: string,
    objects: WorkflowDemoObjectState[],
  ): Promise<WorkflowDemoObjectState[]> {
    const runState = this.requireAuthorizedRun(runId, executionToken);
    requireActive(runState.record);
    assertObjects(objects);
    const canonicalObjects = clone(objects).sort((left, right) => left.id.localeCompare(right.id));
    const seedDigest = digestCanonical(canonicalObjects);
    if (runState.seedDigest) {
      if (runState.seedDigest !== seedDigest) {
        throw new WorkflowDemoConflictError("演示对象前态已冻结，不能覆盖", "WORKFLOW_DEMO_SEED_CONFLICT");
      }
      return clone(this.objects.get(runId) ?? []);
    }
    runState.seedDigest = seedDigest;
    this.objects.set(runId, canonicalObjects);
    return clone(canonicalObjects);
  }

  async readObjects(runId: string): Promise<WorkflowDemoObjectState[]> {
    this.requireRunState(runId);
    return clone(this.objects.get(runId) ?? []);
  }

  async readObjectsAuthorized(runId: string, provenance: WorkflowDemoAgentProvenance): Promise<WorkflowDemoObjectState[]> {
    this.requireAgentRun(runId, provenance);
    return this.readObjects(runId);
  }

  async mutateObject(
    runId: string,
    provenance: WorkflowDemoAgentProvenance,
    input: WorkflowDemoMutationInput,
  ): Promise<WorkflowDemoMutationResult> {
    const runState = this.requireAgentRun(runId, provenance);
    requireRunning(runState.record);
    assertAgentProvenance(runState.record, provenance, { actionDigest: input.actionDigest });
    const digest = digestCanonical(input);
    const currentMutations = this.mutations.get(runId) ?? [];
    const existing = currentMutations.find((item) => item.mutationId === input.mutationId);
    if (existing) {
      if (existing.mutationDigest !== digest) {
        throw new WorkflowDemoConflictError("同一 mutationId 对应了不同动作", "WORKFLOW_DEMO_MUTATION_CONFLICT");
      }
      return { mutation: clone(existing), replayed: true };
    }
    if (currentMutations.some((item) => item.receiptId === input.receiptId)) {
      throw new WorkflowDemoConflictError("动作回执已被其他 mutation 使用", "WORKFLOW_DEMO_RECEIPT_CONFLICT");
    }

    const currentObjects = this.objects.get(runId) ?? [];
    const index = currentObjects.findIndex((item) => item.id === input.objectId);
    if (index < 0) throw new WorkflowDemoStoreError("演示对象不存在", "WORKFLOW_DEMO_OBJECT_NOT_FOUND", 404);
    const before = currentObjects[index]!;
    if (before.version !== input.expectedVersion) {
      throw new WorkflowDemoConflictError("演示对象版本已变化", "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT");
    }
    const after: WorkflowDemoObjectState = {
      ...before,
      ...(input.nextLabel === undefined ? {} : { label: input.nextLabel }),
      state: input.nextState,
      version: before.version + 1,
    };
    const mutation: WorkflowDemoMutationRecord = {
      mutationId: input.mutationId,
      ...(input.workflowActionId ? { workflowActionId: input.workflowActionId } : {}),
      mutationDigest: digest,
      objectId: input.objectId,
      before: clone(before),
      after: clone(after),
      receiptId: input.receiptId,
      actionDigest: input.actionDigest,
      source: "agent",
      recordedByUserId: runState.record.actorUserId,
      agentProvenance: clone(provenance),
      createdAt: new Date().toISOString(),
    };
    currentObjects[index] = after;
    currentMutations.push(mutation);
    this.objects.set(runId, currentObjects);
    this.mutations.set(runId, currentMutations);
    return { mutation: clone(mutation), replayed: false };
  }

  async mutateObjectByExternalActor(
    runId: string,
    externalActorUserId: string,
    input: WorkflowDemoMutationInput,
  ): Promise<WorkflowDemoMutationResult> {
    const runState = this.requireRunState(runId);
    requireExternalActor(runState.record, externalActorUserId);
    requireActive(runState.record);
    const digest = digestCanonical(input);
    const currentMutations = this.mutations.get(runId) ?? [];
    const existing = currentMutations.find((item) => item.mutationId === input.mutationId);
    if (existing) {
      if (existing.mutationDigest !== digest || existing.recordedByUserId !== externalActorUserId) {
        throw new WorkflowDemoConflictError("同一 mutationId 对应了不同外部动作", "WORKFLOW_DEMO_MUTATION_CONFLICT");
      }
      return { mutation: clone(existing), replayed: true };
    }
    if (currentMutations.some((item) => item.receiptId === input.receiptId)) {
      throw new WorkflowDemoConflictError("动作回执已被其他 mutation 使用", "WORKFLOW_DEMO_RECEIPT_CONFLICT");
    }
    const currentObjects = this.objects.get(runId) ?? [];
    const index = currentObjects.findIndex((item) => item.id === input.objectId);
    if (index < 0) throw new WorkflowDemoStoreError("演示对象不存在", "WORKFLOW_DEMO_OBJECT_NOT_FOUND", 404);
    const before = currentObjects[index]!;
    if (before.version !== input.expectedVersion) {
      throw new WorkflowDemoConflictError("演示对象版本已变化", "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT");
    }
    const after: WorkflowDemoObjectState = {
      ...before,
      ...(input.nextLabel === undefined ? {} : { label: input.nextLabel }),
      state: input.nextState,
      version: before.version + 1,
    };
    const mutation: WorkflowDemoMutationRecord = {
      mutationId: input.mutationId,
      ...(input.workflowActionId ? { workflowActionId: input.workflowActionId } : {}),
      mutationDigest: digest,
      objectId: input.objectId,
      before: clone(before),
      after: clone(after),
      receiptId: input.receiptId,
      actionDigest: input.actionDigest,
      source: "external",
      recordedByUserId: externalActorUserId,
      createdAt: new Date().toISOString(),
    };
    currentObjects[index] = after;
    currentMutations.push(mutation);
    this.objects.set(runId, currentObjects);
    this.mutations.set(runId, currentMutations);
    return { mutation: clone(mutation), replayed: false };
  }

  async readMutations(runId: string): Promise<WorkflowDemoMutationRecord[]> {
    this.requireRunState(runId);
    return clone(this.mutations.get(runId) ?? []);
  }

  async appendEvent(
    runId: string,
    provenance: WorkflowDemoAgentProvenance,
    event: AppendWorkflowDemoEventInput,
  ): Promise<AppendWorkflowDemoEventResult> {
    const runState = this.requireAgentRun(runId, provenance);
    requireActive(runState.record);
    assertAgentProvenance(runState.record, provenance, { eventId: event.eventId });
    const eventDigest = digestCanonical(event);
    const current = this.events.get(runId) ?? [];
    const existing = current.find((item) => item.eventId === event.eventId);
    if (existing) {
      if (existing.eventDigest !== eventDigest) {
        throw new WorkflowDemoConflictError("同一 eventId 对应了不同事件", "WORKFLOW_DEMO_EVENT_CONFLICT");
      }
      return { event: clone(existing), replayed: true };
    }
    if (current.some((item) => item.receiptId === event.receiptId)) {
      throw new WorkflowDemoConflictError("事件回执已被其他事件使用", "WORKFLOW_DEMO_RECEIPT_CONFLICT");
    }
    const record: WorkflowDemoEventRecord = {
      ...event,
      eventDigest,
      sequence: current.length + 1,
      source: "agent",
      recordedByUserId: runState.record.actorUserId,
      agentProvenance: clone(provenance),
      createdAt: new Date().toISOString(),
    };
    current.push(record);
    this.events.set(runId, current);
    return { event: clone(record), replayed: false };
  }

  async appendExternalEvent(
    runId: string,
    externalActorUserId: string,
    event: AppendWorkflowDemoEventInput,
  ): Promise<AppendWorkflowDemoEventResult> {
    if (event.agentProvenance) throw new WorkflowDemoStoreError("外部事件不得携带 Agent 来源", "WORKFLOW_DEMO_EXTERNAL_SIGNAL_INVALID", 400);
    const runState = this.requireRunState(runId);
    requireExternalActor(runState.record, externalActorUserId);
    requireActive(runState.record);
    const eventDigest = digestCanonical(event);
    const current = this.events.get(runId) ?? [];
    const existing = current.find((item) => item.eventId === event.eventId);
    if (existing) {
      if (existing.eventDigest !== eventDigest || existing.recordedByUserId !== externalActorUserId) {
        throw new WorkflowDemoConflictError("同一 eventId 对应了不同外部事件", "WORKFLOW_DEMO_EVENT_CONFLICT");
      }
      return { event: clone(existing), replayed: true };
    }
    if (current.some((item) => item.receiptId === event.receiptId)) {
      throw new WorkflowDemoConflictError("事件回执已被其他事件使用", "WORKFLOW_DEMO_RECEIPT_CONFLICT");
    }
    const record: WorkflowDemoEventRecord = {
      ...event,
      eventDigest,
      sequence: current.length + 1,
      source: "external",
      recordedByUserId: externalActorUserId,
      createdAt: new Date().toISOString(),
    };
    current.push(record);
    this.events.set(runId, current);
    return { event: clone(record), replayed: false };
  }

  async applyExternalSignal(
    input: ApplyWorkflowDemoExternalSignalInput,
  ): Promise<ApplyWorkflowDemoExternalSignalResult> {
    if (input.event.agentProvenance) throw new WorkflowDemoStoreError("外部事件不得携带 Agent 来源", "WORKFLOW_DEMO_EXTERNAL_SIGNAL_INVALID", 400);
    const runState = this.requireRunState(input.runId);
    requireExternalActor(runState.record, input.externalActorUserId);
    const currentEvents = clone(this.events.get(input.runId) ?? []);
    const byEvent = currentEvents.find((item) => item.eventId === input.event.eventId);
    const bySignal = currentEvents.find((item) => item.externalSignalId === input.signalId);
    if (byEvent || bySignal) {
      if (byEvent !== bySignal
        || byEvent?.recordedByUserId !== input.externalActorUserId
        || byEvent?.externalTransactionDigest !== input.transactionDigest) {
        throw new WorkflowDemoConflictError("外部信号已绑定其他事件或内容", "WORKFLOW_DEMO_EXTERNAL_SIGNAL_CONFLICT");
      }
      const wait = input.wait
        ? this.waits.get(stableStringify([input.runId, input.wait.waitId]))
        : undefined;
      if (input.continuation) {
        this.stageInMemoryContinuation(input, runState.record, byEvent);
      }
      return {
        run: clone(runState.record),
        event: clone(byEvent),
        mutations: clone((this.mutations.get(input.runId) ?? []).filter((item) => (
          input.mutations.some((candidate) => candidate.mutationId === item.mutationId)
        ))),
        ...(wait ? { wait: clone(wait) } : {}),
        objects: clone(this.objects.get(input.runId) ?? []),
        replayed: true,
      };
    }

    if (input.wait) {
      if (runState.record.status !== "waiting") throw terminalStateError(runState.record.status);
    } else {
      requireRunning(runState.record);
    }
    assertExternalSignalInput(input);
    const now = new Date().toISOString();
    const stagedObjects = clone(this.objects.get(input.runId) ?? []);
    const stagedMutations = clone(this.mutations.get(input.runId) ?? []);
    const stagedEvents = currentEvents;
    const stagedRun = clone(runState.record);
    let stagedWait: WorkflowDemoWaitRecord | undefined;

    if (stagedEvents.some((item) => item.receiptId === input.event.receiptId)) {
      throw new WorkflowDemoConflictError("事件回执已被其他事件使用", "WORKFLOW_DEMO_RECEIPT_CONFLICT");
    }
    const appliedMutations: WorkflowDemoMutationRecord[] = [];
    for (const mutationInput of input.mutations) {
      if (stagedMutations.some((item) => item.mutationId === mutationInput.mutationId)) {
        throw new WorkflowDemoConflictError("外部 signal 的 mutationId 已存在", "WORKFLOW_DEMO_MUTATION_CONFLICT");
      }
      if (stagedMutations.some((item) => item.receiptId === mutationInput.receiptId)) {
        throw new WorkflowDemoConflictError("动作回执已被其他 mutation 使用", "WORKFLOW_DEMO_RECEIPT_CONFLICT");
      }
      const objectIndex = stagedObjects.findIndex((item) => item.id === mutationInput.objectId);
      if (objectIndex < 0) throw new WorkflowDemoStoreError("演示对象不存在", "WORKFLOW_DEMO_OBJECT_NOT_FOUND", 404);
      const before = stagedObjects[objectIndex]!;
      if (before.version !== mutationInput.expectedVersion) {
        throw new WorkflowDemoConflictError("演示对象版本已变化", "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT");
      }
      const after: WorkflowDemoObjectState = {
        ...before,
        ...(mutationInput.nextLabel === undefined ? {} : { label: mutationInput.nextLabel }),
        state: mutationInput.nextState,
        version: before.version + 1,
      };
      const mutation: WorkflowDemoMutationRecord = {
        mutationId: mutationInput.mutationId,
        ...(mutationInput.workflowActionId ? { workflowActionId: mutationInput.workflowActionId } : {}),
        mutationDigest: digestCanonical(mutationInput),
        objectId: mutationInput.objectId,
        before,
        after,
        receiptId: mutationInput.receiptId,
        actionDigest: mutationInput.actionDigest,
        source: "external",
        recordedByUserId: input.externalActorUserId,
        createdAt: now,
      };
      stagedObjects[objectIndex] = after;
      stagedMutations.push(mutation);
      appliedMutations.push(mutation);
    }

    if (input.wait) {
      const waitKey = stableStringify([input.runId, input.wait.waitId]);
      const wait = this.waits.get(waitKey);
      if (!wait) throw new WorkflowDemoStoreError("等待点不存在", "WORKFLOW_DEMO_WAIT_NOT_FOUND", 404);
      if (wait.status !== "waiting") throw new WorkflowDemoConflictError("等待点已恢复", "WORKFLOW_DEMO_RESUME_CONFLICT");
      if (wait.resumeConditionDigest !== input.wait.expectedResumeConditionDigest) {
        throw new WorkflowDemoConflictError("外部信号与等待条件不一致", "WORKFLOW_DEMO_RESUME_CONDITION_MISMATCH");
      }
      stagedWait = {
        ...wait,
        status: "resumed",
        resumedAt: now,
        resumeEventDigest: input.signalDigest,
        resumedByUserId: input.externalActorUserId,
      };
      stagedRun.status = "running";
    }

    const eventWithSignal = {
      ...input.event,
      externalSignalId: input.signalId,
      externalTransactionDigest: input.transactionDigest,
    };
    const event: WorkflowDemoEventRecord = {
      ...eventWithSignal,
      eventDigest: digestCanonical(eventWithSignal),
      sequence: stagedEvents.length + 1,
      source: "external",
      recordedByUserId: input.externalActorUserId,
      createdAt: now,
    };
    stagedEvents.push(event);
    runState.record = stagedRun;
    this.objects.set(input.runId, stagedObjects);
    this.mutations.set(input.runId, stagedMutations);
    if (stagedWait && input.wait) this.waits.set(stableStringify([input.runId, input.wait.waitId]), stagedWait);
    this.events.set(input.runId, stagedEvents);
    if (input.continuation) {
      this.stageInMemoryContinuation(input, stagedRun, event);
    }
    return {
      run: clone(stagedRun),
      event: clone(event),
      mutations: clone(appliedMutations),
      ...(stagedWait ? { wait: clone(stagedWait) } : {}),
      objects: clone(stagedObjects),
      replayed: false,
    };
  }

  private stageInMemoryContinuation(
    input: ApplyWorkflowDemoExternalSignalInput,
    run: WorkflowDemoRunRecord,
    event: WorkflowDemoEventRecord,
  ): void {
    const continuation = input.continuation!;
    const id = workflowDemoContinuationId(input.runId, continuation.externalSignalId, continuation.nextEventId);
    const request: WorkflowDemoRuntimeContinuationRequest = {
      run: clone(run),
      externalEvent: clone(event),
      externalSignalId: continuation.externalSignalId,
      nextEventId: continuation.nextEventId,
    };
    const existing = this.continuations.get(id);
    if (existing) {
      if (existing.request.run.runId !== request.run.runId
        || existing.request.externalSignalId !== request.externalSignalId
        || existing.request.nextEventId !== request.nextEventId
        || existing.request.externalEvent.eventDigest !== request.externalEvent.eventDigest) {
        throw new WorkflowDemoConflictError("续跑任务与已冻结内容不一致", "WORKFLOW_DEMO_CONTINUATION_CONFLICT");
      }
      return;
    }
    this.continuations.set(id, { request, status: "pending", attempts: 0 });
  }

  async readEvents(runId: string): Promise<WorkflowDemoEventRecord[]> {
    this.requireRunState(runId);
    return clone(this.events.get(runId) ?? []);
  }

  async beginWait(
    runId: string,
    provenance: WorkflowDemoAgentProvenance,
    input: WorkflowDemoWaitInput,
  ): Promise<WorkflowDemoWaitRecord> {
    const runState = this.requireAgentRun(runId, provenance);
    assertAgentProvenance(runState.record, provenance, { eventId: input.waitId });
    const waitKey = stableStringify([runId, input.waitId]);
    const existing = this.waits.get(waitKey);
    if (existing) {
      if (existing.waitId !== input.waitId
        || existing.reason !== input.reason
        || existing.resumeConditionDigest !== input.resumeConditionDigest) {
        throw new WorkflowDemoConflictError("同一 waitId 已绑定其他等待条件", "WORKFLOW_DEMO_WAIT_CONFLICT");
      }
      return clone(existing);
    }
    requireRunning(runState.record);
    if ([...this.waits.values()].some((item) => item.runId === runId && item.status === "waiting")) {
      throw new WorkflowDemoConflictError("运行已有未恢复的等待点", "WORKFLOW_DEMO_WAIT_CONFLICT");
    }
    const record: WorkflowDemoWaitRecord = {
      runId,
      ...input,
      agentProvenance: clone(provenance),
      status: "waiting",
      startedAt: new Date().toISOString(),
    };
    runState.record = { ...runState.record, status: "waiting" };
    this.waits.set(waitKey, record);
    return clone(record);
  }

  async readWaits(runId: string): Promise<WorkflowDemoWaitRecord[]> {
    this.requireRunState(runId);
    return clone([...this.waits.values()]
      .filter((item) => item.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)));
  }

  async resumeRunBySignal(
    runId: string,
    externalActorUserId: string,
    waitId: string,
    resumeEventDigest: string,
  ): Promise<WorkflowDemoWaitRecord> {
    const runState = this.requireRunState(runId);
    requireExternalActor(runState.record, externalActorUserId);
    const waitKey = stableStringify([runId, waitId]);
    const wait = this.waits.get(waitKey);
    if (!wait || wait.waitId !== waitId) {
      throw new WorkflowDemoStoreError("等待点不存在", "WORKFLOW_DEMO_WAIT_NOT_FOUND", 404);
    }
    if (wait.status === "resumed") {
      if (wait.resumeEventDigest !== resumeEventDigest || wait.resumedByUserId !== externalActorUserId) {
        throw new WorkflowDemoConflictError("等待点已由其他事件恢复", "WORKFLOW_DEMO_RESUME_CONFLICT");
      }
      return clone(wait);
    }
    if (runState.record.status !== "waiting") {
      throw terminalStateError(runState.record.status);
    }
    const resumed: WorkflowDemoWaitRecord = {
      ...wait,
      status: "resumed",
      resumedAt: new Date().toISOString(),
      resumeEventDigest,
      resumedByUserId: externalActorUserId,
    };
    runState.record = { ...runState.record, status: "running" };
    this.waits.set(waitKey, resumed);
    return clone(resumed);
  }

  async completeRun(
    runId: string,
    provenance: WorkflowDemoAgentProvenance,
    replay: WorkflowDemoPublicReplay,
  ): Promise<CompleteWorkflowDemoRunResult> {
    const runState = this.requireAgentRun(runId, provenance);
    assertAgentProvenance(runState.record, provenance);
    const verifiedReplay = workflowDemoPublicReplaySchema.parse(replay);
    const contentHash = digestCanonical(verifiedReplay);
    const existingReplayId = this.runSnapshots.get(runId);
    if (existingReplayId) {
      const existing = assertSnapshotIntegrity(this.snapshots.get(existingReplayId)!);
      if (existing.contentHash !== contentHash) {
        throw new WorkflowDemoConflictError("已完成运行的回放快照不可覆盖", "WORKFLOW_DEMO_REPLAY_IMMUTABLE");
      }
      return { run: clone(runState.record), snapshot: clone(existing), replayed: true };
    }
    requireRunning(runState.record);
    if (replay.status !== "passed") {
      throw new WorkflowDemoStoreError("只有 passed 回放可以完成运行", "WORKFLOW_DEMO_INVALID_REPLAY", 400);
    }
    const snapshot: WorkflowDemoReplaySnapshot = {
      replayId: randomUUID(),
      runId,
      demoId: runState.record.demoId,
      workflowId: runState.record.workflowId,
      catalogScenarioId: runState.record.catalogScenarioId,
      definitionVersion: runState.record.definitionVersion,
      contentHash,
      replay: clone(verifiedReplay),
      createdAt: new Date().toISOString(),
    };
    runState.record = {
      ...runState.record,
      status: "passed",
      completedAt: replay.completedAt,
    };
    this.snapshots.set(snapshot.replayId, snapshot);
    this.runSnapshots.set(runId, snapshot.replayId);
    return { run: clone(runState.record), snapshot: clone(snapshot), replayed: false };
  }

  async failRun(runId: string, executionToken: string, reason: string): Promise<WorkflowDemoRunRecord> {
    const runState = this.requireAuthorizedRun(runId, executionToken);
    if (runState.record.status === "failed") {
      if (runState.record.failureReason !== reason) throw terminalStateError("failed");
      return clone(runState.record);
    }
    if (runState.record.status === "passed") throw terminalStateError("passed");
    runState.record = {
      ...runState.record,
      status: "failed",
      completedAt: new Date().toISOString(),
      failureReason: reason,
    };
    return clone(runState.record);
  }

  async getReplayByRunId(runId: string): Promise<WorkflowDemoReplaySnapshot | null> {
    const replayId = this.runSnapshots.get(runId);
    return replayId ? clone(assertSnapshotIntegrity(this.snapshots.get(replayId)!)) : null;
  }

  async reviewReplay(input: ReviewWorkflowDemoReplayInput): Promise<WorkflowDemoReplayReview> {
    const runState = this.requireRunState(input.runId);
    if (runState.record.status !== "passed") {
      throw new WorkflowDemoConflictError("只有已完成运行可以复核", "WORKFLOW_DEMO_REVIEW_NOT_READY");
    }
    if (runState.record.actorUserId === input.reviewerUserId) {
      throw new WorkflowDemoStoreError("执行者不能复核自己的演示", "WORKFLOW_DEMO_SELF_REVIEW_FORBIDDEN", 403);
    }
    const replayId = this.runSnapshots.get(input.runId);
    if (!replayId) throw new WorkflowDemoStoreError("回放快照不存在", "WORKFLOW_DEMO_REPLAY_NOT_FOUND", 404);
    const snapshot = assertSnapshotIntegrity(this.snapshots.get(replayId)!);
    if (snapshot.contentHash !== input.contentHash) {
      throw new WorkflowDemoConflictError("复核内容与冻结快照不一致", "WORKFLOW_DEMO_REVIEW_CONTENT_CONFLICT");
    }
    const existing = this.reviews.get(replayId);
    if (existing) {
      if (existing.reviewerUserId !== input.reviewerUserId
        || existing.decision !== input.decision
        || existing.contentHash !== input.contentHash) {
        throw new WorkflowDemoConflictError("复核结论已经冻结", "WORKFLOW_DEMO_REVIEW_IMMUTABLE");
      }
      return clone(existing);
    }
    const review: WorkflowDemoReplayReview = {
      replayId,
      reviewerUserId: input.reviewerUserId,
      decision: input.decision,
      contentHash: input.contentHash,
      reviewedAt: new Date().toISOString(),
    };
    this.reviews.set(replayId, review);
    return clone(review);
  }

  async publishReplay(input: PublishWorkflowDemoReplayInput): Promise<PublishWorkflowDemoReplayResult> {
    const runState = this.requireRunState(input.runId);
    if (runState.record.status !== "passed") {
      throw new WorkflowDemoConflictError("只有已完成运行可以发布", "WORKFLOW_DEMO_PUBLISH_NOT_READY");
    }
    const replayId = this.runSnapshots.get(input.runId);
    if (!replayId) throw new WorkflowDemoStoreError("回放快照不存在", "WORKFLOW_DEMO_REPLAY_NOT_FOUND", 404);
    const snapshot = assertSnapshotIntegrity(this.snapshots.get(replayId)!);
    const review = this.reviews.get(replayId);
    if (!review || review.decision !== "approved" || review.contentHash !== snapshot.contentHash) {
      throw new WorkflowDemoConflictError("回放尚未通过独立复核", "WORKFLOW_DEMO_PUBLISH_REVIEW_REQUIRED");
    }
    if (input.publisherUserId === review.reviewerUserId || input.publisherUserId === runState.record.actorUserId) {
      throw new WorkflowDemoStoreError(
        "执行、复核与发布必须由不同身份承担",
        "WORKFLOW_DEMO_PUBLISH_SEPARATION_REQUIRED",
        403,
      );
    }
    const existing = this.publications.get(replayId);
    if (existing) {
      return {
        published: this.composePublished(snapshot, review, existing.record),
        replayed: true,
      };
    }
    if (input.supersedesReplayId) {
      const superseded = this.publications.get(input.supersedesReplayId);
      if (!superseded) {
        throw new WorkflowDemoStoreError("被替代的公开回放不存在", "WORKFLOW_DEMO_SUPERSEDED_REPLAY_NOT_FOUND", 404);
      }
      if (input.supersedesReplayId === replayId) {
        throw new WorkflowDemoConflictError("回放不能替代自身", "WORKFLOW_DEMO_SUPERSEDE_CONFLICT");
      }
      const supersededSnapshot = this.snapshots.get(input.supersedesReplayId);
      if (!supersededSnapshot
        || supersededSnapshot.catalogScenarioId !== snapshot.catalogScenarioId
        || supersededSnapshot.workflowId !== snapshot.workflowId) {
        throw new WorkflowDemoConflictError("只能替代同一工作流和目录场景的公开回放", "WORKFLOW_DEMO_SUPERSEDE_SCOPE_CONFLICT");
      }
    }
    const token = createToken();
    const tokenHash = sha256(token);
    const publication: WorkflowDemoReplayPublication = {
      replayId,
      publisherUserId: input.publisherUserId,
      publishedAt: new Date().toISOString(),
      ...(input.supersedesReplayId ? { supersedesReplayId: input.supersedesReplayId } : {}),
    };
    this.publications.set(replayId, { record: publication, publicTokenHash: tokenHash });
    this.publicTokenIndex.set(tokenHash, replayId);
    return {
      published: this.composePublished(snapshot, review, publication),
      replayed: false,
      publicToken: token,
    };
  }

  async getByPublicToken(token: string): Promise<WorkflowDemoPublishedReplay | null> {
    const replayId = this.publicTokenIndex.get(sha256(token));
    if (!replayId) return null;
    return this.publishedByReplayId(replayId);
  }

  async getPublishedByReplayId(replayId: string): Promise<WorkflowDemoPublishedReplay | null> {
    return this.publishedByReplayId(replayId);
  }

  async getLatestPublishedByCatalog(catalogScenarioId: string): Promise<WorkflowDemoPublishedReplay | null> {
    const candidates = [...this.publications.values()]
      .filter((publication) => this.snapshots.get(publication.record.replayId)?.catalogScenarioId === catalogScenarioId)
      .sort((left, right) => right.record.publishedAt.localeCompare(left.record.publishedAt));
    return candidates[0] ? this.publishedByReplayId(candidates[0].record.replayId) : null;
  }

  private publishedByReplayId(replayId: string): WorkflowDemoPublishedReplay | null {
    const snapshot = this.snapshots.get(replayId);
    const review = this.reviews.get(replayId);
    const publication = this.publications.get(replayId);
    return snapshot && review && publication
      ? this.composePublished(snapshot, review, publication.record)
      : null;
  }

  private composePublished(
    snapshot: WorkflowDemoReplaySnapshot,
    review: WorkflowDemoReplayReview,
    publication: WorkflowDemoReplayPublication,
  ): WorkflowDemoPublishedReplay {
    assertPublishedIntegrity(snapshot, review);
    return clone({ snapshot, review, publication });
  }

  private requireRunState(runId: string): InMemoryRunState {
    const state = this.runs.get(runId);
    if (!state) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
    return state;
  }

  private requireAgentRun(runId: string, provenance: WorkflowDemoAgentProvenance): InMemoryRunState {
    const state = this.requireRunState(runId);
    assertAgentProvenance(state.record, provenance);
    return state;
  }

  private requireAuthorizedRun(runId: string, executionToken: string): InMemoryRunState {
    const state = this.requireRunState(runId);
    if (!safeHashEqual(state.executionTokenHash, sha256(executionToken))) {
      throw new WorkflowDemoStoreError("Workflow Demo execution token 无效", "WORKFLOW_DEMO_EXECUTION_TOKEN_INVALID", 403);
    }
    return state;
  }
}

export interface PgWorkflowDemoStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
  unboundLaunchTtlMs?: number;
  unboundLaunchSweepIntervalMs?: number;
}

export class PgWorkflowDemoStore implements WorkflowDemoStore {
  readonly pool: PgPool;
  readonly runsTable: string;
  readonly objectsTable: string;
  readonly eventsTable: string;
  readonly mutationsTable: string;
  readonly waitsTable: string;
  readonly continuationsTable: string;
  readonly replaysTable: string;
  readonly reviewsTable: string;
  readonly publicationsTable: string;
  private readonly ownsPool: boolean;
  private readonly unboundLaunchTtlMs: number;
  private readonly unboundLaunchSweepIntervalMs: number;
  private runtimeContinuationHandler?: WorkflowDemoRuntimeContinuationHandler;
  private runtimeContinuationTimer?: ReturnType<typeof setInterval>;
  private unboundLaunchSweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: PgWorkflowDemoStoreOptions) {
    if (!options.pool && !options.connectionString) throw new Error("PgWorkflowDemoStore requires pool or connectionString");
    const prefix = sanitizeIdentifier(options.tablePrefix ?? "runtime");
    this.runsTable = `${prefix}_workflow_demo_runs`;
    this.objectsTable = `${prefix}_workflow_demo_objects`;
    this.eventsTable = `${prefix}_workflow_demo_events`;
    this.mutationsTable = `${prefix}_workflow_demo_mutations`;
    this.waitsTable = `${prefix}_workflow_demo_waits`;
    this.continuationsTable = `${prefix}_workflow_demo_continuations`;
    this.replaysTable = `${prefix}_workflow_demo_replays`;
    this.reviewsTable = `${prefix}_workflow_demo_reviews`;
    this.publicationsTable = `${prefix}_workflow_demo_publications`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
    this.unboundLaunchTtlMs = positiveDuration(
      options.unboundLaunchTtlMs,
      DEFAULT_UNBOUND_LAUNCH_TTL_MS,
      "unboundLaunchTtlMs",
    );
    this.unboundLaunchSweepIntervalMs = positiveDuration(
      options.unboundLaunchSweepIntervalMs,
      DEFAULT_UNBOUND_LAUNCH_SWEEP_INTERVAL_MS,
      "unboundLaunchSweepIntervalMs",
    );
  }

  async init(): Promise<void> {
    const lockKey = `${this.runsTable}:init:v2`;
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.runsTable} (
          run_id TEXT PRIMARY KEY,
          demo_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          catalog_scenario_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          actor_user_id TEXT NOT NULL,
          runtime_session_id TEXT,
          idempotency_key_hash TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          definition_version TEXT NOT NULL,
          manifest_digest TEXT NOT NULL,
          action_digest TEXT NOT NULL,
          approval_digest TEXT,
          execution_token_hash TEXT NOT NULL,
          seed_digest TEXT,
          status TEXT NOT NULL,
          publish BOOLEAN NOT NULL DEFAULT FALSE,
          public_token TEXT UNIQUE,
          started_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ,
          failure_reason TEXT,
          replay_json JSONB,
          UNIQUE (tenant_id, actor_user_id, demo_id, idempotency_key_hash)
        )
      `);
      for (const statement of [
        `ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS request_digest TEXT`,
        `ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS definition_version TEXT`,
        `ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS manifest_digest TEXT`,
        `ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS action_digest TEXT`,
        `ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS approval_digest TEXT`,
        `ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS execution_token_hash TEXT`,
        `ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS seed_digest TEXT`,
        `ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS runtime_session_id TEXT`,
      ]) await client.query(statement);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.runsTable}_idempotency_scope_uidx ON ${this.runsTable} (tenant_id, actor_user_id, idempotency_key_hash)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.objectsTable} (
          run_id TEXT NOT NULL REFERENCES ${this.runsTable}(run_id) ON DELETE RESTRICT,
          object_id TEXT NOT NULL,
          label TEXT NOT NULL,
          state TEXT NOT NULL,
          version INTEGER NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (run_id, object_id)
        )
      `);
      await client.query(`ALTER TABLE ${this.objectsTable} ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
          run_id TEXT NOT NULL REFERENCES ${this.runsTable}(run_id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          event_digest TEXT NOT NULL,
          phase TEXT NOT NULL,
          label TEXT NOT NULL,
          summary TEXT NOT NULL,
          state TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          target_object_id TEXT NOT NULL,
          mutation BOOLEAN NOT NULL DEFAULT FALSE,
          approval_required BOOLEAN NOT NULL DEFAULT FALSE,
          idempotency_key_hash TEXT NOT NULL,
          read_back_verified BOOLEAN NOT NULL DEFAULT FALSE,
          receipt_id TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'agent',
          recorded_by_user_id TEXT NOT NULL DEFAULT 'legacy',
          cycle_id TEXT,
          observation_kind TEXT,
          observed_at TIMESTAMPTZ,
          source_snapshot_digest TEXT,
          external_signal_id TEXT,
          external_transaction_digest TEXT,
          agent_provenance JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (run_id, sequence),
          UNIQUE (run_id, event_id),
          UNIQUE (run_id, receipt_id)
        )
      `);
      for (const statement of [
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS event_digest TEXT`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'system'`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS target_object_id TEXT NOT NULL DEFAULT 'demo-object'`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS mutation BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS idempotency_key_hash TEXT NOT NULL DEFAULT 'legacy'`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS read_back_verified BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent'`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS recorded_by_user_id TEXT NOT NULL DEFAULT 'legacy'`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS cycle_id TEXT`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS observation_kind TEXT`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS source_snapshot_digest TEXT`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS external_signal_id TEXT`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS external_transaction_digest TEXT`,
        `ALTER TABLE ${this.eventsTable} ADD COLUMN IF NOT EXISTS agent_provenance JSONB`,
      ]) await client.query(statement);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.eventsTable}_external_signal_uidx ON ${this.eventsTable} (run_id, external_signal_id) WHERE external_signal_id IS NOT NULL`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.mutationsTable} (
          run_id TEXT NOT NULL REFERENCES ${this.runsTable}(run_id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL,
          mutation_id TEXT NOT NULL,
          workflow_action_id TEXT,
          mutation_digest TEXT NOT NULL,
          object_id TEXT NOT NULL,
          before_json JSONB NOT NULL,
          after_json JSONB NOT NULL,
          receipt_id TEXT NOT NULL,
          action_digest TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'agent',
          recorded_by_user_id TEXT NOT NULL DEFAULT 'legacy',
          agent_provenance JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (run_id, sequence),
          UNIQUE (run_id, mutation_id),
          UNIQUE (run_id, receipt_id)
        )
      `);
      await client.query(`ALTER TABLE ${this.mutationsTable} ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent'`);
      await client.query(`ALTER TABLE ${this.mutationsTable} ADD COLUMN IF NOT EXISTS recorded_by_user_id TEXT NOT NULL DEFAULT 'legacy'`);
      await client.query(`ALTER TABLE ${this.mutationsTable} ADD COLUMN IF NOT EXISTS workflow_action_id TEXT`);
      await client.query(`ALTER TABLE ${this.mutationsTable} ADD COLUMN IF NOT EXISTS agent_provenance JSONB`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.waitsTable} (
          run_id TEXT NOT NULL REFERENCES ${this.runsTable}(run_id) ON DELETE RESTRICT,
          wait_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          resume_condition_digest TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          resumed_at TIMESTAMPTZ,
          resume_event_digest TEXT,
          resumed_by_user_id TEXT,
          agent_provenance JSONB,
          PRIMARY KEY (run_id, wait_id)
        )
      `);
      await client.query(`ALTER TABLE ${this.waitsTable} ADD COLUMN IF NOT EXISTS agent_provenance JSONB`);
      await client.query(`ALTER TABLE ${this.waitsTable} ADD COLUMN IF NOT EXISTS resumed_by_user_id TEXT`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.continuationsTable} (
          continuation_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES ${this.runsTable}(run_id) ON DELETE RESTRICT,
          external_signal_id TEXT NOT NULL,
          next_event_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          delivered_at TIMESTAMPTZ,
          UNIQUE (run_id, external_signal_id, next_event_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.continuationsTable}_pending_idx ON ${this.continuationsTable} (created_at) WHERE status='pending'`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.replaysTable} (
          replay_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES ${this.runsTable}(run_id) ON DELETE RESTRICT,
          demo_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          catalog_scenario_id TEXT NOT NULL,
          definition_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          replay_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.reviewsTable} (
          replay_id TEXT PRIMARY KEY REFERENCES ${this.replaysTable}(replay_id) ON DELETE RESTRICT,
          reviewer_user_id TEXT NOT NULL,
          decision TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.publicationsTable} (
          replay_id TEXT PRIMARY KEY REFERENCES ${this.replaysTable}(replay_id) ON DELETE RESTRICT,
          public_token_hash TEXT NOT NULL UNIQUE,
          publisher_user_id TEXT NOT NULL,
          published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          supersedes_replay_id TEXT REFERENCES ${this.replaysTable}(replay_id) ON DELETE RESTRICT
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.replaysTable}_catalog_idx ON ${this.replaysTable} (catalog_scenario_id, created_at DESC)`);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
      client.release();
    }
    this.startUnboundLaunchReconciler();
  }

  async close(): Promise<void> {
    if (this.runtimeContinuationTimer) clearInterval(this.runtimeContinuationTimer);
    if (this.unboundLaunchSweepTimer) clearInterval(this.unboundLaunchSweepTimer);
    if (this.ownsPool) await this.pool.end();
  }

  async getOrCreateRun(input: CreateWorkflowDemoRunInput): Promise<CreateWorkflowDemoRunResult> {
    assertCreateInput(input);
    const keyHash = hashWorkflowDemoIdempotencyKey(input.idempotencyKey);
    const requestDigest = canonicalWorkflowDemoRequestDigest(input);
    const token = createToken();
    const runId = randomUUID();
    const inserted = await this.pool.query(`
      INSERT INTO ${this.runsTable}
        (run_id, demo_id, workflow_id, catalog_scenario_id, tenant_id, actor_user_id,
         idempotency_key_hash, request_digest, definition_version, manifest_digest,
         action_digest, approval_digest, execution_token_hash, status, started_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'running',now())
      ON CONFLICT (tenant_id, actor_user_id, idempotency_key_hash) DO NOTHING
      RETURNING *
    `, [
      runId, input.demoId, input.workflowId, input.catalogScenarioId, input.tenantId,
      input.actorUserId, keyHash, requestDigest, input.definitionVersion, input.manifestDigest,
      input.actionDigest, input.approvalDigest ?? null, sha256(token),
    ]);
    if (inserted.rows[0]) {
      return { run: rowToRun(inserted.rows[0]), replayed: false, executionToken: token };
    }
    const existing = await this.pool.query(`
      SELECT * FROM ${this.runsTable}
      WHERE tenant_id=$1 AND actor_user_id=$2 AND idempotency_key_hash=$3
      LIMIT 1
    `, [input.tenantId, input.actorUserId, keyHash]);
    if (!existing.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 创建冲突", "WORKFLOW_DEMO_CREATE_RACE", 503);
    const run = rowToRun(existing.rows[0]);
    if (run.requestDigest !== requestDigest) {
      throw new WorkflowDemoConflictError(
        "同一幂等键对应了不同的 Workflow Demo 请求",
        "WORKFLOW_DEMO_IDEMPOTENCY_CONFLICT",
      );
    }
    if (isRetryableUnboundLaunch(run)) {
      const retried = await this.pool.query(`
        UPDATE ${this.runsTable}
        SET status='running', started_at=now(), completed_at=NULL, failure_reason=NULL,
            execution_token_hash=$2
        WHERE run_id=$1 AND runtime_session_id IS NULL AND status='failed'
          AND failure_reason = ANY($3::text[])
        RETURNING *
      `, [run.runId, sha256(token), [...RETRYABLE_UNBOUND_LAUNCH_FAILURES]]);
      if (retried.rows[0]) {
        return { run: rowToRun(retried.rows[0]), replayed: false, executionToken: token };
      }
      const raced = await this.getByRunId(run.runId);
      if (!raced) throw new WorkflowDemoStoreError("Workflow Demo run 创建冲突", "WORKFLOW_DEMO_CREATE_RACE", 503);
      return { run: raced, replayed: true };
    }
    return { run, replayed: true };
  }

  async getByRunId(runId: string): Promise<WorkflowDemoRunRecord | null> {
    const result = await this.pool.query(`SELECT * FROM ${this.runsTable} WHERE run_id=$1 LIMIT 1`, [runId]);
    return result.rows[0] ? rowToRun(result.rows[0]) : null;
  }

  async abandonUnboundRun(
    runId: string,
    tenantId: string,
    actorUserId: string,
    reason: string,
  ): Promise<WorkflowDemoRunRecord> {
    const updated = await this.pool.query(`
      UPDATE ${this.runsTable}
      SET status='failed', failure_reason=$4, completed_at=COALESCE(completed_at,now())
      WHERE run_id=$1 AND tenant_id=$2 AND actor_user_id=$3
        AND runtime_session_id IS NULL AND status IN ('running','waiting','failed')
      RETURNING *
    `, [runId, tenantId, actorUserId, reason]);
    if (updated.rows[0]) return rowToRun(updated.rows[0]);
    const existing = await this.getByRunId(runId);
    if (!existing || existing.tenantId !== tenantId || existing.actorUserId !== actorUserId) {
      throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
    }
    if (existing.runtimeSessionId) {
      throw new WorkflowDemoConflictError("Workflow Demo 已进入 Agent Runtime，不能按启动失败回收", "WORKFLOW_DEMO_ALREADY_BOUND");
    }
    throw terminalStateError(existing.status);
  }

  async expireUnboundRuns(beforeIso: string): Promise<number> {
    const result = await this.pool.query(`
      UPDATE ${this.runsTable}
      SET status='failed', failure_reason='launch_expired_before_runtime_ack', completed_at=now()
      WHERE runtime_session_id IS NULL AND status='running' AND started_at < $1::timestamptz
    `, [beforeIso]);
    return result.rowCount ?? 0;
  }

  private startUnboundLaunchReconciler(): void {
    if (this.unboundLaunchSweepTimer) return;
    void this.reconcileUnboundLaunches();
    this.unboundLaunchSweepTimer = setInterval(() => {
      void this.reconcileUnboundLaunches();
    }, this.unboundLaunchSweepIntervalMs);
    this.unboundLaunchSweepTimer.unref?.();
  }

  private async reconcileUnboundLaunches(): Promise<void> {
    const beforeIso = new Date(Date.now() - this.unboundLaunchTtlMs).toISOString();
    await this.expireUnboundRuns(beforeIso).catch(() => undefined);
  }

  setRuntimeContinuationHandler(handler: WorkflowDemoRuntimeContinuationHandler): void {
    this.runtimeContinuationHandler = handler;
    void this.retryPendingRuntimeContinuations();
    if (!this.runtimeContinuationTimer) {
      this.runtimeContinuationTimer = setInterval(() => {
        void this.retryPendingRuntimeContinuations();
      }, 5_000);
      this.runtimeContinuationTimer.unref?.();
    }
  }

  async requestRuntimeContinuation(request: WorkflowDemoRuntimeContinuationRequest): Promise<boolean> {
    const id = workflowDemoContinuationId(request.run.runId, request.externalSignalId, request.nextEventId);
    const pending = await this.pool.query(`SELECT status FROM ${this.continuationsTable} WHERE continuation_id=$1 LIMIT 1`, [id]);
    if (!pending.rows[0]) return false;
    if (String(pending.rows[0].status) === "delivered") return true;
    if (!request.run.runtimeSessionId || !this.runtimeContinuationHandler) {
      await this.pool.query(`UPDATE ${this.continuationsTable} SET attempts=attempts+1,last_error=$2 WHERE continuation_id=$1 AND status='pending'`, [id, "runtime continuation handler/session unavailable"]);
      return false;
    }
    try {
      await this.runtimeContinuationHandler(clone(request));
      await this.pool.query(`UPDATE ${this.continuationsTable} SET status='delivered',attempts=attempts+1,last_error=NULL,delivered_at=now() WHERE continuation_id=$1 AND status='pending'`, [id]);
      return true;
    } catch (error) {
      await this.pool.query(`UPDATE ${this.continuationsTable} SET attempts=attempts+1,last_error=$2 WHERE continuation_id=$1 AND status='pending'`, [id, String(error instanceof Error ? error.message : error).slice(0, 1_000)]);
      return false;
    }
  }

  async retryPendingRuntimeContinuations(limit = 50): Promise<number> {
    const pending = await this.pool.query(`SELECT continuation_id,run_id,external_signal_id,next_event_id FROM ${this.continuationsTable} WHERE status='pending' ORDER BY created_at LIMIT $1`, [Math.max(0, limit)]);
    let delivered = 0;
    for (const row of pending.rows) {
      const run = await this.getByRunId(String(row.run_id));
      const eventResult = await this.pool.query(`SELECT * FROM ${this.eventsTable} WHERE run_id=$1 AND external_signal_id=$2 LIMIT 1`, [row.run_id, row.external_signal_id]);
      if (!run || !eventResult.rows[0]) continue;
      if (await this.requestRuntimeContinuation({
        run,
        externalEvent: rowToEvent(eventResult.rows[0]),
        externalSignalId: String(row.external_signal_id),
        nextEventId: String(row.next_event_id),
      })) delivered += 1;
    }
    return delivered;
  }

  async bindRuntimeSession(
    runId: string,
    provenance: WorkflowDemoAgentProvenance,
  ): Promise<WorkflowDemoRunRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const run = await requirePgAgentRun(client, this.runsTable, runId, provenance);
      if (run.runtimeSessionId && run.runtimeSessionId !== provenance.runtimeSessionId) {
        throw new WorkflowDemoConflictError(
          "Workflow Demo run 已绑定其他会话",
          "WORKFLOW_DEMO_SESSION_BINDING_CONFLICT",
        );
      }
      const updated = await client.query(
        `UPDATE ${this.runsTable}
         SET runtime_session_id=COALESCE(runtime_session_id,$2)
         WHERE run_id=$1 AND (runtime_session_id IS NULL OR runtime_session_id=$2)
         RETURNING *`,
        [runId, provenance.runtimeSessionId],
      );
      if (!updated.rows[0]) {
        throw new WorkflowDemoConflictError(
          "Workflow Demo run 已绑定其他会话",
          "WORKFLOW_DEMO_SESSION_BINDING_CONFLICT",
        );
      }
      await client.query("COMMIT");
      return rowToRun(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async seedObjects(runId: string, executionToken: string, objects: WorkflowDemoObjectState[]): Promise<WorkflowDemoObjectState[]> {
    assertObjects(objects);
    const canonicalObjects = clone(objects).sort((left, right) => left.id.localeCompare(right.id));
    const seedDigest = digestCanonical(canonicalObjects);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const run = await requirePgAuthorizedRun(client, this.runsTable, runId, executionToken);
      requireActive(run);
      const seed = await client.query(`SELECT seed_digest FROM ${this.runsTable} WHERE run_id=$1`, [runId]);
      const existingDigest = seed.rows[0]?.seed_digest ? String(seed.rows[0].seed_digest) : undefined;
      if (existingDigest) {
        if (existingDigest !== seedDigest) throw new WorkflowDemoConflictError("演示对象前态已冻结，不能覆盖", "WORKFLOW_DEMO_SEED_CONFLICT");
        await client.query("COMMIT");
        return this.readObjects(runId);
      }
      for (const object of canonicalObjects) {
        await client.query(`
          INSERT INTO ${this.objectsTable} (run_id, object_id, label, state, version, active, updated_at)
          VALUES ($1,$2,$3,$4,$5,TRUE,now())
          ON CONFLICT (run_id, object_id) DO NOTHING
        `, [runId, object.id, object.label, object.state, object.version]);
      }
      await client.query(`UPDATE ${this.runsTable} SET seed_digest=$2 WHERE run_id=$1 AND seed_digest IS NULL`, [runId, seedDigest]);
      await client.query("COMMIT");
      return clone(canonicalObjects);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readObjects(runId: string): Promise<WorkflowDemoObjectState[]> {
    await requirePgRunExists(this.pool, this.runsTable, runId);
    const result = await this.pool.query(`SELECT object_id, label, state, version FROM ${this.objectsTable} WHERE run_id=$1 AND active=TRUE ORDER BY object_id`, [runId]);
    return result.rows.map((row) => ({ id: String(row.object_id), label: String(row.label), state: String(row.state), version: Number(row.version) }));
  }

  async readObjectsAuthorized(runId: string, provenance: WorkflowDemoAgentProvenance): Promise<WorkflowDemoObjectState[]> {
    const client = await this.pool.connect();
    try {
      await requirePgAgentRun(client, this.runsTable, runId, provenance);
    } finally {
      client.release();
    }
    return this.readObjects(runId);
  }

  async mutateObject(runId: string, provenance: WorkflowDemoAgentProvenance, input: WorkflowDemoMutationInput): Promise<WorkflowDemoMutationResult> {
    const digest = digestCanonical(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const run = await requirePgAgentRun(client, this.runsTable, runId, provenance);
      requireRunning(run);
      assertAgentProvenance(run, provenance, { actionDigest: input.actionDigest });
      const existing = await client.query(`SELECT * FROM ${this.mutationsTable} WHERE run_id=$1 AND mutation_id=$2 LIMIT 1`, [runId, input.mutationId]);
      if (existing.rows[0]) {
        const mutation = rowToMutation(existing.rows[0]);
        if (mutation.mutationDigest !== digest) throw new WorkflowDemoConflictError("同一 mutationId 对应了不同动作", "WORKFLOW_DEMO_MUTATION_CONFLICT");
        await client.query("COMMIT");
        return { mutation, replayed: true };
      }
      const objectResult = await client.query(`SELECT object_id, label, state, version FROM ${this.objectsTable} WHERE run_id=$1 AND object_id=$2 AND active=TRUE FOR UPDATE`, [runId, input.objectId]);
      if (!objectResult.rows[0]) throw new WorkflowDemoStoreError("演示对象不存在", "WORKFLOW_DEMO_OBJECT_NOT_FOUND", 404);
      const before = rowToObject(objectResult.rows[0]);
      if (before.version !== input.expectedVersion) throw new WorkflowDemoConflictError("演示对象版本已变化", "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT");
      const after: WorkflowDemoObjectState = {
        ...before,
        ...(input.nextLabel === undefined ? {} : { label: input.nextLabel }),
        state: input.nextState,
        version: before.version + 1,
      };
      const sequenceResult = await client.query(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ${this.mutationsTable} WHERE run_id=$1`, [runId]);
      const inserted = await client.query(`
        INSERT INTO ${this.mutationsTable}
          (run_id, sequence, mutation_id, workflow_action_id, mutation_digest, object_id, before_json, after_json,
           receipt_id, action_digest, source, recorded_by_user_id,agent_provenance)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'agent',$11,$12)
        RETURNING *
      `, [runId, Number(sequenceResult.rows[0].next), input.mutationId, input.workflowActionId ?? null, digest, input.objectId, JSON.stringify(before), JSON.stringify(after), input.receiptId, input.actionDigest, run.actorUserId, JSON.stringify(provenance)]);
      await client.query(`UPDATE ${this.objectsTable} SET label=$3,state=$4,version=$5,updated_at=now() WHERE run_id=$1 AND object_id=$2 AND version=$6`, [runId, input.objectId, after.label, after.state, after.version, before.version]);
      await client.query("COMMIT");
      return { mutation: rowToMutation(inserted.rows[0]), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeUniqueConflict(error, "动作回执或 mutationId 已存在");
    } finally {
      client.release();
    }
  }

  async mutateObjectByExternalActor(
    runId: string,
    externalActorUserId: string,
    input: WorkflowDemoMutationInput,
  ): Promise<WorkflowDemoMutationResult> {
    const digest = digestCanonical(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const runResult = await client.query(`SELECT * FROM ${this.runsTable} WHERE run_id=$1 FOR UPDATE`, [runId]);
      if (!runResult.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
      const run = rowToRun(runResult.rows[0]);
      requireExternalActor(run, externalActorUserId);
      requireActive(run);
      const existing = await client.query(`SELECT * FROM ${this.mutationsTable} WHERE run_id=$1 AND mutation_id=$2 LIMIT 1`, [runId, input.mutationId]);
      if (existing.rows[0]) {
        const mutation = rowToMutation(existing.rows[0]);
        if (mutation.mutationDigest !== digest || mutation.recordedByUserId !== externalActorUserId) {
          throw new WorkflowDemoConflictError("同一 mutationId 对应了不同外部动作", "WORKFLOW_DEMO_MUTATION_CONFLICT");
        }
        await client.query("COMMIT");
        return { mutation, replayed: true };
      }
      const objectResult = await client.query(`SELECT object_id,label,state,version FROM ${this.objectsTable} WHERE run_id=$1 AND object_id=$2 AND active=TRUE FOR UPDATE`, [runId, input.objectId]);
      if (!objectResult.rows[0]) throw new WorkflowDemoStoreError("演示对象不存在", "WORKFLOW_DEMO_OBJECT_NOT_FOUND", 404);
      const before = rowToObject(objectResult.rows[0]);
      if (before.version !== input.expectedVersion) throw new WorkflowDemoConflictError("演示对象版本已变化", "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT");
      const after: WorkflowDemoObjectState = {
        ...before,
        ...(input.nextLabel === undefined ? {} : { label: input.nextLabel }),
        state: input.nextState,
        version: before.version + 1,
      };
      const sequenceResult = await client.query(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ${this.mutationsTable} WHERE run_id=$1`, [runId]);
      const inserted = await client.query(`
        INSERT INTO ${this.mutationsTable}
          (run_id,sequence,mutation_id,workflow_action_id,mutation_digest,object_id,before_json,after_json,
           receipt_id,action_digest,source,recorded_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'external',$11)
        RETURNING *
      `, [runId, Number(sequenceResult.rows[0].next), input.mutationId, input.workflowActionId ?? null, digest, input.objectId, JSON.stringify(before), JSON.stringify(after), input.receiptId, input.actionDigest, externalActorUserId]);
      await client.query(`UPDATE ${this.objectsTable} SET label=$3,state=$4,version=$5,updated_at=now() WHERE run_id=$1 AND object_id=$2 AND version=$6`, [runId, input.objectId, after.label, after.state, after.version, before.version]);
      await client.query("COMMIT");
      return { mutation: rowToMutation(inserted.rows[0]), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeUniqueConflict(error, "动作回执或 mutationId 已存在");
    } finally {
      client.release();
    }
  }

  async readMutations(runId: string): Promise<WorkflowDemoMutationRecord[]> {
    await requirePgRunExists(this.pool, this.runsTable, runId);
    const result = await this.pool.query(`SELECT * FROM ${this.mutationsTable} WHERE run_id=$1 ORDER BY sequence`, [runId]);
    return result.rows.map(rowToMutation);
  }

  async appendEvent(runId: string, provenance: WorkflowDemoAgentProvenance, event: AppendWorkflowDemoEventInput): Promise<AppendWorkflowDemoEventResult> {
    const eventDigest = digestCanonical(event);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const run = await requirePgAgentRun(client, this.runsTable, runId, provenance);
      requireActive(run);
      assertAgentProvenance(run, provenance, { eventId: event.eventId });
      const existing = await client.query(`SELECT * FROM ${this.eventsTable} WHERE run_id=$1 AND event_id=$2 LIMIT 1`, [runId, event.eventId]);
      if (existing.rows[0]) {
        const record = rowToEvent(existing.rows[0]);
        if (record.eventDigest !== eventDigest) throw new WorkflowDemoConflictError("同一 eventId 对应了不同事件", "WORKFLOW_DEMO_EVENT_CONFLICT");
        await client.query("COMMIT");
        return { event: record, replayed: true };
      }
      const sequenceResult = await client.query(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ${this.eventsTable} WHERE run_id=$1`, [runId]);
      const result = await client.query(`
        INSERT INTO ${this.eventsTable}
          (run_id, sequence, event_id, event_digest, phase, label, summary, state, actor_role,
           target_object_id, mutation, approval_required, idempotency_key_hash, read_back_verified,
           receipt_id, source, recorded_by_user_id, cycle_id, observation_kind, observed_at, source_snapshot_digest,agent_provenance)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'agent',$16,$17,$18,$19,$20,$21)
        RETURNING *
      `, [runId, Number(sequenceResult.rows[0].next), event.eventId, eventDigest, event.phase, event.label, event.summary, event.state, event.actorRole, event.targetObjectId, event.mutation, event.approvalRequired, event.idempotencyKeyHash, event.readBackVerified, event.receiptId, run.actorUserId, event.cycleId ?? null, event.observationKind ?? null, event.observedAt ?? null, event.sourceSnapshotDigest ?? null, JSON.stringify(provenance)]);
      await client.query("COMMIT");
      return { event: rowToEvent(result.rows[0]), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeUniqueConflict(error, "事件回执或 eventId 已存在");
    } finally {
      client.release();
    }
  }

  async appendExternalEvent(
    runId: string,
    externalActorUserId: string,
    event: AppendWorkflowDemoEventInput,
  ): Promise<AppendWorkflowDemoEventResult> {
    if (event.agentProvenance) throw new WorkflowDemoStoreError("外部事件不得携带 Agent 来源", "WORKFLOW_DEMO_EXTERNAL_SIGNAL_INVALID", 400);
    const eventDigest = digestCanonical(event);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const runResult = await client.query(`SELECT * FROM ${this.runsTable} WHERE run_id=$1 FOR UPDATE`, [runId]);
      if (!runResult.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
      const run = rowToRun(runResult.rows[0]);
      requireExternalActor(run, externalActorUserId);
      requireActive(run);
      const existing = await client.query(`SELECT * FROM ${this.eventsTable} WHERE run_id=$1 AND event_id=$2 LIMIT 1`, [runId, event.eventId]);
      if (existing.rows[0]) {
        const record = rowToEvent(existing.rows[0]);
        if (record.eventDigest !== eventDigest || record.recordedByUserId !== externalActorUserId) {
          throw new WorkflowDemoConflictError("同一 eventId 对应了不同外部事件", "WORKFLOW_DEMO_EVENT_CONFLICT");
        }
        await client.query("COMMIT");
        return { event: record, replayed: true };
      }
      const sequenceResult = await client.query(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ${this.eventsTable} WHERE run_id=$1`, [runId]);
      const result = await client.query(`
        INSERT INTO ${this.eventsTable}
          (run_id, sequence, event_id, event_digest, phase, label, summary, state, actor_role,
           target_object_id, mutation, approval_required, idempotency_key_hash, read_back_verified,
           receipt_id, source, recorded_by_user_id, cycle_id, observation_kind, observed_at, source_snapshot_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'external',$16,$17,$18,$19,$20)
        RETURNING *
      `, [runId, Number(sequenceResult.rows[0].next), event.eventId, eventDigest, event.phase, event.label, event.summary, event.state, event.actorRole, event.targetObjectId, event.mutation, event.approvalRequired, event.idempotencyKeyHash, event.readBackVerified, event.receiptId, externalActorUserId, event.cycleId ?? null, event.observationKind ?? null, event.observedAt ?? null, event.sourceSnapshotDigest ?? null]);
      await client.query("COMMIT");
      return { event: rowToEvent(result.rows[0]), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeUniqueConflict(error, "事件回执或 eventId 已存在");
    } finally {
      client.release();
    }
  }

  async applyExternalSignal(
    input: ApplyWorkflowDemoExternalSignalInput,
  ): Promise<ApplyWorkflowDemoExternalSignalResult> {
    if (input.event.agentProvenance) throw new WorkflowDemoStoreError("外部事件不得携带 Agent 来源", "WORKFLOW_DEMO_EXTERNAL_SIGNAL_INVALID", 400);
    assertExternalSignalInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, input.runId);
      const runResult = await client.query(`SELECT * FROM ${this.runsTable} WHERE run_id=$1 FOR UPDATE`, [input.runId]);
      if (!runResult.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
      let run = rowToRun(runResult.rows[0]);
      requireExternalActor(run, input.externalActorUserId);

      const byEventResult = await client.query(`SELECT * FROM ${this.eventsTable} WHERE run_id=$1 AND event_id=$2 LIMIT 1`, [input.runId, input.event.eventId]);
      const bySignalResult = await client.query(`SELECT * FROM ${this.eventsTable} WHERE run_id=$1 AND external_signal_id=$2 LIMIT 1`, [input.runId, input.signalId]);
      const byEvent = byEventResult.rows[0] ? rowToEvent(byEventResult.rows[0]) : undefined;
      const bySignal = bySignalResult.rows[0] ? rowToEvent(bySignalResult.rows[0]) : undefined;
      if (byEvent || bySignal) {
        if (!byEvent || !bySignal
          || byEvent.eventId !== bySignal.eventId
          || byEvent.recordedByUserId !== input.externalActorUserId
          || byEvent.externalTransactionDigest !== input.transactionDigest) {
          throw new WorkflowDemoConflictError("外部信号已绑定其他事件或内容", "WORKFLOW_DEMO_EXTERNAL_SIGNAL_CONFLICT");
        }
        const mutationIds = input.mutations.map((item) => item.mutationId);
        const mutationResult = mutationIds.length > 0
          ? await client.query(`SELECT * FROM ${this.mutationsTable} WHERE run_id=$1 AND mutation_id = ANY($2::text[]) ORDER BY sequence`, [input.runId, mutationIds])
          : { rows: [] };
        const waitResult = input.wait
          ? await client.query(`SELECT * FROM ${this.waitsTable} WHERE run_id=$1 AND wait_id=$2 LIMIT 1`, [input.runId, input.wait.waitId])
          : { rows: [] };
        const objects = await client.query(`SELECT object_id,label,state,version FROM ${this.objectsTable} WHERE run_id=$1 AND active=TRUE ORDER BY object_id`, [input.runId]);
        await this.insertPgContinuation(client, input);
        await client.query("COMMIT");
        return {
          run,
          event: byEvent,
          mutations: mutationResult.rows.map(rowToMutation),
          ...(waitResult.rows[0] ? { wait: rowToWait(waitResult.rows[0]) } : {}),
          objects: objects.rows.map(rowToObject),
          replayed: true,
        };
      }

      if (input.wait) {
        if (run.status !== "waiting") throw terminalStateError(run.status);
      } else {
        requireRunning(run);
      }
      const existingEventReceipt = await client.query(`SELECT event_id FROM ${this.eventsTable} WHERE run_id=$1 AND receipt_id=$2 LIMIT 1`, [input.runId, input.event.receiptId]);
      if (existingEventReceipt.rows[0]) throw new WorkflowDemoConflictError("事件回执已被其他事件使用", "WORKFLOW_DEMO_RECEIPT_CONFLICT");

      const objectIds = input.mutations.map((item) => item.objectId);
      const objectResult = objectIds.length > 0
        ? await client.query(`SELECT object_id,label,state,version FROM ${this.objectsTable} WHERE run_id=$1 AND active=TRUE AND object_id = ANY($2::text[]) ORDER BY object_id FOR UPDATE`, [input.runId, objectIds])
        : { rows: [] };
      const objectById = new Map(objectResult.rows.map((row) => {
        const object = rowToObject(row);
        return [object.id, object] as const;
      }));
      if (objectById.size !== objectIds.length) throw new WorkflowDemoStoreError("外部信号目标对象不存在", "WORKFLOW_DEMO_OBJECT_NOT_FOUND", 404);

      const mutationIds = input.mutations.map((item) => item.mutationId);
      const mutationReceipts = input.mutations.map((item) => item.receiptId);
      if (mutationIds.length > 0) {
        const conflicts = await client.query(`SELECT mutation_id,receipt_id FROM ${this.mutationsTable} WHERE run_id=$1 AND (mutation_id = ANY($2::text[]) OR receipt_id = ANY($3::text[])) LIMIT 1`, [input.runId, mutationIds, mutationReceipts]);
        if (conflicts.rows[0]) throw new WorkflowDemoConflictError("外部 signal 的动作或回执已存在", "WORKFLOW_DEMO_MUTATION_CONFLICT");
      }

      let wait: WorkflowDemoWaitRecord | undefined;
      if (input.wait) {
        const waitResult = await client.query(`SELECT * FROM ${this.waitsTable} WHERE run_id=$1 AND wait_id=$2 FOR UPDATE`, [input.runId, input.wait.waitId]);
        if (!waitResult.rows[0]) throw new WorkflowDemoStoreError("等待点不存在", "WORKFLOW_DEMO_WAIT_NOT_FOUND", 404);
        wait = rowToWait(waitResult.rows[0]);
        if (wait.status !== "waiting") throw new WorkflowDemoConflictError("等待点已恢复", "WORKFLOW_DEMO_RESUME_CONFLICT");
        if (wait.resumeConditionDigest !== input.wait.expectedResumeConditionDigest) {
          throw new WorkflowDemoConflictError("外部信号与等待条件不一致", "WORKFLOW_DEMO_RESUME_CONDITION_MISMATCH");
        }
      }

      const appliedMutations: WorkflowDemoMutationRecord[] = [];
      for (const mutationInput of input.mutations) {
        const before = objectById.get(mutationInput.objectId)!;
        if (before.version !== mutationInput.expectedVersion) {
          throw new WorkflowDemoConflictError("演示对象版本已变化", "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT");
        }
        const after: WorkflowDemoObjectState = {
          ...before,
          ...(mutationInput.nextLabel === undefined ? {} : { label: mutationInput.nextLabel }),
          state: mutationInput.nextState,
          version: before.version + 1,
        };
        const sequenceResult = await client.query(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ${this.mutationsTable} WHERE run_id=$1`, [input.runId]);
        const inserted = await client.query(`
          INSERT INTO ${this.mutationsTable}
            (run_id,sequence,mutation_id,workflow_action_id,mutation_digest,object_id,before_json,after_json,
             receipt_id,action_digest,source,recorded_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'external',$11)
          RETURNING *
        `, [input.runId, Number(sequenceResult.rows[0].next), mutationInput.mutationId, mutationInput.workflowActionId ?? null, digestCanonical(mutationInput), mutationInput.objectId, JSON.stringify(before), JSON.stringify(after), mutationInput.receiptId, mutationInput.actionDigest, input.externalActorUserId]);
        const updated = await client.query(`UPDATE ${this.objectsTable} SET label=$3,state=$4,version=$5,updated_at=now() WHERE run_id=$1 AND object_id=$2 AND version=$6 RETURNING object_id`, [input.runId, mutationInput.objectId, after.label, after.state, after.version, before.version]);
        if (!updated.rows[0]) throw new WorkflowDemoConflictError("演示对象版本已变化", "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT");
        objectById.set(after.id, after);
        appliedMutations.push(rowToMutation(inserted.rows[0]));
      }

      const readBack = objectIds.length > 0
        ? await client.query(`SELECT object_id,label,state,version FROM ${this.objectsTable} WHERE run_id=$1 AND object_id = ANY($2::text[]) ORDER BY object_id`, [input.runId, objectIds])
        : { rows: [] };
      const readBackById = new Map(readBack.rows.map((row) => {
        const object = rowToObject(row);
        return [object.id, object] as const;
      }));
      for (const mutationInput of input.mutations) {
        const object = readBackById.get(mutationInput.objectId);
        if (!object || object.state !== mutationInput.nextState || object.version !== mutationInput.expectedVersion + 1) {
          throw new WorkflowDemoConflictError("外部动作回读未命中预期状态", "WORKFLOW_DEMO_EXTERNAL_READBACK_FAILED");
        }
      }

      if (input.wait) {
        const updatedWait = await client.query(`UPDATE ${this.waitsTable} SET status='resumed',resumed_at=now(),resume_event_digest=$3,resumed_by_user_id=$4 WHERE run_id=$1 AND wait_id=$2 AND status='waiting' RETURNING *`, [input.runId, input.wait.waitId, input.signalDigest, input.externalActorUserId]);
        if (!updatedWait.rows[0]) throw new WorkflowDemoConflictError("等待点已恢复", "WORKFLOW_DEMO_RESUME_CONFLICT");
        wait = rowToWait(updatedWait.rows[0]);
        const updatedRun = await client.query(`UPDATE ${this.runsTable} SET status='running' WHERE run_id=$1 AND status='waiting' RETURNING *`, [input.runId]);
        if (!updatedRun.rows[0]) throw terminalStateError(run.status);
        run = rowToRun(updatedRun.rows[0]);
      }

      const eventWithSignal = {
        ...input.event,
        externalSignalId: input.signalId,
        externalTransactionDigest: input.transactionDigest,
      };
      const sequenceResult = await client.query(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ${this.eventsTable} WHERE run_id=$1`, [input.runId]);
      const insertedEvent = await client.query(`
        INSERT INTO ${this.eventsTable}
          (run_id,sequence,event_id,event_digest,phase,label,summary,state,actor_role,target_object_id,
           mutation,approval_required,idempotency_key_hash,read_back_verified,receipt_id,source,recorded_by_user_id,
           cycle_id,observation_kind,observed_at,source_snapshot_digest,external_signal_id,external_transaction_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'external',$16,$17,$18,$19,$20,$21,$22)
        RETURNING *
      `, [input.runId, Number(sequenceResult.rows[0].next), input.event.eventId, digestCanonical(eventWithSignal), input.event.phase, input.event.label, input.event.summary, input.event.state, input.event.actorRole, input.event.targetObjectId, input.event.mutation, input.event.approvalRequired, input.event.idempotencyKeyHash, input.event.readBackVerified, input.event.receiptId, input.externalActorUserId, input.event.cycleId ?? null, input.event.observationKind ?? null, input.event.observedAt ?? null, input.event.sourceSnapshotDigest ?? null, input.signalId, input.transactionDigest]);
      await this.insertPgContinuation(client, input);
      const allObjects = await client.query(`SELECT object_id,label,state,version FROM ${this.objectsTable} WHERE run_id=$1 AND active=TRUE ORDER BY object_id`, [input.runId]);
      await client.query("COMMIT");
      return {
        run,
        event: rowToEvent(insertedEvent.rows[0]),
        mutations: appliedMutations,
        ...(wait ? { wait } : {}),
        objects: allObjects.rows.map(rowToObject),
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeUniqueConflict(error, "外部信号已被消费");
    } finally {
      client.release();
    }
  }

  private async insertPgContinuation(
    client: PoolClient,
    input: ApplyWorkflowDemoExternalSignalInput,
  ): Promise<void> {
    if (!input.continuation) return;
    const continuation = input.continuation;
    const id = workflowDemoContinuationId(input.runId, continuation.externalSignalId, continuation.nextEventId);
    await client.query(`
      INSERT INTO ${this.continuationsTable}
        (continuation_id,run_id,external_signal_id,next_event_id,status,attempts)
      VALUES ($1,$2,$3,$4,'pending',0)
      ON CONFLICT (continuation_id) DO NOTHING
    `, [id, input.runId, continuation.externalSignalId, continuation.nextEventId]);
    const frozen = await client.query(`SELECT run_id,external_signal_id,next_event_id FROM ${this.continuationsTable} WHERE continuation_id=$1 LIMIT 1`, [id]);
    if (!frozen.rows[0]
      || String(frozen.rows[0].run_id) !== input.runId
      || String(frozen.rows[0].external_signal_id) !== continuation.externalSignalId
      || String(frozen.rows[0].next_event_id) !== continuation.nextEventId) {
      throw new WorkflowDemoConflictError("续跑任务与已冻结内容不一致", "WORKFLOW_DEMO_CONTINUATION_CONFLICT");
    }
  }

  async readEvents(runId: string): Promise<WorkflowDemoEventRecord[]> {
    await requirePgRunExists(this.pool, this.runsTable, runId);
    const result = await this.pool.query(`SELECT * FROM ${this.eventsTable} WHERE run_id=$1 ORDER BY sequence`, [runId]);
    return result.rows.map(rowToEvent);
  }

  async beginWait(runId: string, provenance: WorkflowDemoAgentProvenance, input: WorkflowDemoWaitInput): Promise<WorkflowDemoWaitRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const run = await requirePgAgentRun(client, this.runsTable, runId, provenance);
      assertAgentProvenance(run, provenance, { eventId: input.waitId });
      const existing = await client.query(`SELECT * FROM ${this.waitsTable} WHERE run_id=$1 AND wait_id=$2 LIMIT 1`, [runId, input.waitId]);
      if (existing.rows[0]) {
        const wait = rowToWait(existing.rows[0]);
        if (wait.waitId !== input.waitId || wait.reason !== input.reason || wait.resumeConditionDigest !== input.resumeConditionDigest) {
          throw new WorkflowDemoConflictError("同一 waitId 已绑定其他等待条件", "WORKFLOW_DEMO_WAIT_CONFLICT");
        }
        await client.query("COMMIT");
        return wait;
      }
      requireRunning(run);
      const activeWait = await client.query(`SELECT wait_id FROM ${this.waitsTable} WHERE run_id=$1 AND status='waiting' LIMIT 1`, [runId]);
      if (activeWait.rows[0]) throw new WorkflowDemoConflictError("运行已有未恢复的等待点", "WORKFLOW_DEMO_WAIT_CONFLICT");
      const inserted = await client.query(`INSERT INTO ${this.waitsTable} (run_id,wait_id,reason,resume_condition_digest,status,agent_provenance) VALUES ($1,$2,$3,$4,'waiting',$5) RETURNING *`, [runId, input.waitId, input.reason, input.resumeConditionDigest, JSON.stringify(provenance)]);
      const transitioned = await client.query(`UPDATE ${this.runsTable} SET status='waiting' WHERE run_id=$1 AND status='running' RETURNING run_id`, [runId]);
      if (!transitioned.rows[0]) throw terminalStateError(run.status);
      await client.query("COMMIT");
      return rowToWait(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readWaits(runId: string): Promise<WorkflowDemoWaitRecord[]> {
    await requirePgRunExists(this.pool, this.runsTable, runId);
    const result = await this.pool.query(`SELECT * FROM ${this.waitsTable} WHERE run_id=$1 ORDER BY started_at,wait_id`, [runId]);
    return result.rows.map(rowToWait);
  }

  async resumeRunBySignal(runId: string, externalActorUserId: string, waitId: string, resumeEventDigest: string): Promise<WorkflowDemoWaitRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const runResult = await client.query(`SELECT * FROM ${this.runsTable} WHERE run_id=$1 FOR UPDATE`, [runId]);
      if (!runResult.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
      const run = rowToRun(runResult.rows[0]);
      requireExternalActor(run, externalActorUserId);
      const result = await client.query(`SELECT * FROM ${this.waitsTable} WHERE run_id=$1 AND wait_id=$2 FOR UPDATE`, [runId, waitId]);
      if (!result.rows[0]) throw new WorkflowDemoStoreError("等待点不存在", "WORKFLOW_DEMO_WAIT_NOT_FOUND", 404);
      const wait = rowToWait(result.rows[0]);
      if (wait.status === "resumed") {
        if (wait.resumeEventDigest !== resumeEventDigest || wait.resumedByUserId !== externalActorUserId) throw new WorkflowDemoConflictError("等待点已由其他事件恢复", "WORKFLOW_DEMO_RESUME_CONFLICT");
        await client.query("COMMIT");
        return wait;
      }
      if (run.status !== "waiting") throw terminalStateError(run.status);
      const updated = await client.query(`UPDATE ${this.waitsTable} SET status='resumed',resumed_at=now(),resume_event_digest=$3,resumed_by_user_id=$4 WHERE run_id=$1 AND wait_id=$2 AND status='waiting' RETURNING *`, [runId, waitId, resumeEventDigest, externalActorUserId]);
      await client.query(`UPDATE ${this.runsTable} SET status='running' WHERE run_id=$1 AND status='waiting'`, [runId]);
      await client.query("COMMIT");
      return rowToWait(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRun(runId: string, provenance: WorkflowDemoAgentProvenance, replay: WorkflowDemoPublicReplay): Promise<CompleteWorkflowDemoRunResult> {
    const verifiedReplay = workflowDemoPublicReplaySchema.parse(replay);
    const contentHash = digestCanonical(verifiedReplay);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const run = await requirePgAgentRun(client, this.runsTable, runId, provenance);
      assertAgentProvenance(run, provenance);
      const existingResult = await client.query(`SELECT * FROM ${this.replaysTable} WHERE run_id=$1 LIMIT 1`, [runId]);
      if (existingResult.rows[0]) {
        const snapshot = rowToSnapshot(existingResult.rows[0]);
        if (snapshot.contentHash !== contentHash) throw new WorkflowDemoConflictError("已完成运行的回放快照不可覆盖", "WORKFLOW_DEMO_REPLAY_IMMUTABLE");
        await client.query("COMMIT");
        return { run, snapshot, replayed: true };
      }
      requireRunning(run);
      if (replay.status !== "passed") throw new WorkflowDemoStoreError("只有 passed 回放可以完成运行", "WORKFLOW_DEMO_INVALID_REPLAY", 400);
      const replayId = randomUUID();
      const inserted = await client.query(`
        INSERT INTO ${this.replaysTable}
          (replay_id,run_id,demo_id,workflow_id,catalog_scenario_id,definition_version,content_hash,replay_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
      `, [replayId, runId, run.demoId, run.workflowId, run.catalogScenarioId, run.definitionVersion, contentHash, JSON.stringify(verifiedReplay)]);
      const transitioned = await client.query(`UPDATE ${this.runsTable} SET status='passed',completed_at=$2,failure_reason=NULL WHERE run_id=$1 AND status='running' RETURNING *`, [runId, replay.completedAt]);
      if (!transitioned.rows[0]) throw terminalStateError(run.status);
      await client.query("COMMIT");
      return { run: rowToRun(transitioned.rows[0]), snapshot: rowToSnapshot(inserted.rows[0]), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async failRun(runId: string, executionToken: string, reason: string): Promise<WorkflowDemoRunRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, runId);
      const run = await requirePgAuthorizedRun(client, this.runsTable, runId, executionToken);
      if (run.status === "failed") {
        if (run.failureReason !== reason) throw terminalStateError("failed");
        await client.query("COMMIT");
        return run;
      }
      if (run.status === "passed") throw terminalStateError("passed");
      const result = await client.query(`UPDATE ${this.runsTable} SET status='failed',completed_at=now(),failure_reason=$2 WHERE run_id=$1 AND status IN ('running','waiting') RETURNING *`, [runId, reason]);
      if (!result.rows[0]) throw terminalStateError(run.status);
      await client.query("COMMIT");
      return rowToRun(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getReplayByRunId(runId: string): Promise<WorkflowDemoReplaySnapshot | null> {
    const result = await this.pool.query(`SELECT * FROM ${this.replaysTable} WHERE run_id=$1 LIMIT 1`, [runId]);
    return result.rows[0] ? rowToSnapshot(result.rows[0]) : null;
  }

  async reviewReplay(input: ReviewWorkflowDemoReplayInput): Promise<WorkflowDemoReplayReview> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, input.runId);
      const runResult = await client.query(`SELECT * FROM ${this.runsTable} WHERE run_id=$1 LIMIT 1`, [input.runId]);
      if (!runResult.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
      const run = rowToRun(runResult.rows[0]);
      if (run.status !== "passed") throw new WorkflowDemoConflictError("只有已完成运行可以复核", "WORKFLOW_DEMO_REVIEW_NOT_READY");
      if (run.actorUserId === input.reviewerUserId) throw new WorkflowDemoStoreError("执行者不能复核自己的演示", "WORKFLOW_DEMO_SELF_REVIEW_FORBIDDEN", 403);
      const replayResult = await client.query(`SELECT * FROM ${this.replaysTable} WHERE run_id=$1 LIMIT 1`, [input.runId]);
      if (!replayResult.rows[0]) throw new WorkflowDemoStoreError("回放快照不存在", "WORKFLOW_DEMO_REPLAY_NOT_FOUND", 404);
      const snapshot = rowToSnapshot(replayResult.rows[0]);
      if (snapshot.contentHash !== input.contentHash) throw new WorkflowDemoConflictError("复核内容与冻结快照不一致", "WORKFLOW_DEMO_REVIEW_CONTENT_CONFLICT");
      const existing = await client.query(`SELECT * FROM ${this.reviewsTable} WHERE replay_id=$1 LIMIT 1`, [snapshot.replayId]);
      if (existing.rows[0]) {
        const review = rowToReview(existing.rows[0]);
        if (review.reviewerUserId !== input.reviewerUserId || review.decision !== input.decision || review.contentHash !== input.contentHash) {
          throw new WorkflowDemoConflictError("复核结论已经冻结", "WORKFLOW_DEMO_REVIEW_IMMUTABLE");
        }
        await client.query("COMMIT");
        return review;
      }
      const inserted = await client.query(`INSERT INTO ${this.reviewsTable} (replay_id,reviewer_user_id,decision,content_hash) VALUES ($1,$2,$3,$4) RETURNING *`, [snapshot.replayId, input.reviewerUserId, input.decision, input.contentHash]);
      await client.query("COMMIT");
      return rowToReview(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async publishReplay(input: PublishWorkflowDemoReplayInput): Promise<PublishWorkflowDemoReplayResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRun(client, input.runId);
      const runResult = await client.query(`SELECT * FROM ${this.runsTable} WHERE run_id=$1 LIMIT 1`, [input.runId]);
      if (!runResult.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
      const run = rowToRun(runResult.rows[0]);
      const snapshotResult = await client.query(`SELECT * FROM ${this.replaysTable} WHERE run_id=$1 LIMIT 1`, [input.runId]);
      if (!snapshotResult.rows[0]) throw new WorkflowDemoStoreError("回放快照不存在", "WORKFLOW_DEMO_REPLAY_NOT_FOUND", 404);
      const snapshot = rowToSnapshot(snapshotResult.rows[0]);
      const reviewResult = await client.query(`SELECT * FROM ${this.reviewsTable} WHERE replay_id=$1 LIMIT 1`, [snapshot.replayId]);
      if (!reviewResult.rows[0]) throw new WorkflowDemoConflictError("回放尚未通过独立复核", "WORKFLOW_DEMO_PUBLISH_REVIEW_REQUIRED");
      const review = rowToReview(reviewResult.rows[0]);
      if (review.decision !== "approved" || review.contentHash !== snapshot.contentHash) throw new WorkflowDemoConflictError("回放尚未通过独立复核", "WORKFLOW_DEMO_PUBLISH_REVIEW_REQUIRED");
      if (input.publisherUserId === review.reviewerUserId || input.publisherUserId === run.actorUserId) {
        throw new WorkflowDemoStoreError("执行、复核与发布必须由不同身份承担", "WORKFLOW_DEMO_PUBLISH_SEPARATION_REQUIRED", 403);
      }
      const existing = await client.query(`SELECT * FROM ${this.publicationsTable} WHERE replay_id=$1 LIMIT 1`, [snapshot.replayId]);
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { published: { snapshot, review, publication: rowToPublication(existing.rows[0]) }, replayed: true };
      }
      if (input.supersedesReplayId) {
        const superseded = await client.query(`
          SELECT p.replay_id,r.catalog_scenario_id,r.workflow_id
          FROM ${this.publicationsTable} p
          JOIN ${this.replaysTable} r ON r.replay_id=p.replay_id
          WHERE p.replay_id=$1 LIMIT 1
        `, [input.supersedesReplayId]);
        if (!superseded.rows[0]) throw new WorkflowDemoStoreError("被替代的公开回放不存在", "WORKFLOW_DEMO_SUPERSEDED_REPLAY_NOT_FOUND", 404);
        if (input.supersedesReplayId === snapshot.replayId) throw new WorkflowDemoConflictError("回放不能替代自身", "WORKFLOW_DEMO_SUPERSEDE_CONFLICT");
        if (String(superseded.rows[0].catalog_scenario_id) !== snapshot.catalogScenarioId
          || String(superseded.rows[0].workflow_id) !== snapshot.workflowId) {
          throw new WorkflowDemoConflictError("只能替代同一工作流和目录场景的公开回放", "WORKFLOW_DEMO_SUPERSEDE_SCOPE_CONFLICT");
        }
      }
      const token = createToken();
      const inserted = await client.query(`INSERT INTO ${this.publicationsTable} (replay_id,public_token_hash,publisher_user_id,supersedes_replay_id) VALUES ($1,$2,$3,$4) RETURNING *`, [snapshot.replayId, sha256(token), input.publisherUserId, input.supersedesReplayId ?? null]);
      await client.query("COMMIT");
      return {
        published: { snapshot, review, publication: rowToPublication(inserted.rows[0]) },
        replayed: false,
        publicToken: token,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeUniqueConflict(error, "公开 token 或回放已存在");
    } finally {
      client.release();
    }
  }

  async getByPublicToken(token: string): Promise<WorkflowDemoPublishedReplay | null> {
    const result = await this.pool.query(`
      SELECT r.*, rv.reviewer_user_id, rv.decision, rv.content_hash AS review_content_hash,
        rv.reviewed_at, p.publisher_user_id, p.published_at, p.supersedes_replay_id
      FROM ${this.publicationsTable} p
      JOIN ${this.replaysTable} r ON r.replay_id=p.replay_id
      JOIN ${this.reviewsTable} rv ON rv.replay_id=r.replay_id
      WHERE p.public_token_hash=$1 LIMIT 1
    `, [sha256(token)]);
    return result.rows[0] ? rowToPublished(result.rows[0]) : null;
  }

  async getPublishedByReplayId(replayId: string): Promise<WorkflowDemoPublishedReplay | null> {
    const result = await this.pool.query(`
      SELECT r.*, rv.reviewer_user_id, rv.decision, rv.content_hash AS review_content_hash,
        rv.reviewed_at, p.publisher_user_id, p.published_at, p.supersedes_replay_id
      FROM ${this.publicationsTable} p
      JOIN ${this.replaysTable} r ON r.replay_id=p.replay_id
      JOIN ${this.reviewsTable} rv ON rv.replay_id=r.replay_id
      WHERE r.replay_id=$1 LIMIT 1
    `, [replayId]);
    return result.rows[0] ? rowToPublished(result.rows[0]) : null;
  }

  async getLatestPublishedByCatalog(catalogScenarioId: string): Promise<WorkflowDemoPublishedReplay | null> {
    const result = await this.pool.query(`
      SELECT r.*, rv.reviewer_user_id, rv.decision, rv.content_hash AS review_content_hash,
        rv.reviewed_at, p.publisher_user_id, p.published_at, p.supersedes_replay_id
      FROM ${this.publicationsTable} p
      JOIN ${this.replaysTable} r ON r.replay_id=p.replay_id
      JOIN ${this.reviewsTable} rv ON rv.replay_id=r.replay_id
      WHERE r.catalog_scenario_id=$1
      ORDER BY p.published_at DESC LIMIT 1
    `, [catalogScenarioId]);
    return result.rows[0] ? rowToPublished(result.rows[0]) : null;
  }
}

function rowToRun(row: Record<string, unknown>): WorkflowDemoRunRecord {
  return {
    runId: String(row.run_id),
    demoId: String(row.demo_id),
    workflowId: String(row.workflow_id),
    catalogScenarioId: String(row.catalog_scenario_id),
    tenantId: String(row.tenant_id),
    actorUserId: String(row.actor_user_id),
    ...(row.runtime_session_id ? { runtimeSessionId: String(row.runtime_session_id) } : {}),
    idempotencyKeyHash: String(row.idempotency_key_hash),
    requestDigest: String(row.request_digest ?? "legacy"),
    definitionVersion: String(row.definition_version ?? "legacy"),
    manifestDigest: String(row.manifest_digest ?? "legacy"),
    actionDigest: String(row.action_digest ?? "legacy"),
    ...(row.approval_digest ? { approvalDigest: String(row.approval_digest) } : {}),
    status: String(row.status) as WorkflowDemoRunStatus,
    startedAt: toIso(row.started_at),
    ...(row.completed_at ? { completedAt: toIso(row.completed_at) } : {}),
    ...(row.failure_reason ? { failureReason: String(row.failure_reason) } : {}),
  };
}

function rowToObject(row: Record<string, unknown>): WorkflowDemoObjectState {
  return { id: String(row.object_id), label: String(row.label), state: String(row.state), version: Number(row.version) };
}

function rowToEvent(row: Record<string, unknown>): WorkflowDemoEventRecord {
  return {
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    eventDigest: String(row.event_digest ?? "legacy"),
    phase: String(row.phase) as WorkflowDemoEventPhase,
    label: String(row.label),
    summary: String(row.summary),
    state: String(row.state),
    actorRole: String(row.actor_role),
    targetObjectId: String(row.target_object_id),
    mutation: row.mutation === true,
    approvalRequired: row.approval_required === true,
    idempotencyKeyHash: String(row.idempotency_key_hash),
    readBackVerified: row.read_back_verified === true,
    receiptId: String(row.receipt_id),
    source: row.source === "external" ? "external" : "agent",
    recordedByUserId: String(row.recorded_by_user_id ?? "legacy"),
    ...(row.cycle_id ? { cycleId: String(row.cycle_id) } : {}),
    ...(row.observation_kind === "normal" || row.observation_kind === "exception"
      ? { observationKind: row.observation_kind }
      : {}),
    ...(row.observed_at ? { observedAt: toIso(row.observed_at) } : {}),
    ...(row.source_snapshot_digest ? { sourceSnapshotDigest: String(row.source_snapshot_digest) } : {}),
    ...(row.external_signal_id ? { externalSignalId: String(row.external_signal_id) } : {}),
    ...(row.external_transaction_digest ? { externalTransactionDigest: String(row.external_transaction_digest) } : {}),
    ...(row.agent_provenance ? { agentProvenance: workflowDemoAgentProvenanceSchema.parse(parseJsonRecord(row.agent_provenance)) } : {}),
    createdAt: toIso(row.created_at),
  };
}

function rowToMutation(row: Record<string, unknown>): WorkflowDemoMutationRecord {
  return {
    mutationId: String(row.mutation_id),
    ...(row.workflow_action_id ? { workflowActionId: String(row.workflow_action_id) } : {}),
    mutationDigest: String(row.mutation_digest),
    objectId: String(row.object_id),
    before: parseJsonRecord(row.before_json) as unknown as WorkflowDemoObjectState,
    after: parseJsonRecord(row.after_json) as unknown as WorkflowDemoObjectState,
    receiptId: String(row.receipt_id),
    actionDigest: String(row.action_digest),
    source: row.source === "external" ? "external" : "agent",
    recordedByUserId: String(row.recorded_by_user_id ?? "legacy"),
    ...(row.agent_provenance ? { agentProvenance: workflowDemoAgentProvenanceSchema.parse(parseJsonRecord(row.agent_provenance)) } : {}),
    createdAt: toIso(row.created_at),
  };
}

function rowToWait(row: Record<string, unknown>): WorkflowDemoWaitRecord {
  return {
    runId: String(row.run_id),
    waitId: String(row.wait_id),
    reason: String(row.reason),
    resumeConditionDigest: String(row.resume_condition_digest),
    status: String(row.status) as WorkflowDemoWaitRecord["status"],
    startedAt: toIso(row.started_at),
    ...(row.resumed_at ? { resumedAt: toIso(row.resumed_at) } : {}),
    ...(row.resume_event_digest ? { resumeEventDigest: String(row.resume_event_digest) } : {}),
    ...(row.resumed_by_user_id ? { resumedByUserId: String(row.resumed_by_user_id) } : {}),
    ...(row.agent_provenance ? { agentProvenance: workflowDemoAgentProvenanceSchema.parse(parseJsonRecord(row.agent_provenance)) } : {}),
  };
}

function rowToSnapshot(row: Record<string, unknown>): WorkflowDemoReplaySnapshot {
  const replay = workflowDemoPublicReplaySchema.parse(parseJsonRecord(row.replay_json));
  const contentHash = String(row.content_hash);
  if (!safeHashEqual(contentHash, digestCanonical(replay))) {
    throw new WorkflowDemoStoreError(
      "冻结回放内容校验失败",
      "WORKFLOW_DEMO_REPLAY_INTEGRITY_FAILED",
      500,
    );
  }
  return {
    replayId: String(row.replay_id),
    runId: String(row.run_id),
    demoId: String(row.demo_id),
    workflowId: String(row.workflow_id),
    catalogScenarioId: String(row.catalog_scenario_id),
    definitionVersion: String(row.definition_version),
    contentHash,
    replay,
    createdAt: toIso(row.created_at),
  };
}

function rowToReview(row: Record<string, unknown>): WorkflowDemoReplayReview {
  return {
    replayId: String(row.replay_id),
    reviewerUserId: String(row.reviewer_user_id),
    decision: String(row.decision) as WorkflowDemoReviewDecision,
    contentHash: String(row.content_hash),
    reviewedAt: toIso(row.reviewed_at),
  };
}

function rowToPublication(row: Record<string, unknown>): WorkflowDemoReplayPublication {
  return {
    replayId: String(row.replay_id),
    publisherUserId: String(row.publisher_user_id),
    publishedAt: toIso(row.published_at),
    ...(row.supersedes_replay_id ? { supersedesReplayId: String(row.supersedes_replay_id) } : {}),
  };
}

function rowToPublished(row: Record<string, unknown>): WorkflowDemoPublishedReplay {
  const snapshot = rowToSnapshot(row);
  const review: WorkflowDemoReplayReview = {
      replayId: snapshot.replayId,
      reviewerUserId: String(row.reviewer_user_id),
      decision: String(row.decision) as WorkflowDemoReviewDecision,
      contentHash: String(row.review_content_hash),
      reviewedAt: toIso(row.reviewed_at),
  };
  assertPublishedIntegrity(snapshot, review);
  return {
    snapshot,
    review,
    publication: rowToPublication(row),
  };
}

function assertSnapshotIntegrity(snapshot: WorkflowDemoReplaySnapshot): WorkflowDemoReplaySnapshot {
  const replay = workflowDemoPublicReplaySchema.parse(snapshot.replay);
  if (!safeHashEqual(snapshot.contentHash, digestCanonical(replay))) {
    throw new WorkflowDemoStoreError("冻结回放内容校验失败", "WORKFLOW_DEMO_REPLAY_INTEGRITY_FAILED", 500);
  }
  return snapshot;
}

function assertPublishedIntegrity(
  snapshot: WorkflowDemoReplaySnapshot,
  review: WorkflowDemoReplayReview,
): void {
  assertSnapshotIntegrity(snapshot);
  if (review.decision !== "approved" || !safeHashEqual(review.contentHash, snapshot.contentHash)) {
    throw new WorkflowDemoStoreError("公开回放复核校验失败", "WORKFLOW_DEMO_REVIEW_INTEGRITY_FAILED", 500);
  }
}

async function lockRun(client: pg.PoolClient, runId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`workflow-demo:${runId}`]);
}

async function requirePgRunExists(pool: PgPool, runsTable: string, runId: string): Promise<void> {
  const result = await pool.query(`SELECT 1 FROM ${runsTable} WHERE run_id=$1 LIMIT 1`, [runId]);
  if (!result.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
}

async function requirePgAuthorizedRun(
  client: pg.PoolClient,
  runsTable: string,
  runId: string,
  executionToken: string,
): Promise<WorkflowDemoRunRecord> {
  const result = await client.query(`SELECT * FROM ${runsTable} WHERE run_id=$1 FOR UPDATE`, [runId]);
  if (!result.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
  const tokenHash = result.rows[0].execution_token_hash ? String(result.rows[0].execution_token_hash) : "";
  if (!safeHashEqual(tokenHash, sha256(executionToken))) {
    throw new WorkflowDemoStoreError("Workflow Demo execution token 无效", "WORKFLOW_DEMO_EXECUTION_TOKEN_INVALID", 403);
  }
  return rowToRun(result.rows[0]);
}

async function requirePgAgentRun(
  client: pg.PoolClient,
  runsTable: string,
  runId: string,
  provenance: WorkflowDemoAgentProvenance,
): Promise<WorkflowDemoRunRecord> {
  const result = await client.query(`SELECT * FROM ${runsTable} WHERE run_id=$1 FOR UPDATE`, [runId]);
  if (!result.rows[0]) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
  const run = rowToRun(result.rows[0]);
  assertAgentProvenance(run, provenance);
  return run;
}

function assertAgentProvenance(
  run: WorkflowDemoRunRecord,
  provenance: WorkflowDemoAgentProvenance,
  expected: { eventId?: string; actionDigest?: string } = {},
): void {
  const parsed = workflowDemoAgentProvenanceSchema.safeParse(provenance);
  if (!parsed.success
    || provenance.toolInvocationId !== `${provenance.runtimeRunId}:${provenance.toolCallId}`
    || provenance.tenantId !== run.tenantId
    || provenance.actorUserId !== run.actorUserId
    || (run.runtimeSessionId !== undefined && provenance.runtimeSessionId !== run.runtimeSessionId)
    || (expected.eventId !== undefined && provenance.workflowEventId !== expected.eventId)
    || (expected.actionDigest !== undefined && provenance.actionBindingDigest !== expected.actionDigest)) {
    throw new WorkflowDemoStoreError(
      "Workflow Demo Agent 执行来源校验失败",
      "WORKFLOW_DEMO_AGENT_PROVENANCE_INVALID",
      403,
    );
  }
}

function assertCreateInput(input: CreateWorkflowDemoRunInput): void {
  for (const [field, value] of Object.entries({
    demoId: input.demoId,
    workflowId: input.workflowId,
    catalogScenarioId: input.catalogScenarioId,
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    definitionVersion: input.definitionVersion,
    manifestDigest: input.manifestDigest,
    actionDigest: input.actionDigest,
  })) {
    if (!value.trim()) throw new WorkflowDemoStoreError(`${field} 不能为空`, "WORKFLOW_DEMO_INVALID_REQUEST", 400);
  }
}

function assertObjects(objects: WorkflowDemoObjectState[]): void {
  if (objects.length === 0) throw new WorkflowDemoStoreError("演示对象不能为空", "WORKFLOW_DEMO_OBJECTS_REQUIRED", 400);
  const ids = new Set<string>();
  for (const object of objects) {
    if (!object.id || !object.label || !object.state || !Number.isInteger(object.version) || object.version < 1) {
      throw new WorkflowDemoStoreError("演示对象不合法", "WORKFLOW_DEMO_OBJECT_INVALID", 400);
    }
    if (ids.has(object.id)) throw new WorkflowDemoConflictError("演示对象 ID 重复", "WORKFLOW_DEMO_OBJECT_DUPLICATE");
    ids.add(object.id);
  }
}

function assertExternalSignalInput(input: ApplyWorkflowDemoExternalSignalInput): void {
  if (!input.signalId.trim() || !/^[a-f0-9]{64}$/.test(input.signalDigest)
    || !/^[a-f0-9]{64}$/.test(input.transactionDigest)) {
    throw new WorkflowDemoStoreError("外部信号摘要无效", "WORKFLOW_DEMO_EXTERNAL_SIGNAL_INVALID", 400);
  }
  const mutationIds = input.mutations.map((item) => item.mutationId);
  const receiptIds = input.mutations.map((item) => item.receiptId);
  const objectIds = input.mutations.map((item) => item.objectId);
  if (new Set(mutationIds).size !== mutationIds.length
    || new Set(receiptIds).size !== receiptIds.length
    || new Set(objectIds).size !== objectIds.length
    || receiptIds.includes(input.event.receiptId)) {
    throw new WorkflowDemoConflictError("外部信号动作或回执不唯一", "WORKFLOW_DEMO_EXTERNAL_SIGNAL_CONFLICT");
  }
  if (input.continuation && (
    input.continuation.externalSignalId !== input.signalId
    || !input.continuation.nextEventId.trim()
  )) {
    throw new WorkflowDemoConflictError("续跑任务与外部信号不一致", "WORKFLOW_DEMO_CONTINUATION_CONFLICT");
  }
}

function workflowDemoContinuationId(runId: string, signalId: string, nextEventId: string): string {
  return sha256(stableStringify([runId, signalId, nextEventId]));
}

function requireActive(run: WorkflowDemoRunRecord): void {
  if (run.status === "passed" || run.status === "failed") throw terminalStateError(run.status);
}

function requireRunning(run: WorkflowDemoRunRecord): void {
  if (run.status !== "running") throw terminalStateError(run.status);
}

function requireExternalActor(run: WorkflowDemoRunRecord, externalActorUserId: string): void {
  if (!externalActorUserId.trim()) {
    throw new WorkflowDemoStoreError("外部信号执行者不能为空", "WORKFLOW_DEMO_EXTERNAL_ACTOR_REQUIRED", 400);
  }
  if (run.actorUserId === externalActorUserId) {
    throw new WorkflowDemoStoreError("Workflow 执行者不能自行制造外部批准或恢复信号", "WORKFLOW_DEMO_SELF_SIGNAL_FORBIDDEN", 403);
  }
}

function terminalStateError(status: WorkflowDemoRunStatus): WorkflowDemoConflictError {
  return new WorkflowDemoConflictError(`Workflow Demo run 当前状态不允许此操作：${status}`, "WORKFLOW_DEMO_TERMINAL_STATE_CONFLICT");
}

function normalizeUniqueConflict(error: unknown, message: string): unknown {
  if (error instanceof WorkflowDemoStoreError) return error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return new WorkflowDemoConflictError(message, "WORKFLOW_DEMO_IMMUTABLE_RECEIPT_CONFLICT");
  }
  return error;
}

function digestCanonical(value: unknown): string {
  return sha256(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeHashEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  return value;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
