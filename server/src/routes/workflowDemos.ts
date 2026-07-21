import { resolve } from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";

import { isPlatformAdmin } from "../auth/types.js";
import { hasPlatformCapability } from "../auth/platformGovernance.js";
import {
  createRetryableWorkflowLibraryLoader,
  loadWorkflowLibraryV3,
  type LoadedWorkflowLibraryV3,
} from "../data/scenarios/workflowLibrary.js";
import {
  getWorkflowDemoApprovalRequests,
  getWorkflowDemoProgress,
  initializeWorkflowDemo,
  recordWorkflowDemoExternalStep,
} from "../data/workflowDemos/engine.js";
import {
  WorkflowDemoStoreError,
  type WorkflowDemoPublishedReplay,
  type WorkflowDemoRunRecord,
  type WorkflowDemoStore,
} from "../data/workflowDemos/store.js";
import type { DemoManifestRecord } from "../../../shared/src/index.js";
import { projectWorkflowDemoPublic } from "../../../shared/src/index.js";

const DEFAULT_V3_DATA_PATH = resolve(
  import.meta.dirname,
  "../data/scenarios/workflow-library-v3.json",
);

const idSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const emptyBodySchema = z.object({}).strict();
const signalBodySchema = z.object({
  eventId: idSchema,
  challenge: z.string().min(80).max(2_000),
  signal: z.object({
    signalId: idSchema,
    signalRef: z.string().min(1).max(240).regex(/^[a-zA-Z0-9._:/-]+$/),
    kind: z.enum(["approval", "resume"]),
    occurredAt: z.string().datetime({ offset: true }),
    approvalDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    observations: z.array(z.object({
      objectId: idSchema,
      expectedVersion: z.number().int().min(1),
      observedState: z.string().trim().min(1).max(1_000),
      sourceReceiptId: idSchema,
    }).strict()).max(32),
  }).strict().superRefine((signal, ctx) => {
    if (signal.kind === "approval" && !signal.approvalDigest) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approval signal 必须携带冻结摘要" });
    }
    if (signal.kind === "resume" && signal.approvalDigest !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resume signal 不得携带批准摘要" });
    }
    if (new Set(signal.observations.map((item) => item.objectId)).size !== signal.observations.length
      || new Set(signal.observations.map((item) => item.sourceReceiptId)).size !== signal.observations.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "signal observations 必须唯一" });
    }
  }),
}).strict();
const signalChallengeBodySchema = z.object({
  eventId: idSchema,
  signalId: idSchema,
}).strict();
const reviewBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const publishBodySchema = z.object({
  supersedesReplayId: z.string().uuid().optional(),
}).strict();
const runIdSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const publicTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{40,64}$/);
const UNBOUND_LAUNCH_TTL_MS = 15 * 60 * 1_000;

export interface WorkflowDemosRouterOptions {
  store: WorkflowDemoStore;
  /** 使用平台 JWT secret 派生短期、单次、绑定账号的外部信号 challenge。 */
  signalChallengeSecret?: string;
  v3DataPath?: string;
  /** 定向测试可注入；生产缺省始终读取随代码发布的 V3 权威源。 */
  v3Loader?: () => Promise<LoadedWorkflowLibraryV3>;
}

export function createWorkflowDemosRouter(options: WorkflowDemosRouterOptions): Router {
  const router = Router();
  const getLibrary = createRetryableWorkflowLibraryLoader(
    options.v3Loader ?? (() => loadWorkflowLibraryV3(options.v3DataPath ?? DEFAULT_V3_DATA_PATH)),
  );
  void getLibrary().catch(() => undefined);

  router.post("/workflow-demos/catalog/:catalogScenarioId/runs", async (req, res) => {
    if (!req.user) return unauthorized(res);
    const catalogScenarioId = idSchema.safeParse(req.params.catalogScenarioId);
    const body = emptyBodySchema.safeParse(req.body ?? {});
    const idempotencyKey = readIdempotencyKey(req);
    if (!catalogScenarioId.success || !body.success || !idempotencyKey.success) {
      res.status(400).json({
        error: "演示启动参数不完整",
        code: !idempotencyKey.success ? "IDEMPOTENCY_KEY_REQUIRED" : "INVALID_DEMO_REQUEST",
      });
      return;
    }
    try {
      await expireStaleLaunches(options.store);
      const manifest = await requireCatalogManifest(getLibrary(), catalogScenarioId.data);
      const initialized = await initializeWorkflowDemo(options.store, {
        manifest,
        tenantId: req.user.tenantId,
        actorUserId: req.user.sub,
        idempotencyKey: idempotencyKey.data,
      });
      const progress = await getWorkflowDemoProgress(options.store, manifest, initialized.run);
      res.status(initialized.replayed ? 200 : 201).json({
        run: await projectCatalogRun(options.store, initialized.run),
        nextEventId: progress.nextEventId,
        nextPhase: progress.nextPhase,
        awaitingExternal: progress.awaitingExternal,
        dispatchMetadata: progress.nextEventId
          ? workflowDemoDispatchMetadata(initialized.run.runId, progress.nextEventId)
          : null,
        objects: initialized.objects.map(projectSafeBusinessObject),
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post("/workflow-demos/:demoId/runs", async (req, res) => {
    if (!req.user) return unauthorized(res);
    const demoId = idSchema.safeParse(req.params.demoId);
    const body = emptyBodySchema.safeParse(req.body ?? {});
    const idempotencyKey = readIdempotencyKey(req);
    if (!demoId.success || !body.success || !idempotencyKey.success) {
      res.status(400).json({
        error: "演示启动参数不完整",
        code: !idempotencyKey.success ? "IDEMPOTENCY_KEY_REQUIRED" : "INVALID_DEMO_REQUEST",
      });
      return;
    }
    try {
      await expireStaleLaunches(options.store);
      const manifest = await requireManifest(getLibrary(), demoId.data);
      const initialized = await initializeWorkflowDemo(options.store, {
        manifest,
        tenantId: req.user.tenantId,
        actorUserId: req.user.sub,
        idempotencyKey: idempotencyKey.data,
      });
      const progress = await getWorkflowDemoProgress(options.store, manifest, initialized.run);
      res.status(initialized.replayed ? 200 : 201).json({
        run: await projectAuthenticatedRun(options.store, initialized.run),
        approvalRequests: getWorkflowDemoApprovalRequests(manifest),
        nextEventId: progress.nextEventId,
        nextPhase: progress.nextPhase,
        awaitingExternal: progress.awaitingExternal,
        dispatchMetadata: progress.nextEventId
          ? workflowDemoDispatchMetadata(initialized.run.runId, progress.nextEventId)
          : null,
        objects: initialized.objects,
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.delete("/workflow-demos/runs/:runId/launch", async (req, res) => {
    if (!req.user) return unauthorized(res);
    const runId = runIdSchema.safeParse(req.params.runId);
    if (!runId.success) return notFound(res, "workflow_demo_run_not_found");
    try {
      const run = await options.store.abandonUnboundRun(
        runId.data,
        req.user.tenantId,
        req.user.sub,
        "launch_not_acknowledged",
      );
      res.json({ status: run.status });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post("/workflow-demos/runs/:runId/signals", async (req, res) => {
    if (!req.user) return unauthorized(res);
    const runId = runIdSchema.safeParse(req.params.runId);
    const body = signalBodySchema.safeParse(req.body ?? {});
    if (!runId.success || !body.success) {
      res.status(400).json({ error: "外部信号参数无效", code: "INVALID_WORKFLOW_DEMO_SIGNAL" });
      return;
    }
    try {
      const run = await options.store.getByRunId(runId.data);
      if (!run || !canSignalRun(req.user, run)) return notFound(res, "workflow_demo_run_not_found");
      const manifest = await requireManifest(getLibrary(), run.demoId);
      const step = manifest.internal.executionPlan?.find((item) => item.eventId === body.data.eventId);
      if (!step || (step.phase !== "approval" && step.phase !== "resume")) {
        res.status(409).json({ error: "当前节点不接受外部信号", code: "WORKFLOW_DEMO_SIGNAL_STEP_MISMATCH" });
        return;
      }
      verifySignalChallenge(options.signalChallengeSecret, body.data.challenge, {
        runId: run.runId,
        eventId: body.data.eventId,
        signalId: body.data.signal.signalId,
        actorUserId: req.user.sub,
        tenantId: req.user.tenantId,
        kind: body.data.signal.kind,
      });
      const stepIndex = manifest.internal.executionPlan?.findIndex((item) => item.eventId === body.data.eventId) ?? -1;
      const followingStep = stepIndex >= 0 ? manifest.internal.executionPlan?.[stepIndex + 1] : undefined;
      const continuationNextEventId = followingStep
        && followingStep.phase !== "approval"
        && followingStep.phase !== "resume"
        ? followingStep.eventId
        : undefined;
      const result = await recordWorkflowDemoExternalStep(options.store, {
        manifest,
        runId: run.runId,
        externalActorUserId: req.user.sub,
        eventId: body.data.eventId,
        signal: body.data.signal,
        ...(continuationNextEventId ? { continuationNextEventId } : {}),
      });
      const progress = await getWorkflowDemoProgress(options.store, manifest, result.run);
      let continuationDelivered = false;
      if (progress.nextEventId && !progress.awaitingExternal) {
        continuationDelivered = await options.store.requestRuntimeContinuation({
          run: result.run,
          externalEvent: result.event,
          externalSignalId: body.data.signal.signalId,
          nextEventId: progress.nextEventId,
        });
      }
      res.json({
        run: await projectAuthenticatedRun(options.store, result.run),
        event: projectExecutionEvent(result.event),
        objects: result.objects,
        nextEventId: progress.nextEventId,
        nextPhase: progress.nextPhase,
        awaitingExternal: progress.awaitingExternal,
        continuationQueued: continuationDelivered,
        continuationPending: !!progress.nextEventId && !progress.awaitingExternal && !continuationDelivered,
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post("/workflow-demos/runs/:runId/signal-challenges", async (req, res) => {
    if (!req.user) return unauthorized(res);
    const runId = runIdSchema.safeParse(req.params.runId);
    const body = signalChallengeBodySchema.safeParse(req.body ?? {});
    if (!runId.success || !body.success) {
      res.status(400).json({ error: "外部信号 challenge 参数无效", code: "INVALID_WORKFLOW_DEMO_SIGNAL_CHALLENGE" });
      return;
    }
    try {
      const run = await options.store.getByRunId(runId.data);
      if (!run || !canSignalRun(req.user, run)) return notFound(res, "workflow_demo_run_not_found");
      const manifest = await requireManifest(getLibrary(), run.demoId);
      const events = await options.store.readEvents(run.runId);
      const step = manifest.internal.executionPlan?.[events.length];
      if (!step || step.eventId !== body.data.eventId
        || (step.phase !== "approval" && step.phase !== "resume")) {
        res.status(409).json({ error: "当前节点不接受外部信号", code: "WORKFLOW_DEMO_SIGNAL_STEP_MISMATCH" });
        return;
      }
      const expiresAt = Date.now() + 5 * 60 * 1_000;
      const challenge = createSignalChallenge(options.signalChallengeSecret, {
        runId: run.runId,
        eventId: step.eventId,
        signalId: body.data.signalId,
        actorUserId: req.user.sub,
        tenantId: req.user.tenantId,
        kind: step.phase,
        requiredActorRole: step.actorRole,
        requiredCapability: "tenant_admin",
        nonce: randomUUID(),
        expiresAt,
      });
      res.json({
        challenge,
        expiresAt: new Date(expiresAt).toISOString(),
        requiredActorRole: step.actorRole,
        requiredCapability: "tenant_admin",
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.get("/workflow-demos/runs/:runId", async (req, res) => {
    if (!req.user) return unauthorized(res);
    const runId = runIdSchema.safeParse(req.params.runId);
    if (!runId.success) return notFound(res, "workflow_demo_run_not_found");
    try {
      const run = await requireReadableRun(options.store, req, runId.data);
      const manifest = await requireManifest(getLibrary(), run.demoId);
      const events = await options.store.readEvents(run.runId);
      const nextEventId = manifest.internal.executionPlan?.[events.length]?.eventId ?? null;
      res.json({
        run: await projectAuthenticatedRun(options.store, run),
        objects: await options.store.readObjects(run.runId),
        nextEventId,
        dispatchMetadata: nextEventId ? workflowDemoDispatchMetadata(run.runId, nextEventId) : null,
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.get("/workflow-demos/runs/:runId/review-candidate", async (req, res) => {
    if (!req.user) return unauthorized(res);
    if (!isPlatformAdmin(req.user) || !hasPlatformCapability(req.user, "workflow_demo.review")) {
      res.status(403).json({ error: "只有平台管理员可以读取复核候选", code: "WORKFLOW_DEMO_REVIEW_FORBIDDEN" });
      return;
    }
    const runId = runIdSchema.safeParse(req.params.runId);
    if (!runId.success) return notFound(res, "workflow_demo_replay_not_found");
    try {
      const snapshot = await options.store.getReplayByRunId(runId.data);
      if (!snapshot) return notFound(res, "workflow_demo_replay_not_found");
      res.json({
        replayId: snapshot.replayId,
        contentHash: snapshot.contentHash,
        replay: snapshot.replay,
        createdAt: snapshot.createdAt,
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post("/workflow-demos/runs/:runId/review", async (req, res) => {
    if (!req.user) return unauthorized(res);
    if (!isPlatformAdmin(req.user) || !hasPlatformCapability(req.user, "workflow_demo.review")) {
      res.status(403).json({ error: "只有平台管理员可以复核演示", code: "WORKFLOW_DEMO_REVIEW_FORBIDDEN" });
      return;
    }
    const runId = runIdSchema.safeParse(req.params.runId);
    const body = reviewBodySchema.safeParse(req.body ?? {});
    if (!runId.success || !body.success) {
      res.status(400).json({ error: "复核参数无效", code: "INVALID_WORKFLOW_DEMO_REVIEW" });
      return;
    }
    try {
      const review = await options.store.reviewReplay({
        runId: runId.data,
        reviewerUserId: req.user.sub,
        decision: body.data.decision,
        contentHash: body.data.contentHash,
      });
      res.json({ review: { decision: review.decision, contentHash: review.contentHash, reviewedAt: review.reviewedAt } });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post("/workflow-demos/runs/:runId/publish", async (req, res) => {
    if (!req.user) return unauthorized(res);
    if (!isPlatformAdmin(req.user) || !hasPlatformCapability(req.user, "workflow_demo.publish")) {
      res.status(403).json({ error: "只有平台管理员可以发布演示", code: "WORKFLOW_DEMO_PUBLISH_FORBIDDEN" });
      return;
    }
    const runId = runIdSchema.safeParse(req.params.runId);
    const body = publishBodySchema.safeParse(req.body ?? {});
    if (!runId.success || !body.success) {
      res.status(400).json({ error: "发布参数无效", code: "INVALID_WORKFLOW_DEMO_PUBLISH" });
      return;
    }
    try {
      const published = await options.store.publishReplay({
        runId: runId.data,
        publisherUserId: req.user.sub,
        ...(body.data.supersedesReplayId ? { supersedesReplayId: body.data.supersedesReplayId } : {}),
      });
      res.json({
        replayId: published.published.snapshot.replayId,
        sharePath: publicReplayPath(published.published.snapshot.replayId),
        oneTimeTokenSharePath: published.publicToken ? publicTokenPath(published.publicToken) : null,
        publishedAt: published.published.publication.publishedAt,
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.get("/workflow-demos/catalog/:catalogScenarioId/latest", async (req, res) => {
    if (!req.user) return unauthorized(res);
    const catalogScenarioId = idSchema.safeParse(req.params.catalogScenarioId);
    if (!catalogScenarioId.success) return notFound(res, "workflow_demo_replay_not_found");
    try {
      const published = await options.store.getLatestPublishedByCatalog(catalogScenarioId.data);
      if (!published) return notFound(res, "workflow_demo_replay_not_found");
      res.json({
        replay: projectWorkflowDemoPublic({
          replay: published.snapshot.replay,
          replayId: published.snapshot.replayId,
          integrity: projectPublicIntegrity(published),
        }),
        sharePath: publicReplayPath(published.snapshot.replayId),
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.get("/share/workflow-demos/:token", async (req, res) => {
    const token = publicTokenSchema.safeParse(req.params.token);
    if (!token.success) return notFound(res, "workflow_demo_replay_not_found");
    try {
      const published = await options.store.getByPublicToken(token.data);
      if (!published) return notFound(res, "workflow_demo_replay_not_found");
      res.json(projectWorkflowDemoPublic({
        replay: published.snapshot.replay,
        replayId: published.snapshot.replayId,
        integrity: projectPublicIntegrity(published),
      }));
    } catch (error) {
      respondError(res, error);
    }
  });

  router.get("/share/workflow-replays/:replayId", async (req, res) => {
    const replayId = runIdSchema.safeParse(req.params.replayId);
    if (!replayId.success) return notFound(res, "workflow_demo_replay_not_found");
    try {
      const published = await options.store.getPublishedByReplayId(replayId.data);
      if (!published) return notFound(res, "workflow_demo_replay_not_found");
      res.json(projectWorkflowDemoPublic({
        replay: published.snapshot.replay,
        replayId: published.snapshot.replayId,
        integrity: projectPublicIntegrity(published),
      }));
    } catch (error) {
      respondError(res, error);
    }
  });

  return router;
}

async function requireManifest(
  libraryPromise: Promise<LoadedWorkflowLibraryV3>,
  demoId: string,
): Promise<DemoManifestRecord> {
  let library: LoadedWorkflowLibraryV3;
  try {
    library = await libraryPromise;
  } catch {
    throw new WorkflowDemoStoreError("场景目录暂不可用", "WORKFLOW_DEMO_CATALOG_UNAVAILABLE", 503);
  }
  const manifest = library.internal.demos.find((item) => item.id === demoId);
  if (!manifest) throw new WorkflowDemoStoreError("演示不存在", "WORKFLOW_DEMO_NOT_FOUND", 404);
  return manifest;
}

async function requireCatalogManifest(
  libraryPromise: Promise<LoadedWorkflowLibraryV3>,
  catalogScenarioId: string,
): Promise<DemoManifestRecord> {
  let library: LoadedWorkflowLibraryV3;
  try {
    library = await libraryPromise;
  } catch {
    throw new WorkflowDemoStoreError("场景目录暂不可用", "WORKFLOW_DEMO_CATALOG_UNAVAILABLE", 503);
  }
  const catalog = library.internal.catalogScenarios.find((item) => item.id === catalogScenarioId);
  const demoId = catalog?.internal.defaultDemoId;
  const manifest = demoId
    ? library.internal.demos.find((item) => item.id === demoId && item.catalogScenarioId === catalogScenarioId)
    : undefined;
  if (!catalog || !catalog.internal.enabled || !manifest) {
    throw new WorkflowDemoStoreError("该场景暂无可运行演示", "WORKFLOW_DEMO_NOT_FOUND", 404);
  }
  return manifest;
}

async function requireReadableRun(
  store: WorkflowDemoStore,
  req: Request,
  runId: string,
): Promise<WorkflowDemoRunRecord> {
  const run = await store.getByRunId(runId);
  if (!run || !req.user || !canReadRun(req.user, run)) {
    throw new WorkflowDemoStoreError("演示运行不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
  }
  return run;
}

function readIdempotencyKey(req: Request): ReturnType<typeof idempotencyKeySchema.safeParse> {
  return idempotencyKeySchema.safeParse(req.header("Idempotency-Key"));
}

async function expireStaleLaunches(store: WorkflowDemoStore): Promise<void> {
  await store.expireUnboundRuns(new Date(Date.now() - UNBOUND_LAUNCH_TTL_MS).toISOString());
}

function canReadRun(user: NonNullable<Request["user"]>, run: WorkflowDemoRunRecord): boolean {
  if (run.actorUserId === user.sub && run.tenantId === user.tenantId) return true;
  return user.role === "admin" && run.tenantId === user.tenantId;
}

function canSignalRun(user: NonNullable<Request["user"]>, run: WorkflowDemoRunRecord): boolean {
  return user.role === "admin"
    && user.sub !== run.actorUserId
    && user.tenantId === run.tenantId;
}

interface SignalChallengePayload {
  runId: string;
  eventId: string;
  signalId: string;
  actorUserId: string;
  tenantId: string;
  kind: "approval" | "resume";
  requiredActorRole: string;
  requiredCapability: "tenant_admin";
  nonce: string;
  expiresAt: number;
}

function createSignalChallenge(secret: string | undefined, payload: SignalChallengePayload): string {
  if (!secret || secret.length < 32) {
    throw new WorkflowDemoStoreError("外部信号 challenge 服务不可用", "WORKFLOW_DEMO_SIGNAL_CHALLENGE_UNAVAILABLE", 503);
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySignalChallenge(
  secret: string | undefined,
  token: string,
  expected: Pick<SignalChallengePayload, "runId" | "eventId" | "signalId" | "actorUserId" | "tenantId" | "kind">,
): void {
  if (!secret || secret.length < 32) {
    throw new WorkflowDemoStoreError("外部信号 challenge 服务不可用", "WORKFLOW_DEMO_SIGNAL_CHALLENGE_UNAVAILABLE", 503);
  }
  const [encoded, suppliedSignature, ...rest] = token.split(".");
  if (!encoded || !suppliedSignature || rest.length > 0) throw invalidSignalChallenge();
  const expectedSignature = createHmac("sha256", secret).update(encoded).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const actual = Buffer.from(expectedSignature);
  if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual)) throw invalidSignalChallenge();
  let payload: SignalChallengePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignalChallengePayload;
  } catch {
    throw invalidSignalChallenge();
  }
  if (payload.expiresAt <= Date.now()
    || payload.requiredCapability !== "tenant_admin"
    || Object.entries(expected).some(([key, value]) => payload[key as keyof SignalChallengePayload] !== value)) {
    throw invalidSignalChallenge();
  }
}

function invalidSignalChallenge(): WorkflowDemoStoreError {
  return new WorkflowDemoStoreError("外部信号 challenge 无效或已过期", "WORKFLOW_DEMO_SIGNAL_CHALLENGE_INVALID", 403);
}

function workflowDemoDispatchMetadata(runId: string, eventId: string): Record<string, unknown> {
  return { workflowDemo: { runId, eventId } };
}

function projectSafeBusinessObject(object: {
  id: string;
  label: string;
  state: string;
  version: number;
}): Record<string, unknown> {
  return {
    label: object.label,
    state: object.state,
    version: object.version,
  };
}

async function projectCatalogRun(
  store: WorkflowDemoStore,
  run: WorkflowDemoRunRecord,
): Promise<Record<string, unknown>> {
  const snapshot = await store.getReplayByRunId(run.runId);
  const published = snapshot ? await store.getPublishedByReplayId(snapshot.replayId) : null;
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    catalogScenarioId: run.catalogScenarioId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    failure: run.status === "failed"
      ? { code: "WORKFLOW_DEMO_RUN_FAILED", message: "演示运行未完成，请重新启动" }
      : null,
    publicSharePath: published ? publicReplayPath(published.snapshot.replayId) : null,
  };
}

async function projectAuthenticatedRun(
  store: WorkflowDemoStore,
  run: WorkflowDemoRunRecord,
): Promise<Record<string, unknown>> {
  const snapshot = await store.getReplayByRunId(run.runId);
  const published = snapshot ? await store.getPublishedByReplayId(snapshot.replayId) : null;
  return {
    runId: run.runId,
    demoId: run.demoId,
    workflowId: run.workflowId,
    catalogScenarioId: run.catalogScenarioId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    failure: run.status === "failed"
      ? { code: "WORKFLOW_DEMO_RUN_FAILED", message: "演示运行未完成，请重新启动" }
      : null,
    replay: snapshot?.replay ?? null,
    replayId: snapshot?.replayId ?? null,
    publicSharePath: published ? publicReplayPath(published.snapshot.replayId) : null,
  };
}

function projectExecutionEvent(event: Awaited<ReturnType<WorkflowDemoStore["appendEvent"]>>["event"]): Record<string, unknown> {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    phase: event.phase,
    label: event.label,
    summary: event.summary,
    state: event.state,
    source: event.source,
    readBackVerified: event.readBackVerified,
    createdAt: event.createdAt,
  };
}

function publicTokenPath(token: string): string {
  return `/workflow-demo-share/${encodeURIComponent(token)}`;
}

function publicReplayPath(replayId: string): string {
  return `/workflow-replays/${encodeURIComponent(replayId)}`;
}

function projectPublicIntegrity(published: WorkflowDemoPublishedReplay): Record<string, unknown> {
  return {
    contentHash: published.snapshot.contentHash,
    reviewedAt: published.review.reviewedAt,
    publishedAt: published.publication.publishedAt,
    independentlyReviewed: published.review.decision === "approved",
  };
}

function unauthorized(res: Parameters<Parameters<Router["get"]>[1]>[1]): void {
  res.status(401).json({ error: "Authentication required" });
}

function notFound(res: Parameters<Parameters<Router["get"]>[1]>[1], error: string): void {
  res.status(404).json({ error });
}

function respondError(res: Parameters<Parameters<Router["get"]>[1]>[1], error: unknown): void {
  if (error instanceof WorkflowDemoStoreError) {
    res.status(error.statusCode).json({
      error: error.statusCode >= 500 ? "Agent 开小差了，请发送「继续」" : error.message,
      code: error.code,
    });
    return;
  }
  res.status(500).json({ error: "Agent 开小差了，请发送「继续」", code: "WORKFLOW_DEMO_UNEXPECTED_ERROR" });
}
