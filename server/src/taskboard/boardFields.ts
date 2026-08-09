import {
  TASKBOARD_DEFAULT_PROMPT,
  type TaskBoard,
} from '../../../shared/src/types/taskboard.js';

export function boardPromptMigrationSql(boardsTable: string): string {
  const defaultPrompt = quoteSqlLiteral(TASKBOARD_DEFAULT_PROMPT);
  return `
    ALTER TABLE ${boardsTable}
      ADD COLUMN IF NOT EXISTS prompt TEXT;
    UPDATE ${boardsTable}
      SET prompt=${defaultPrompt}
      WHERE prompt IS NULL;
    ALTER TABLE ${boardsTable}
      ALTER COLUMN prompt SET DEFAULT ${defaultPrompt};
    ALTER TABLE ${boardsTable}
      ALTER COLUMN prompt SET NOT NULL
  `;
}

export function boardModelMigrationSql(boardsTable: string): string {
  return `
    ALTER TABLE ${boardsTable}
      ADD COLUMN IF NOT EXISTS model TEXT
  `;
}

export function normalizeBoardPrompt(value: string): string {
  return value.trim();
}

/** 模型 ref： trim 后为空视为未设置（继承上级默认）。 */
export function normalizeModel(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export function rowToBoard(row: Record<string, unknown>): TaskBoard {
  return {
    id: String(row.id),
    name: String(row.name),
    ...(row.description !== null && row.description !== undefined
      ? { description: String(row.description) }
      : {}),
    prompt: String(row.prompt ?? TASKBOARD_DEFAULT_PROMPT),
    ...(row.model !== null && row.model !== undefined && String(row.model).trim()
      ? { model: String(row.model) }
      : {}),
    version: Number(row.version),
    ...(row.archived_at ? { archivedAt: toIso(row.archived_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
