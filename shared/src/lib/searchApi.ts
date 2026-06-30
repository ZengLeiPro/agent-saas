import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';
import type { SessionSearchResponse } from '../types/search';

export interface SearchSessionsParams {
  q: string;
  limit?: number;
  cursor?: string;
}

export async function searchSessions(
  params: SearchSessionsParams,
): Promise<SessionSearchResponse> {
  const query = new URLSearchParams({ q: params.q });
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);

  const res = await authFetch(`/api/search/sessions?${query.toString()}`);
  return parseJsonResponse<SessionSearchResponse>(res, '会话搜索');
}
