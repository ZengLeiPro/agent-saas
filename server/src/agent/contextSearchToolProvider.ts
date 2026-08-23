import { z } from 'zod';

import type {
  ContextRecallHit,
  ContextRecallResolvedScope,
  ContextRecallSearchFilters,
  ContextRecallService,
  ContextRecallScopeResolver,
  ContextRecallSubject,
} from '../context/retrieval/index.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

const DEFAULT_CONTEXT_LIMIT = 10;
const MAX_CONTEXT_LIMIT = 50;
const MAX_FILTER_VALUES = 20;

// 用 refine 而非 regex：regex 会被 toJSONSchema() 展开成 pattern，而 OpenAI 的
// 工具 schema 校验器不支持 Unicode property escapes（\p{L}），整份 tools 会被
// 拒为 invalid_function_parameters。refine 不进 JSON Schema，服务端校验强度不变。
const FILTER_VALUE_PATTERN = /^[\p{L}\p{N}_.:/-]+$/u;
const filterValueSchema = z.string().trim().min(1).max(128)
  .refine(value => FILTER_VALUE_PATTERN.test(value), 'filter values must match [\\p{L}\\p{N}_.:/-]+');
const filterListSchema = z.array(filterValueSchema).min(1).max(MAX_FILTER_VALUES)
  .refine(values => new Set(values).size === values.length, 'filter values must be unique');
const isoTimeSchema = z.string().datetime({ offset: true });
const timeRangeSchema = z.object({
  from: isoTimeSchema.optional().describe('Inclusive ISO-8601 lower bound.'),
  to: isoTimeSchema.optional().describe('Exclusive ISO-8601 upper bound.'),
}).strict().refine(value => value.from || value.to, 'timeRange requires from or to')
  .refine(value => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to), 'timeRange.from must be before timeRange.to');

const contextSearchSchema = z.object({
  query: z.string().trim().min(1).max(2_000).describe('Natural-language recall query.'),
  limit: z.number().int().min(1).max(MAX_CONTEXT_LIMIT).optional().describe('Maximum hits; default 10, maximum 50.'),
  timeRange: timeRangeSchema.optional().describe('Optional source-time range.'),
  kinds: filterListSchema.optional().describe('Optional record-kind filters.'),
  sources: filterListSchema.optional().describe('Optional source ID/kind filters.'),
}).strict();

type ContextSearchInput = z.infer<typeof contextSearchSchema>;

const contextGetSchema = z.object({
  id: z.string().trim().min(1).max(512).describe('Opaque hit id returned by ContextSearch.'),
}).strict();

type ContextGetInput = z.infer<typeof contextGetSchema>;

export const contextSearchToolDescriptor: ToolDescriptor<ContextSearchInput> = {
  id: 'ContextSearch',
  name: 'ContextSearch',
  displayName: 'Context Search',
  description: 'Search authenticated organizational context. Identity and collection scope are resolved only by the server. When an answer uses a hit, copy its citationMarker verbatim into the answer so the user can reopen the evidence.',
  schema: contextSearchSchema,
  risk: 'safe',
  approvalMode: 'never',
  concurrency: 'parallel',
  auditCategory: 'context.search',
  category: 'memory',
  label: '搜索组织上下文',
};

export const contextGetToolDescriptor: ToolDescriptor<ContextGetInput> = {
  id: 'ContextGet',
  name: 'ContextGet',
  displayName: 'Context Get',
  description: 'Fetch one ContextSearch hit. The opaque id grants no access; the server freshly reauthorizes collection assignments on every call.',
  schema: contextGetSchema,
  risk: 'safe',
  approvalMode: 'never',
  concurrency: 'parallel',
  auditCategory: 'context.get',
  category: 'memory',
  label: '读取组织上下文',
};

export type ContextRecallAuthorizationErrorCode =
  | 'CONTEXT_RECALL_UNAUTHENTICATED'
  | 'CONTEXT_RECALL_SUBJECT_MISMATCH'
  | 'CONTEXT_RECALL_EMPTY_SCOPE'
  | 'CONTEXT_RECALL_HIT_OUT_OF_SCOPE';

export class ContextRecallAuthorizationError extends Error {
  constructor(readonly code: ContextRecallAuthorizationErrorCode) {
    super(code);
    this.name = 'ContextRecallAuthorizationError';
  }
}

export class ContextSearchToolProvider implements ToolProvider {
  constructor(
    private readonly recall: ContextRecallService,
    private readonly scopes: ContextRecallScopeResolver,
  ) {}

  list(): ToolDescriptor[] {
    return [contextSearchToolDescriptor, contextGetToolDescriptor];
  }

  async invoke<TInput>(
    call: AuthorizedToolCall<TInput>,
    context: ToolCallContext,
  ): Promise<ToolResult | undefined> {
    if (call.toolId === contextSearchToolDescriptor.id) {
      const input = contextSearchSchema.parse(call.input);
      const subject = resolveContextRecallSubject(context);
      const scope = await this.resolveNonEmptyScope(subject, { operation: 'search' });
      const filters: ContextRecallSearchFilters = {
        ...(input.timeRange ? { timeRange: input.timeRange } : {}),
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.sources ? { sources: input.sources } : {}),
      };
      const result = await this.recall.search({
        subject,
        scope,
        query: input.query,
        limit: input.limit ?? DEFAULT_CONTEXT_LIMIT,
        filters,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      result.hits.forEach(hit => assertHitAuthorized(hit, scope));
      const degradation = mergeDegradation(scope, result);
      return {
        content: JSON.stringify({
          hits: result.hits.map(formatHit),
          degraded: degradation.degraded,
          degradationReasons: degradation.reasons,
        }),
      };
    }

    if (call.toolId === contextGetToolDescriptor.id) {
      const input = contextGetSchema.parse(call.input);
      const subject = resolveContextRecallSubject(context);
      // Deliberately resolve again here; a prior search scope is never reused as authority.
      const scope = await this.resolveNonEmptyScope(subject, { operation: 'get', recallId: input.id });
      const result = await this.recall.get({
        subject,
        id: input.id,
        scope,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (result.hit) assertHitAuthorized(result.hit, scope);
      const degradation = mergeDegradation(scope, result);
      return {
        content: JSON.stringify({
          found: result.hit !== null,
          hit: result.hit ? formatHit(result.hit) : null,
          degraded: degradation.degraded,
          degradationReasons: degradation.reasons,
        }),
      };
    }

    return undefined;
  }

  private async resolveNonEmptyScope(
    subject: ContextRecallSubject,
    request: Parameters<ContextRecallScopeResolver['resolve']>[1],
  ): Promise<ContextRecallResolvedScope> {
    const scope = await this.scopes.resolve(subject, request);
    if (scope.collections.length === 0) {
      throw new ContextRecallAuthorizationError('CONTEXT_RECALL_EMPTY_SCOPE');
    }
    return scope;
  }
}

type ExtendedToolCallContext = ToolCallContext & {
  orgAgentId?: unknown;
  orgAgent?: { id?: unknown };
  session?: { id?: unknown; orgAgentId?: unknown };
};

/** Resolves identity only from trusted runtime context, never from tool input. */
export function resolveContextRecallSubject(context: ToolCallContext): ContextRecallSubject {
  const identity = context.channelContext.sessionOwner ?? context.channelContext.user;
  if (!identity?.id?.trim()) {
    throw new ContextRecallAuthorizationError('CONTEXT_RECALL_UNAUTHENTICATED');
  }

  const identityTenantId = identity.tenantId?.trim();
  const workspaceTenantId = context.workspace.tenantId?.trim();
  if (identityTenantId && workspaceTenantId && identityTenantId !== workspaceTenantId) {
    throw new ContextRecallAuthorizationError('CONTEXT_RECALL_SUBJECT_MISMATCH');
  }
  if (context.workspace.userId && context.workspace.userId !== identity.id) {
    throw new ContextRecallAuthorizationError('CONTEXT_RECALL_SUBJECT_MISMATCH');
  }
  const tenantId = identityTenantId ?? workspaceTenantId;
  if (!tenantId) {
    throw new ContextRecallAuthorizationError('CONTEXT_RECALL_UNAUTHENTICATED');
  }

  const extended = context as ExtendedToolCallContext;
  const workspaceId = optionalTrustedString(context.workspace.id);
  const sessionId = optionalTrustedString(context.sessionId)
    ?? optionalTrustedString(extended.session?.id)
    ?? optionalTrustedString(context.workspace.sessionId);
  const orgAgentId = optionalTrustedString(extended.orgAgentId)
    ?? optionalTrustedString(extended.orgAgent?.id)
    ?? optionalTrustedString(extended.session?.orgAgentId);

  return {
    tenantId,
    userId: identity.id,
    ...(workspaceId ? { workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(orgAgentId ? { orgAgentId } : {}),
  };
}

function optionalTrustedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function assertHitAuthorized(hit: ContextRecallHit, scope: ContextRecallResolvedScope): void {
  const authorized = scope.collections.some(collection => (
    collection.collectionId === hit.collectionId
    && collection.assignmentVersion === hit.assignmentVersion
  ));
  if (!authorized) {
    throw new ContextRecallAuthorizationError('CONTEXT_RECALL_HIT_OUT_OF_SCOPE');
  }
}

function formatHit(hit: ContextRecallHit): Record<string, unknown> {
  const citationLabel = hit.source.displayName?.trim() || hit.source.kind || hit.kind;
  return {
    id: hit.id,
    citationMarker: `[CITE]${JSON.stringify({ contextId: hit.id, label: citationLabel })}[/CITE]`,
    collectionId: hit.collectionId,
    assignmentVersion: hit.assignmentVersion,
    kind: hit.kind,
    content: hit.content,
    ...(hit.score !== undefined ? { score: hit.score } : {}),
    source: hit.source,
    time: hit.time,
    freshness: hit.freshness,
    route: hit.route,
    derived: hit.derived,
    evidence: hit.evidence,
  };
}

function mergeDegradation(
  scope: ContextRecallResolvedScope,
  result: { degraded: boolean; degradationReasons?: readonly string[] },
): { degraded: boolean; reasons: string[] } {
  const reasons = [...new Set([
    ...(scope.degradationReasons ?? []),
    ...(result.degradationReasons ?? []),
  ])];
  const degraded = scope.degraded === true || result.degraded;
  if (degraded && reasons.length === 0) reasons.push('unspecified_degradation');
  return { degraded, reasons };
}
