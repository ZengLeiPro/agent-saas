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

    return Array.from(byDate, ([date, models]) => ({
      date,
      models: models.sort((a, b) => b.totalTokens - a.totalTokens),
    })).sort((a, b) => a.date.localeCompare(b.date));
  };
}
