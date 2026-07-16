import { z } from 'zod';

import { loadToolDescription } from '../agent/tools/descriptionLoader.js';
import type { AuthorizedToolCall, ToolCallContext, ToolDescriptor, ToolProvider, ToolResult } from '../agent/toolRuntime.js';
import {
  INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES,
  isInternalModelDiagnosticEvent,
  type EventListPage,
  type EventStore,
  type PlatformEvent,
} from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SEARCH_RESULTS = 50;

export interface EventQuery {
  afterCursor?: string;
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
}

export interface SearchOptions {
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
}

/**
 * Session-as-context read model over the durable runtime event log.
 *
 * This service deliberately treats summaries, prompts, and UI projections as disposable views:
 * every method reads the append-only EventStore source of truth and returns raw PlatformEvents.
 */
export class SessionContextService {
  constructor(private readonly eventStore: EventStore) {}

  async getEvents(sessionId: string, opts: EventQuery = {}): Promise<EventListPage> {
    if (isInternalDiagnosticType(opts.type)) return { events: [], hasMore: false };
    const limit = clampLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (this.eventStore.listPage) {
      const page = await this.eventStore.listPage(sessionId, {
        afterCursor: opts.afterCursor,
        limit,
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        excludeTypes: [...INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES],
      });
      return { ...page, events: page.events.filter((event) => !isInternalModelDiagnosticEvent(event)) };
    }

    const all = await this.eventStore.list(sessionId);
    const filtered = filterEvents(all, opts).filter((event) => !isInternalModelDiagnosticEvent(event));
    return fallbackPage(filtered, opts.afterCursor, limit);
  }

  async getEventsAround(sessionId: string, eventId: string, before: number, after: number): Promise<PlatformEvent[]> {
    if (this.eventStore.listAround) {
      return (await this.eventStore.listAround(sessionId, eventId, { before, after }))
        .filter((event) => !isInternalModelDiagnosticEvent(event));
    }
    const events = await this.eventStore.list(sessionId);
    const index = events.findIndex((event) => event.id === eventId);
    if (index < 0) return [];
    const start = Math.max(0, index - Math.max(0, before));
    const end = Math.min(events.length, index + Math.max(0, after) + 1);
    return events.slice(start, end).filter((event) => !isInternalModelDiagnosticEvent(event));
  }

  async getRunEvents(sessionId: string, runId: string): Promise<PlatformEvent[]> {
    if (this.eventStore.listByRun) {
      return (await this.eventStore.listByRun(sessionId, runId))
        .filter((event) => !isInternalModelDiagnosticEvent(event));
    }
    return (await this.eventStore.list(sessionId)).filter((event) => (
      !isInternalModelDiagnosticEvent(event) && 'runId' in event && event.runId === runId
    ));
  }

  async getToolTrace(sessionId: string, toolCallId: string): Promise<PlatformEvent[]> {
    if (this.eventStore.listByToolCall) return this.eventStore.listByToolCall(sessionId, toolCallId);
    return (await this.eventStore.list(sessionId)).filter((event) => eventReferencesToolCall(event, toolCallId));
  }

  async searchEvents(sessionId: string, query: string, opts: SearchOptions = {}): Promise<PlatformEvent[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const limit = clampLimit(opts.limit, DEFAULT_LIMIT, MAX_SEARCH_RESULTS);
    if (this.eventStore.search) {
      return (await this.eventStore.search(sessionId, query, {
        limit,
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        excludeTypes: [...INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES],
      })).filter((event) => !isInternalModelDiagnosticEvent(event));
    }
    const filtered = filterEvents(await this.eventStore.list(sessionId), opts);
    return filtered
      .filter((event) => !isInternalModelDiagnosticEvent(event))
      .filter((event) => JSON.stringify(event).toLowerCase().includes(needle))
      .slice(0, limit);
  }
}

function isInternalDiagnosticType(type: PlatformEvent['type'] | undefined): boolean {
  if (!type) return false;
  return type === 'model_request_started'
    || type === 'model_request_checkpoint'
    || type === 'model_request_finished';
}

type SessionGetEventsInput = {
  afterCursor?: string;
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
};

type SessionSearchEventsInput = {
  query: string;
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
};

type SessionGetToolTraceInput = {
  toolCallId: string;
};

export const sessionGetEventsToolDescriptor: ToolDescriptor<SessionGetEventsInput> = {
  id: 'SessionGetEvents',
  name: 'SessionGetEvents',
  displayName: 'Session Get Events',
  description: loadToolDescription('SessionGetEvents'),
  schema: z.object({
    afterCursor: z.string().optional(),
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    runId: z.string().optional(),
    type: z.string().optional(),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'session.context',
};

export const sessionSearchEventsToolDescriptor: ToolDescriptor<SessionSearchEventsInput> = {
  id: 'SessionSearchEvents',
  name: 'SessionSearchEvents',
  displayName: 'Session Search Events',
  description: loadToolDescription('SessionSearchEvents'),
  schema: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(),
    runId: z.string().optional(),
    type: z.string().optional(),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'session.context.search',
};

export const sessionGetToolTraceToolDescriptor: ToolDescriptor<SessionGetToolTraceInput> = {
  id: 'SessionGetToolTrace',
  name: 'SessionGetToolTrace',
  displayName: 'Session Get Tool Trace',
  description: loadToolDescription('SessionGetToolTrace'),
  schema: z.object({
    toolCallId: z.string().min(1),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'session.context.tool_trace',
};

export class SessionToolProvider implements ToolProvider {
  constructor(private readonly contextService: SessionContextService) {}

  list(): ToolDescriptor[] {
    return [sessionGetEventsToolDescriptor, sessionSearchEventsToolDescriptor, sessionGetToolTraceToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    const sessionId = context.workspace.sessionId;
    if (!sessionId) throw new Error('Session context tools require workspace.sessionId.');

    if (call.toolId === sessionGetEventsToolDescriptor.id) {
      const input = sessionGetEventsToolDescriptor.schema.parse(call.input) as SessionGetEventsInput;
      return { content: JSON.stringify(await this.contextService.getEvents(sessionId, input), null, 2) };
    }
    if (call.toolId === sessionSearchEventsToolDescriptor.id) {
      const input = sessionSearchEventsToolDescriptor.schema.parse(call.input) as SessionSearchEventsInput;
      return { content: JSON.stringify(await this.contextService.searchEvents(sessionId, input.query, input), null, 2) };
    }
    if (call.toolId === sessionGetToolTraceToolDescriptor.id) {
      const input = sessionGetToolTraceToolDescriptor.schema.parse(call.input) as SessionGetToolTraceInput;
      return { content: JSON.stringify(await this.contextService.getToolTrace(sessionId, input.toolCallId), null, 2) };
    }
    return undefined;
  }
}

function filterEvents(events: PlatformEvent[], opts: { runId?: string; type?: PlatformEvent['type'] }): PlatformEvent[] {
  return events.filter((event) => {
    if (opts.runId && (!('runId' in event) || event.runId !== opts.runId)) return false;
    if (opts.type && event.type !== opts.type) return false;
    return true;
  });
}

function eventReferencesToolCall(event: PlatformEvent, toolCallId: string): boolean {
  if ('toolCallId' in event && event.toolCallId === toolCallId) return true;
  return event.type === 'assistant_tool_calls' && event.toolCalls.some((call) => call.id === toolCallId);
}

function fallbackPage(events: PlatformEvent[], afterCursor: string | undefined, limit: number): EventListPage {
  const offset = parseCursor(afterCursor);
  const page = events.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    events: page,
    ...(nextOffset < events.length ? { nextCursor: String(nextOffset) } : {}),
    hasMore: nextOffset < events.length,
  };
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!value || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}
