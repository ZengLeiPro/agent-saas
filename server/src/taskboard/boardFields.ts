import {
  TASKBOARD_DEFAULT_PROMPT,
  type TaskBoard,
} from '../../../shared/src/types/taskboard.js';

const LEGACY_TASKBOARD_DEFAULT_PROMPT = [
  '1. 直接完成任务，必要时使用可用工具；不要只给计划。',
  '2. 尊重当前工作区与安全边界，不 push、不部署、不对外发送，除非任务正文明确授权。',
  '3. 完成后自行检查结果。你的最终回复将作为任务的 Agent 交付回执。',
  '4. 不要自行把任务标记为“已完成”；系统只会将成功结果送到“待复核”，由用户验收。',
].join('\n');

export function boardPromptMigrationSql(boardsTable: string): string {
  const defaultPrompt = quoteSqlLiteral(TASKBOARD_DEFAULT_PROMPT);
  const legacyPrompt = quoteSqlLiteral(LEGACY_TASKBOARD_DEFAULT_PROMPT);
  return `
    ALTER TABLE ${boardsTable}
      ADD COLUMN IF NOT EXISTS prompt TEXT;
    UPDATE ${boardsTable}
      SET prompt=${defaultPrompt}
      WHERE prompt IS NULL OR prompt=${legacyPrompt};
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

export function boardVisibilityMigrationSql(boardsTable: string): string {
  return `
    ALTER TABLE ${boardsTable}
      ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'personal';
    ALTER TABLE ${boardsTable}
      DROP CONSTRAINT IF EXISTS ${boardsTable}_visibility_check;
    ALTER TABLE ${boardsTable}
      ADD CONSTRAINT ${boardsTable}_visibility_check
      CHECK (visibility IN ('personal', 'organization'))
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

export function rowToBoard(row: Record<string, unknown>, currentUserId: string): TaskBoard {
  const ownerUserId = String(row.owner_user_id);
  return {
    id: String(row.id),
    name: String(row.name),
    ...(row.description !== null && row.description !== undefined
      ? { description: String(row.description) }
      : {}),
    visibility: row.visibility === 'organization' ? 'organization' : 'personal',
    ownerUserId,
    canManage: ownerUserId === currentUserId,
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
