import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type {
  ExternalClientAuthenticator,
  ExternalClientPrincipal,
} from '../data/externalClients/index.js';
import type {
  ExternalConversationRecord,
  ExternalConversationStore,
  ExternalExecutionRecord,
} from '../data/externalConversations/index.js';
import type { FinalOutputCollector } from '../externalAgent/finalOutputCollector.js';
import type { HeadlessWebClient } from '../externalAgent/headlessWebClient.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { ExternalApiAdmissionController } from '../externalAgent/admissionController.js';

const metadataSchema = z
  .record(z.string().min(1).max(80), z.unknown())
  .refine((value) => Object.keys(value).length <= 20, 'metadata 最多包含 20 个字段')
  .refine((value) => JSON.stringify(value).length <= 16_384, 'metadata 不能超过 16 KiB');

const createConversationSchema = z.object({
  external_conversation_id: z.string().trim().min(1).max(200),
  database_connection_id: z.string().trim().min(1).max(128).optional(),
  agent_id: z.string().trim().min(1).max(128).optional(),
  metadata: metadataSchema.optional(),
});

const messageSchema = z.object({
  message: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(200).default('inherit'),
  reasoning: z
    .object({
      enabled: z.literal(true),
      effort: z.string().trim().min(1).max(40).optional(),
    })
    .optional(),
  response_mode: z.literal('final').default('final'),
  wait_timeout_ms: z.number().int().min(0).max(120_000).default(120_000),
});

export interface ExternalAgentApiRouterDeps {
  authenticator?: ExternalClientAuthenticator;
  store?: ExternalConversationStore;
  headlessClient?: HeadlessWebClient;
  outputCollector?: FinalOutputCollector;
  orgAgentStore?: Pick<OrgAgentStore, 'get'>;
  admission?: Pick<ExternalApiAdmissionController, 'acquire'>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function idempotencyKey(req: Request): string | undefined {
  const value = req.get('Idempotency-Key')?.trim();
  return value && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

function conversationView(record: ExternalConversationRecord) {
  return {
    id: record.conversationId,
    external_conversation_id: record.externalConversationId,
    status: record.status,
    ...(record.databaseConnectionId
      ? { database_connection: { id: record.databaseConnectionId } }
      : {}),
    ...(record.agentId ? { agent_id: record.agentId } : {}),
    metadata: record.metadata,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function executionUrl(record: ExternalExecutionRecord): string {
  return `/v1/executions/${record.executionId}`;
}

function executionResultView(result: Awaited<ReturnType<FinalOutputCollector['collect']>>) {
  return {
    conversation_id: result.conversationId,
    execution_id: result.executionId,
    status: result.status,
    ...(result.output ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
    usage: {
      ...(result.usage.effectiveModel ? { effective_model: result.usage.effectiveModel } : {}),
      ...(result.usage.reasoningEffort ? { reasoning_effort: result.usage.reasoningEffort } : {}),
    },
    ...(result.status === 'running' ? { result_url: `/v1/executions/${result.executionId}` } : {}),
  };
}

function unavailable(res: Response): void {
  res
    .status(503)
    .json({ error: 'External Agent API unavailable', code: 'external_agent_unavailable' });
}

export function createExternalAgentApiRouter(deps: ExternalAgentApiRouterDeps): Router {
  const router = Router();

  router.use(async (req, res, next) => {
    if (!deps.authenticator) {
      unavailable(res);
      return;
    }
    const result = await deps.authenticator.authenticateBearer(req.get('Authorization'));
    if (!result.ok) {
      res
        .status(result.status)
        .json({ error: 'External API authentication failed', code: result.code });
      return;
    }
    res.locals.externalPrincipal = result.principal;
    const decision = deps.admission?.acquire(result.principal.client.clientId);
    if (decision && !decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds ?? 60));
      const concurrent = decision.reason === 'concurrency_limit';
      res.status(429).json({
        error: concurrent ? 'Concurrent request limit exceeded' : 'Rate limit exceeded',
        code: concurrent ? 'concurrency_limit_exceeded' : 'rate_limit_exceeded',
      });
      return;
    }
    if (decision?.release) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        decision.release?.();
      };
      res.once('finish', release);
      res.once('close', release);
    }
    next();
  });

  router.post('/conversations', async (req, res) => {
    if (!deps.store) return unavailable(res);
    const principal = res.locals.externalPrincipal as ExternalClientPrincipal;
    if (!principal.client.scopes.includes('conversations:write')) {
      res.status(403).json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    const key = idempotencyKey(req);
    if (!key) {
      res
        .status(400)
        .json({ error: 'Valid Idempotency-Key required', code: 'idempotency_key_required' });
      return;
    }
    const parsed = createConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid body', code: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const connectionId = parsed.data.database_connection_id;
    if (connectionId && !principal.client.allowedConnectionIds.includes(connectionId)) {
      res
        .status(404)
        .json({ error: 'Database connection not found', code: 'database_connection_not_found' });
      return;
    }
    const agentId = parsed.data.agent_id;
    if (agentId) {
      const agent = deps.orgAgentStore?.get(agentId);
      if (
        !principal.client.allowedAgentIds.includes(agentId) ||
        !agent ||
        agent.tenantId !== principal.tenantId ||
        !agent.enabled
      ) {
        res.status(404).json({ error: 'Agent not found', code: 'agent_not_found' });
        return;
      }
    }
    const hash = requestHash(parsed.data);
    const created = await deps.store.createConversation({
      clientId: principal.client.clientId,
      tenantId: principal.tenantId,
      serviceAccountUserId: principal.serviceAccountUserId,
      externalConversationId: parsed.data.external_conversation_id,
      ...(connectionId ? { databaseConnectionId: connectionId } : {}),
      ...(agentId ? { agentId } : {}),
      metadata: parsed.data.metadata ?? {},
      idempotencyKey: key,
      requestHash: hash,
    });
    if (created.outcome === 'conflict') {
      res.status(409).json({
        error: 'Idempotency key conflicts with another request',
        code: 'idempotency_conflict',
      });
      return;
    }
    res.status(created.outcome === 'created' ? 201 : 200).json(conversationView(created.record));
  });

  router.post('/conversations/:conversationId/messages', async (req, res) => {
    if (!deps.store || !deps.headlessClient || !deps.outputCollector) return unavailable(res);
    const principal = res.locals.externalPrincipal as {
      client: { clientId: string; scopes: string[] };
      tenantId: string;
      serviceAccountUserId: string;
    };
    if (!principal.client.scopes.includes('conversations:write')) {
      res.status(403).json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    const key = idempotencyKey(req);
    if (!key) {
      res
        .status(400)
        .json({ error: 'Valid Idempotency-Key required', code: 'idempotency_key_required' });
      return;
    }
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid body', code: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const conversation = await deps.store.getConversation(req.params.conversationId);
    if (
      !conversation ||
      conversation.clientId !== principal.client.clientId ||
      conversation.tenantId !== principal.tenantId ||
      conversation.serviceAccountUserId !== principal.serviceAccountUserId ||
      conversation.status !== 'active'
    ) {
      res.status(404).json({ error: 'Conversation not found', code: 'conversation_not_found' });
      return;
    }
    const semanticRequest = {
      conversation_id: conversation.conversationId,
      message: parsed.data.message,
      model: parsed.data.model,
      reasoning: parsed.data.reasoning,
      response_mode: parsed.data.response_mode,
    };
    const reserved = await deps.store.reserveExecution({
      conversation,
      idempotencyKey: key,
      requestHash: requestHash(semanticRequest),
      ...(parsed.data.model !== 'inherit' ? { requestedModel: parsed.data.model } : {}),
      ...(parsed.data.reasoning?.effort
        ? { requestedReasoningEffort: parsed.data.reasoning.effort }
        : {}),
    });
    if (reserved.outcome === 'conflict') {
      res.status(409).json({
        error: 'Idempotency key conflicts with another request',
        code: 'idempotency_conflict',
      });
      return;
    }

    let execution = reserved.record;
    if (execution.submissionStatus === 'submitting') {
      const submitted = await deps.headlessClient.submit({
        userId: conversation.serviceAccountUserId,
        tenantId: conversation.tenantId,
        message: parsed.data.message,
        clientMessageId: execution.clientMessageId,
        ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
        ...(conversation.agentId ? { agentId: conversation.agentId } : {}),
        ...(parsed.data.model !== 'inherit' ? { model: parsed.data.model } : {}),
        ...(parsed.data.reasoning ? { reasoning: parsed.data.reasoning } : {}),
        externalContext: {
          apiClientId: conversation.clientId,
          conversationId: conversation.conversationId,
          externalConversationId: conversation.externalConversationId,
          ...(conversation.databaseConnectionId
            ? { databaseConnectionId: conversation.databaseConnectionId }
            : {}),
          metadata: conversation.metadata,
        },
      });
      if (submitted.status === 'rejected') {
        execution =
          (await deps.store.rejectExecution({
            executionId: execution.executionId,
            errorCode: submitted.code,
            errorMessage: submitted.message,
          })) ?? execution;
        const status = submitted.code === 'personal_agent_disabled' ? 409 : 400;
        res.status(status).json({
          error: submitted.message,
          code: submitted.code,
          execution_id: execution.executionId,
        });
        return;
      }
      if (submitted.status === 'unknown') {
        res.status(202).json({
          conversation_id: conversation.conversationId,
          execution_id: execution.executionId,
          status: 'running',
          result_url: executionUrl(execution),
        });
        return;
      }
      const bound = await deps.store.bindAcceptedExecution({
        executionId: execution.executionId,
        conversationId: conversation.conversationId,
        runId: submitted.runId,
        sessionId: submitted.sessionId,
      });
      if (!bound) {
        res.status(409).json({
          error: 'Conversation session binding conflict',
          code: 'conversation_binding_conflict',
        });
        return;
      }
      execution = bound;
    }
    const result = await deps.outputCollector.waitForTerminal(
      execution,
      parsed.data.wait_timeout_ms,
    );
    res.status(result.status === 'running' ? 202 : 200).json(executionResultView(result));
  });

  router.get('/executions/:executionId', async (req, res) => {
    if (!deps.store || !deps.outputCollector) return unavailable(res);
    const principal = res.locals.externalPrincipal as {
      client: { clientId: string; scopes: string[] };
      tenantId: string;
      serviceAccountUserId: string;
    };
    if (!principal.client.scopes.includes('executions:read')) {
      res.status(403).json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    const execution = await deps.store.getExecution(req.params.executionId);
    if (
      !execution ||
      execution.clientId !== principal.client.clientId ||
      execution.tenantId !== principal.tenantId ||
      execution.serviceAccountUserId !== principal.serviceAccountUserId
    ) {
      res.status(404).json({ error: 'Execution not found', code: 'execution_not_found' });
      return;
    }
    res.json(executionResultView(await deps.outputCollector.collect(execution)));
  });

  return router;
}
