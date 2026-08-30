import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { SessionAutomationCommandService } from '../runtime/sessionAutomationCommandService.js';
import {
  SessionAutomationConflictError,
  type AutomationIdentity,
  type PgSessionAutomationStore,
  commandDigest,
} from '../runtime/sessionAutomationStore.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';

export interface SessionAutomationsRouterOptions {
  store: PgSessionAutomationStore;
  service: SessionAutomationCommandService;
  sessionCatalog: Pick<SessionCatalog, 'get'>;
  createSession?: (req: Request, sessionId: string) => Promise<AutomationIdentity>;
  broadcastToUser?: (userId: string, payload: Record<string, unknown>) => void;
}

async function authorizeSession(
  req: Request,
  sessionId: string,
  sessionCatalog: Pick<SessionCatalog, 'get'>,
): Promise<AutomationIdentity> {
  if (!req.user?.sub || !req.user.tenantId) {
    throw new SessionAutomationConflictError('FORBIDDEN', 'Authentication required');
  }
  const session = await sessionCatalog.get(sessionId);
  // Owner and tenant mismatches deliberately share NOT_FOUND to prevent session enumeration.
  if (!session || session.userId !== req.user.sub || session.tenantId !== req.user.tenantId) {
    throw new SessionAutomationConflictError('NOT_FOUND', 'session 不存在');
  }
  return { tenantId: req.user.tenantId, ownerUserId: req.user.sub, sessionId };
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof SessionAutomationConflictError) {
    const status = error.code === 'NOT_FOUND'
      ? 404
      : error.code === 'FORBIDDEN'
        ? 403
        : error.code === 'INVALID_COMMAND'
          ? 400
          : error.code === 'FEATURE_DISABLED' || error.code === 'EXECUTION_DISABLED'
            ? 503
            : 409;
    res.status(status).json({ code: error.code, message: error.message, current: error.current });
    return;
  }
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'unknown error',
  });
}

function parseCommandBody(body: Record<string, unknown>): {
  clientMessageId: string;
  command: string;
  expectedControlVersion?: number;
  expectedIncarnationId?: string;
} {
  const clientMessageId = typeof body.clientMessageId === 'string'
    ? body.clientMessageId
    : typeof body.clientMsgId === 'string'
      ? body.clientMsgId
      : undefined;
  const command = typeof body.command === 'string'
    ? body.command
    : typeof body.rawCommand === 'string'
      ? body.rawCommand
      : undefined;
  if (!clientMessageId || !command) {
    throw new SessionAutomationConflictError('INVALID_COMMAND', 'clientMessageId/command required');
  }
  return {
    clientMessageId,
    command,
    ...(typeof body.expectedControlVersion === 'number'
      ? { expectedControlVersion: body.expectedControlVersion }
      : {}),
    ...(typeof body.expectedIncarnationId === 'string'
      ? { expectedIncarnationId: body.expectedIncarnationId }
      : {}),
  };
}

export function createSessionAutomationsRouter(options: SessionAutomationsRouterOptions): Router {
  const router = Router({ mergeParams: true });
  if (options.broadcastToUser) options.store.setNotifier(options.broadcastToUser);

  router.post('/session-automations/commands', async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const commandInput = parseCommandBody(body);
      const requestedSessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : null;
      let id: AutomationIdentity;
      if (requestedSessionId) {
        id = await authorizeSession(req, requestedSessionId, options.sessionCatalog);
      } else {
        if (!req.user?.sub || !req.user.tenantId) throw new SessionAutomationConflictError('FORBIDDEN', 'Authentication required');
        if (!options.createSession) throw new SessionAutomationConflictError('FEATURE_DISABLED', 'new-session automation unavailable');
        const sessionId = await options.store.prepareCommandSession({
          tenantId: req.user.tenantId,
          ownerUserId: req.user.sub,
          clientMessageId: commandInput.clientMessageId,
          commandDigest: commandDigest(commandInput.command),
          sessionId: randomUUID(),
        });
        id = await options.createSession(req, sessionId);
      }
      const result = await options.service.command(id, commandInput);
      const cursor = result.snapshot
        ? await options.store.latestEventCursor(id.tenantId, id.sessionId, result.snapshot.automationId)
        : null;
      res.json({
        status: result.result,
        replayed: result.result === 'idempotent_replay',
        sessionId: id.sessionId,
        automation: result.snapshot ?? null,
        cursor,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/sessions/:sessionId/automation', async (req, res) => {
    try {
      const id = await authorizeSession(req, req.params.sessionId!, options.sessionCatalog);
      const items = (await options.store.list(id.tenantId, id.sessionId))
        .filter(item => item.ownerUserId === id.ownerUserId);
      const snapshot = items.find(item => !['completed', 'cancelled', 'failed', 'expired'].includes(item.status))
        ?? items[0]
        ?? null;
      const cursor = snapshot
        ? await options.store.latestEventCursor(id.tenantId, id.sessionId, snapshot.automationId)
        : null;
      res.json({ automation: snapshot, cursor });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/session-automations/:automationId/events', async (req, res) => {
    try {
      if (!req.user?.sub || !req.user.tenantId) {
        throw new SessionAutomationConflictError('FORBIDDEN', 'Authentication required');
      }
      const snapshot = await options.store.getByAutomationId(req.user.tenantId, req.params.automationId!);
      if (!snapshot || snapshot.ownerUserId !== req.user.sub) {
        throw new SessionAutomationConflictError('NOT_FOUND', 'automation 不存在');
      }
      await authorizeSession(req, snapshot.sessionId, options.sessionCatalog);
      const page = await options.store.listEvents(
        snapshot.tenantId,
        snapshot.sessionId,
        snapshot.automationId,
        typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      );
      res.json({ events: page.events, nextCursor: page.nextCursor });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/session-automations/:automationId/control', async (req, res) => {
    try {
      if (!req.user?.sub || !req.user.tenantId) {
        throw new SessionAutomationConflictError('FORBIDDEN', 'Authentication required');
      }
      const snapshot = await options.store.getByAutomationId(req.user.tenantId, req.params.automationId!);
      if (!snapshot || snapshot.ownerUserId !== req.user.sub) {
        throw new SessionAutomationConflictError('NOT_FOUND', 'automation 不存在');
      }
      const id = await authorizeSession(req, snapshot.sessionId, options.sessionCatalog);
      const body = req.body as Record<string, unknown>;
      const clientMessageId = typeof body.clientMessageId === 'string'
        ? body.clientMessageId
        : typeof body.clientMsgId === 'string'
          ? body.clientMsgId
          : req.get('Idempotency-Key');
      if (!clientMessageId || typeof body.action !== 'string'
        || typeof body.expectedControlVersion !== 'number'
        || typeof body.expectedIncarnationId !== 'string') {
        throw new SessionAutomationConflictError('INVALID_COMMAND', 'control fence required');
      }
      const action = body.action === 'run_now' ? 'run' : body.action;
      const result = action === 'edit'
        ? await options.service.edit(id, snapshot.automationId, {
          clientMessageId,
          payload: body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {},
          expectedControlVersion: body.expectedControlVersion,
          expectedIncarnationId: body.expectedIncarnationId,
        })
        : await options.service.control(id, snapshot.automationId, {
          clientMessageId,
          action: action as 'pause' | 'resume' | 'run' | 'clear' | 'reconcile',
          expectedControlVersion: body.expectedControlVersion,
          expectedIncarnationId: body.expectedIncarnationId,
        });
      res.json({ automation: result.snapshot });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/sessions/:sessionId/automations', async (req, res) => {
    try {
      const id = await authorizeSession(req, req.params.sessionId!, options.sessionCatalog);
      res.json({
        items: (await options.store.list(id.tenantId, id.sessionId))
          .filter(item => item.ownerUserId === id.ownerUserId),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/sessions/:sessionId/automations/:automationId', async (req, res) => {
    try {
      const id = await authorizeSession(req, req.params.sessionId!, options.sessionCatalog);
      const item = await options.store.get(id.tenantId, id.sessionId, req.params.automationId!);
      if (!item || item.ownerUserId !== id.ownerUserId) {
        throw new SessionAutomationConflictError('NOT_FOUND', 'automation 不存在');
      }
      res.json(item);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/sessions/:sessionId/automations/commands', async (req, res) => {
    try {
      const id = await authorizeSession(req, req.params.sessionId!, options.sessionCatalog);
      res.json(await options.service.command(id, parseCommandBody(req.body as Record<string, unknown>)));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/sessions/:sessionId/automations/:automationId/control', async (req, res) => {
    try {
      const id = await authorizeSession(req, req.params.sessionId!, options.sessionCatalog);
      const body = req.body as Record<string, unknown>;
      if (typeof body.clientMessageId !== 'string' || typeof body.action !== 'string'
        || typeof body.expectedControlVersion !== 'number'
        || typeof body.expectedIncarnationId !== 'string') {
        throw new SessionAutomationConflictError('INVALID_COMMAND', 'control fence required');
      }
      if (!['pause', 'resume', 'run', 'clear', 'reconcile'].includes(body.action)) {
        throw new SessionAutomationConflictError('INVALID_COMMAND', 'invalid action');
      }
      if (body.action === 'reconcile') {
        const evidence = body.reconciliation as Record<string, unknown> | undefined;
        if (!evidence || typeof evidence.providerAttemptId !== 'string' || typeof evidence.receiptKey !== 'string'
          || !['completed', 'not_found', 'still_running', 'ambiguous'].includes(String(evidence.observedState))
          || !evidence.receiptPayload || typeof evidence.receiptPayload !== 'object') {
          throw new SessionAutomationConflictError('INVALID_COMMAND', 'reconciliation evidence required');
        }
      }
      res.json(await options.service.control(id, req.params.automationId!, body as never));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
