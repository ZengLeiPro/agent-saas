import { authFetch } from '@/lib/authFetch';
import {
  type AutomationCommandResponse,
  type AutomationControlRequest,
  type AutomationTimelineEvent,
  type SessionAutomationSnapshot,
} from '@/lib/sessionAutomation';
import { createStableClientMsgId, normalizeAutomationSnapshot } from '@/lib/sessionAutomationCore';

async function readApiError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: string; message?: string; code?: string } | null;
  const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
  Object.assign(error, { status: response.status, code: body?.code });
  return error;
}

export async function submitAutomationCommand(args: {
  clientMsgId: string;
  sessionId: string | null;
  rawCommand: string;
  attachmentIds: string[];
  expectedControlVersion?: number | null;
  expectedIncarnationId?: string | null;
}): Promise<AutomationCommandResponse> {
  let response = await authFetch('/api/session-automations/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': args.clientMsgId },
    body: JSON.stringify({
      clientMsgId: args.clientMsgId,
      sessionId: args.sessionId,
      rawCommand: args.rawCommand,
      expectedControlVersion: args.expectedControlVersion ?? null,
      expectedIncarnationId: args.expectedIncarnationId ?? null,
      attachments: args.attachmentIds.map((attachmentId) => ({ attachmentId })),
    }),
  });
  if (response.status === 404 && args.sessionId) {
    response = await authFetch(`/api/sessions/${encodeURIComponent(args.sessionId)}/automations/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': args.clientMsgId },
      body: JSON.stringify({
        clientMessageId: args.clientMsgId,
        command: args.rawCommand,
        expectedControlVersion: args.expectedControlVersion ?? undefined,
        expectedIncarnationId: args.expectedIncarnationId ?? undefined,
      }),
    });
  }
  if (!response.ok) throw await readApiError(response);
  const body = await response.json() as AutomationCommandResponse | { result: string; snapshot?: SessionAutomationSnapshot };
  if ('sessionId' in body) return { ...body, automation: body.automation ? normalizeAutomationSnapshot(body.automation) : null };
  return {
    status: body.result,
    sessionId: args.sessionId ?? '',
    automation: body.snapshot ? normalizeAutomationSnapshot(body.snapshot) : null,
  };
}

export async function fetchSessionAutomation(sessionId: string): Promise<{
  snapshot: SessionAutomationSnapshot | null;
  cursor: string | null;
}> {
  const response = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/automation`);
  if (response.status === 404) {
    const listResponse = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/automations`);
    if (listResponse.status === 404) return { snapshot: null, cursor: null };
    if (!listResponse.ok) throw await readApiError(listResponse);
    const list = await listResponse.json() as { items?: SessionAutomationSnapshot[] };
    const current = (list.items ?? []).find((item) => !['completed', 'cancelled', 'failed', 'expired'].includes(item.status)) ?? list.items?.[0] ?? null;
    return { snapshot: current ? normalizeAutomationSnapshot(current) : null, cursor: null };
  }
  if (!response.ok) throw await readApiError(response);
  const body = await response.json() as SessionAutomationSnapshot | {
    automation?: SessionAutomationSnapshot | null;
    snapshot?: SessionAutomationSnapshot | null;
    cursor?: string | null;
  };
  if ('automationId' in body) return { snapshot: normalizeAutomationSnapshot(body as SessionAutomationSnapshot), cursor: null };
  const snapshot = body.snapshot ?? body.automation ?? null;
  return { snapshot: snapshot ? normalizeAutomationSnapshot(snapshot) : null, cursor: body.cursor ?? null };
}

export async function fetchAutomationEvents(automationId: string, cursor: string | null): Promise<{
  events: AutomationTimelineEvent[];
  cursor: string | null;
}> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await authFetch(`/api/session-automations/${encodeURIComponent(automationId)}/events${query}`);
  if (response.status === 404) return { events: [], cursor };
  if (!response.ok) throw await readApiError(response);
  const body = await response.json() as { events?: AutomationTimelineEvent[]; items?: AutomationTimelineEvent[]; cursor?: string | null; nextCursor?: string | null };
  return { events: body.events ?? body.items ?? [], cursor: body.nextCursor ?? body.cursor ?? cursor };
}

export async function controlSessionAutomation(
  snapshot: SessionAutomationSnapshot,
  request: AutomationControlRequest,
  clientMsgId = createStableClientMsgId(),
): Promise<SessionAutomationSnapshot> {
  let response = await authFetch(`/api/session-automations/${encodeURIComponent(snapshot.automationId)}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMsgId },
    body: JSON.stringify({
      clientMsgId,
      expectedControlVersion: snapshot.controlVersion,
      expectedIncarnationId: snapshot.incarnationId,
      action: request.action,
      payload: request.payload ?? {},
    }),
  });
  if (response.status === 404 && typeof snapshot.sessionId === 'string') {
    if (request.action === 'edit') throw new Error('当前服务端暂不支持编辑自动化，请升级后重试');
    response = await authFetch(`/api/sessions/${encodeURIComponent(snapshot.sessionId)}/automations/${encodeURIComponent(snapshot.automationId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMsgId },
      body: JSON.stringify({
        clientMessageId: clientMsgId,
        expectedControlVersion: snapshot.controlVersion,
        expectedIncarnationId: snapshot.incarnationId,
        action: request.action === 'run_now' ? 'run' : request.action,
      }),
    });
  }
  if (!response.ok) throw await readApiError(response);
  const body = await response.json() as SessionAutomationSnapshot | { automation?: SessionAutomationSnapshot; snapshot?: SessionAutomationSnapshot };
  if ('automationId' in body) return normalizeAutomationSnapshot(body as SessionAutomationSnapshot);
  const next = body.snapshot ?? body.automation;
  if (!next) throw new Error('Automation control response did not include a snapshot');
  return normalizeAutomationSnapshot(next);
}
