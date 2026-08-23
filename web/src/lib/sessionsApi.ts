export type {
  ApiSessionListItem,
  ApiSessionDetail,
  TokenUsage,
  ApiTranscriptBlock,
  SessionSearchMatchKind,
  SessionSearchMatchRange,
  SessionSearchMatch,
  SessionSearchHit,
  SessionSearchResponse,
  SearchSessionsParams,
} from '@agent/shared';
export { formatTokenCount, searchSessions } from '@agent/shared';

import { authFetch } from '@/lib/authFetch';

export async function warmupSessionSandbox(sessionId: string): Promise<void> {
  const response = await authFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/warmup`,
    { method: 'POST' },
  );
  if (!response.ok) throw new Error(`Sandbox warmup failed: HTTP ${response.status}`);
}
