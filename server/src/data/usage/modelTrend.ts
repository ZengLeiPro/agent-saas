import type { DatabaseSync } from 'node:sqlite';

import { computeUsageTotalTokens } from './pricing.js';
import type { ModelFamily } from './store.js';

export interface ModelAggregate {
  model: string;
  totalTokens: number;
  totalCostUsd: number;
  totalTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelTrendPoint {
  date: string;
  models: ModelAggregate[];
}

type QueryParam = string | number | null;

type RangeSource = (from: string, to: string) => {
  table: 'token_usage_daily' | 'token_usage_minutely';
  column: 'date' | 'minute';
  from: string;
  to: string;
};

type AggregateSqlRow = (row: Record<string, unknown>) => {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdMicro: number;
  turns: number;
};

const DATE_OR_MINUTE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function beijingDateStartMs(value: string): number | null {
  const match = DATE_OR_MINUTE_RE.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText]
    .map(part => Number(part ?? 0));
  if (hour > 23 || minute > 59) return null;

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.getTime();
}

function enumerateBeijingDates(from: string, to: string): string[] {
  const fromMs = beijingDateStartMs(from);
  const toMs = beijingDateStartMs(to);
  if (fromMs === null || toMs === null || fromMs > toMs) return [];

  const dates: string[] = [];
  for (let dateMs = fromMs; dateMs <= toMs; dateMs += DAY_MS) {
    dates.push(new Date(dateMs).toISOString().slice(0, 10));
  }
  return dates;
}

export function createModelTrendQuery(
  db: DatabaseSync,
  rangeSource: RangeSource,
  familyClause: (family?: ModelFamily) => string,
  tenantClause: (tenantId: string | undefined, params: QueryParam[]) => string,
  aggregateSqlRow: AggregateSqlRow,
): (
  fromDate: string,
  toDate: string,
  username?: string,
  family?: ModelFamily,
  tenantId?: string,
) => ModelTrendPoint[] {
  return function getTrendByModel(fromDate, toDate, username, family, tenantId) {
    const src = rangeSource(fromDate, toDate);
    const params: QueryParam[] = [src.from, src.to];
    if (username) params.push(username);
    const userClause = username ? ' AND username = ?' : '';
    const tClause = tenantClause(tenantId, params);
    const rows = db.prepare(`
      SELECT
        date,
        model,
        SUM(input_tokens)          AS in_tok,
        SUM(output_tokens)         AS out_tok,
        SUM(cache_read_tokens)     AS cr_tok,
        SUM(cache_creation_tokens) AS cc_tok,
        SUM(cost_usd_micro)        AS cost_micro,
        SUM(turn_count)            AS turns
      FROM ${src.table}
      WHERE ${src.column} >= ? AND ${src.column} <= ?${userClause}${familyClause(family)}${tClause}
      GROUP BY date, model
      ORDER BY date ASC
    `).all(...params) as Record<string, unknown>[];

    const byDate = new Map<string, ModelAggregate[]>();
    for (const rawRow of rows) {
      const row = aggregateSqlRow(rawRow);
      const tokens = {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
      };
      const date = rawRow.date as string;
      const models = byDate.get(date) ?? [];
      models.push({
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        totalTokens: computeUsageTotalTokens(row.model, tokens),
        totalCostUsd: row.costUsdMicro / 1e6,
        totalTurns: row.turns,
      });
      byDate.set(date, models);
    }

    return enumerateBeijingDates(fromDate, toDate).map(date => ({
      date,
      models: (byDate.get(date) ?? []).sort((a, b) => b.totalTokens - a.totalTokens),
    }));
  };
}
