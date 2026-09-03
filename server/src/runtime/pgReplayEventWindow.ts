import type pg from 'pg';

import {
  projectToolResultSourceForModel,
  TOOL_RESULT_PROJECTION_PREFIX_CHARS,
  TOOL_RESULT_PROJECTION_SUFFIX_CHARS,
} from './replayEventBounds.js';
import { CHECKPOINT_REPLAY_PREFIX_EVENT_TYPES } from './replayEventWindow.js';
import type { EventReplayLoadStats, PlatformEvent } from './types.js';

export interface BoundedReplayRow extends pg.QueryResultRow {
  event_json: PlatformEvent;
  session_sequence?: string;
  stored_bytes?: string | number;
  tool_content_prefix: string | null;
  tool_content_suffix: string | null;
  tool_content_chars: string | number | null;
  tool_content_lines: string | number | null;
}

export async function loadPgCheckpointReplay(input: {
  pool: pg.Pool;
  eventsTable: string;
  tenantId: string;
  sessionId: string;
  excludeTypes: PlatformEvent['type'][];
  onStats?: (stats: EventReplayLoadStats) => void;
}): Promise<PlatformEvent[]> {
  const latestCompaction = await input.pool.query<{
    event_id: string;
    session_sequence: string;
    cutoff_event_id: string | null;
    checkpoint_version: string | null;
  }>(
    `
    SELECT event_id, session_sequence,
           event_json ->> 'cutoffEventId' AS cutoff_event_id,
           event_json -> 'checkpoint' ->> 'version' AS checkpoint_version
    FROM ${input.eventsTable}
    WHERE tenant_id = $1 AND session_id = $2 AND event_type = 'compaction'
    ORDER BY session_sequence DESC
    LIMIT 1
  `,
    [input.tenantId, input.sessionId],
  );
  const checkpoint = latestCompaction.rows[0];
  let cutoffSequence: number | undefined;
  if (checkpoint?.checkpoint_version === '1') {
    cutoffSequence = Number(checkpoint.session_sequence);
    if (checkpoint.cutoff_event_id) {
      const cutoff = await input.pool.query<{ session_sequence: string }>(
        `
        SELECT session_sequence
        FROM ${input.eventsTable}
        WHERE tenant_id = $1 AND session_id = $2 AND event_id = $3
          AND session_sequence <= $4
        LIMIT 1
      `,
        [input.tenantId, input.sessionId, checkpoint.cutoff_event_id, cutoffSequence],
      );
      cutoffSequence = Number(cutoff.rows[0]?.session_sequence);
    }
    if (!Number.isFinite(cutoffSequence)) cutoffSequence = undefined;
  }

  const statsPromise = input.onStats
    ? input.pool.query<{
        total_event_count: string;
        total_stored_bytes: string;
      }>(
        `
        SELECT COUNT(*) AS total_event_count,
               COALESCE(SUM(pg_column_size(event_json)), 0) AS total_stored_bytes
        FROM ${input.eventsTable}
        WHERE tenant_id = $1 AND session_id = $2
          AND event_type <> ALL($3::text[])
      `,
        [input.tenantId, input.sessionId, input.excludeTypes],
      )
    : Promise.resolve({ rows: [] });
  const windowClause =
    cutoffSequence === undefined
      ? ''
      : 'AND (session_sequence >= $7 OR event_type = ANY($8::text[]))';
  const params: unknown[] = [
    input.tenantId,
    input.sessionId,
    input.excludeTypes,
    TOOL_RESULT_PROJECTION_PREFIX_CHARS,
    TOOL_RESULT_PROJECTION_SUFFIX_CHARS,
    input.onStats !== undefined,
  ];
  if (cutoffSequence !== undefined) {
    params.push(cutoffSequence, CHECKPOINT_REPLAY_PREFIX_EVENT_TYPES);
  }
  const selectedPromise = input.pool.query<BoundedReplayRow>(
    `
    SELECT CASE
             WHEN event_type = 'tool_result' AND jsonb_typeof(event_json -> 'content') = 'string'
             THEN event_json - 'content' - 'modelContent' ELSE event_json
           END AS event_json,
           session_sequence,
           CASE WHEN $6::boolean THEN pg_column_size(event_json) ELSE 0 END AS stored_bytes,
           CASE WHEN event_type = 'tool_result' AND jsonb_typeof(event_json -> 'content') = 'string'
             THEN left(event_json ->> 'content', $4::integer) ELSE NULL END AS tool_content_prefix,
           CASE WHEN event_type = 'tool_result' AND jsonb_typeof(event_json -> 'content') = 'string'
             THEN right(event_json ->> 'content', $5::integer) ELSE NULL END AS tool_content_suffix,
           CASE WHEN event_type = 'tool_result' AND jsonb_typeof(event_json -> 'content') = 'string'
             THEN char_length(event_json ->> 'content') ELSE NULL END AS tool_content_chars,
           CASE WHEN event_type = 'tool_result' AND jsonb_typeof(event_json -> 'content') = 'string'
             THEN 1 + char_length(event_json ->> 'content')
               - char_length(replace(event_json ->> 'content', E'\\n', '')) ELSE NULL END AS tool_content_lines
    FROM ${input.eventsTable}
    WHERE tenant_id = $1 AND session_id = $2
      AND event_type <> ALL($3::text[])
      ${windowClause}
    ORDER BY session_sequence ASC
  `,
    params,
  );
  const [statsResult, selectedResult] = await Promise.all([statsPromise, selectedPromise]);
  const events = selectedResult.rows.map(projectBoundedReplayRow);
  const stats = statsResult.rows[0];
  const cursor = selectedResult.rows.at(-1)?.session_sequence;
  const prefixEventCount =
    cutoffSequence === undefined
      ? 0
      : selectedResult.rows.filter((row) => Number(row.session_sequence) < cutoffSequence!).length;
  input.onStats?.({
    strategy: cutoffSequence === undefined ? 'full' : 'checkpoint',
    totalEventCount: Number(stats?.total_event_count ?? events.length),
    selectedEventCount: events.length,
    totalStoredBytes: Number(stats?.total_stored_bytes ?? 0),
    selectedStoredBytes: selectedResult.rows.reduce(
      (total, row) => total + Number(row.stored_bytes ?? 0),
      0,
    ),
    selectedProjectedBytes: events.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
      0,
    ),
    // The stats query runs concurrently and may observe a later append. Advancing to
    // its MAX(sequence) could skip that event, so the replay cursor must come from
    // the rows actually returned by the selected query.
    ...(cursor ? { cursor } : {}),
    ...(cutoffSequence !== undefined && checkpoint
      ? { checkpointEventId: checkpoint.event_id }
      : {}),
    ...(cutoffSequence !== undefined ? { cutoffSequence } : {}),
    prefixEventCount,
    tailEventCount: events.length - prefixEventCount,
  });
  return events;
}

export function projectBoundedReplayRow(row: BoundedReplayRow): PlatformEvent {
  const event = normalizeEventJson(row.event_json);
  if (
    event.type !== 'tool_result' ||
    typeof row.tool_content_prefix !== 'string' ||
    typeof row.tool_content_suffix !== 'string' ||
    row.tool_content_chars == null ||
    row.tool_content_lines == null
  )
    return event;
  return {
    ...event,
    content: projectToolResultSourceForModel(
      {
        prefix: row.tool_content_prefix,
        suffix: row.tool_content_suffix,
        totalChars: Number(row.tool_content_chars),
        totalLines: Number(row.tool_content_lines),
      },
      event.toolCallId,
    ),
  };
}

function normalizeEventJson(raw: PlatformEvent | string): PlatformEvent {
  return typeof raw === 'string' ? (JSON.parse(raw) as PlatformEvent) : raw;
}
