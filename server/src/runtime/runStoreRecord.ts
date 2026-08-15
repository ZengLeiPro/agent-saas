import type { RunRecord } from './runStore.js';

type PersistedRunState = Pick<
  RunRecord,
  | 'sandboxScopeId'
  | 'metadata'
  | 'lastResponseId'
  | 'lastResponseExpireAt'
  | 'actualModelSeen'
  | 'lastResponseModel'
  | 'lastResponseProfileDigest'
  | 'cumulativeInputTokens'
>;

export function normalizeRunPersistenceState(raw: any): PersistedRunState {
  return {
    sandboxScopeId: raw.sandbox_scope_id ?? raw.sandboxScopeId ?? undefined,
    metadata: raw.metadata ?? {},
    lastResponseId: raw.last_response_id ?? raw.lastResponseId ?? undefined,
    lastResponseExpireAt: raw.last_response_expire_at
      ? new Date(raw.last_response_expire_at).toISOString()
      : raw.lastResponseExpireAt ?? undefined,
    actualModelSeen: raw.actual_model_seen ?? raw.actualModelSeen ?? undefined,
    lastResponseModel: raw.last_response_model ?? raw.lastResponseModel ?? undefined,
    lastResponseProfileDigest: raw.last_response_profile_digest ?? raw.lastResponseProfileDigest ?? undefined,
    cumulativeInputTokens: (() => {
      const value = raw.cumulative_input_tokens ?? raw.cumulativeInputTokens;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
      return undefined;
    })(),
  };
}
