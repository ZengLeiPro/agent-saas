import type {
  ContextRecallGetRequest,
  ContextRecallGetResult,
  ContextRecallResolvedScope,
  ContextRecallSearchRequest,
  ContextRecallSearchResult,
  ContextRecallSubject,
} from './types.js';

/** Retrieval backend boundary. Implementations may use FTS/vector/hybrid search. */
export interface ContextRecallService {
  search(request: ContextRecallSearchRequest): Promise<ContextRecallSearchResult>;
  get(request: ContextRecallGetRequest): Promise<ContextRecallGetResult>;
}

export interface ContextRecallScopeRequest {
  operation: 'search' | 'get';
  /** Opaque id is diagnostic/routing data only and must never grant access. */
  recallId?: string;
}

/** Server-side authorization resolver; implementations must not accept model-supplied identity. */
export interface ContextRecallScopeResolver {
  resolve(
    subject: ContextRecallSubject,
    request: ContextRecallScopeRequest,
  ): Promise<ContextRecallResolvedScope>;
}
