import {
  TASKBOARD_ALLOWED_ACTIONS,
  TASKBOARD_DEFAULT_PROMPT,
  TASKBOARD_EXECUTION_PURPOSES,
  type TaskBoard,
  type TaskBoardAllowedAction,
  type TaskBoardExecutionPurpose,
  type TaskBoardIntegrationPolicy,
  type TaskBoardMemberRole,
  type TaskBoardRepositoryConfig,
  type TaskBoardStageModels,
  type TaskBoardStagePrompts,
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

export function boardStageModelsMigrationSql(boardsTable: string): string {
  return `
    ALTER TABLE ${boardsTable}
      ADD COLUMN IF NOT EXISTS stage_models JSONB NOT NULL DEFAULT '{}'::jsonb
  `;
}

export function boardStagePromptsMigrationSql(boardsTable: string): string {
  return `
    ALTER TABLE ${boardsTable}
      ADD COLUMN IF NOT EXISTS stage_prompts JSONB NOT NULL DEFAULT '{}'::jsonb
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

export function boardIntegrationMigrationSql(boardsTable: string): string {
  return `
    ALTER TABLE ${boardsTable} ADD COLUMN IF NOT EXISTS repository JSONB;
    ALTER TABLE ${boardsTable} ADD COLUMN IF NOT EXISTS integration_policy JSONB;
    ALTER TABLE ${boardsTable} ADD COLUMN IF NOT EXISTS integration_next_run_at TIMESTAMPTZ
  `;
}

export function normalizeRepositoryConfig(
  repository: TaskBoardRepositoryConfig | null | undefined,
  tenantId?: string,
): TaskBoardRepositoryConfig | null | undefined {
  if (!repository) return repository;
  const owner = repository.owner.trim();
  const name = repository.name.trim();
  return {
    ...repository,
    owner,
    name,
    baseBranch: repository.baseBranch.trim(),
    repositoryId: `github:${tenantId ? `${tenantId}:` : ''}${owner.toLowerCase()}/${name.toLowerCase()}`,
    allowForkPullRequest: false,
  };
}

export function normalizeBoardPrompt(value: string): string {
  return value.trim();
}

/**
 * 归一化各阶段提示语：只保留非空白字符串的阶段配置，其余阶段视为未覆盖（执行时回退系统固定模板）。
 * 传入 null/undefined 表示整体清除（全部回退系统固定模板）。
 */
export function normalizeStagePrompts(
  value: TaskBoardStagePrompts | null | undefined,
): TaskBoardStagePrompts {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    TASKBOARD_EXECUTION_PURPOSES.flatMap((purpose) => {
      const content = value[purpose];
      const normalized = typeof content === 'string' ? content.trim() : '';
      return normalized ? [[purpose, normalized] as const] : [];
    }),
  );
}

export function stagePromptsToJson(value: TaskBoardStagePrompts | null | undefined): string {
  return JSON.stringify(normalizeStagePrompts(value));
}

/** 模型 ref： trim 后为空视为未设置（继承上级默认）。 */
export function normalizeModel(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

/**
 * 归一化各阶段默认模型：只保留三阶段中 trim 后非空的模型 ref，其余阶段视为未配置
 * （执行时回退看板全局模型/组织默认模型）。null/undefined 表示整体未设置。
 */
export function normalizeStageModels(
  value: TaskBoardStageModels | null | undefined,
): TaskBoardStageModels {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    TASKBOARD_EXECUTION_PURPOSES.flatMap((purpose) => {
      const ref = value[purpose];
      const normalized = typeof ref === 'string' ? ref.trim() : '';
      return normalized ? [[purpose, normalized] as const] : [];
    }),
  );
}

export function stageModelsToJson(value: TaskBoardStageModels | null | undefined): string {
  return JSON.stringify(normalizeStageModels(value));
}

export function appendModelAssignments(
  params: unknown[],
  assignments: string[],
  model: string | null | undefined,
  stageModels: TaskBoardStageModels | null | undefined,
): void {
  if (stageModels !== undefined) {
    params.push(null, stageModelsToJson(stageModels));
    assignments.push(
      `model=$${params.length - 1}`,
      `stage_models=$${params.length}::jsonb`,
    );
  } else if (model !== undefined) {
    params.push(normalizeModel(model));
    assignments.push(`model=$${params.length}`);
  }
}

export function parseStageModels(value: unknown): TaskBoardStageModels {
  const parsed = parseJsonObject<Record<string, unknown>>(value);
  if (!parsed) return {};
  return normalizeStageModels({
    ...(typeof parsed.work === 'string' ? { work: parsed.work } : {}),
    ...(typeof parsed.review === 'string' ? { review: parsed.review } : {}),
    ...(typeof parsed.merge === 'string' ? { merge: parsed.merge } : {}),
  });
}

export function rowToBoard(row: Record<string, unknown>, currentUserId: string): TaskBoard {
  const ownerUserId = String(row.owner_user_id);
  const role = resolveBoardRole(row, currentUserId);
  const repository = parseJsonObject<TaskBoardRepositoryConfig>(row.repository);
  const storedIntegrationPolicy = parseJsonObject<TaskBoardIntegrationPolicy & { featureFlags?: unknown }>(row.integration_policy);
  const integrationPolicy = storedIntegrationPolicy ? (() => {
    const { featureFlags: _ignored, ...policy } = storedIntegrationPolicy;
    return { ...policy, workflowVersion: 3 as const };
  })() : undefined;
  const stageModels = parseStageModels(row.stage_models);
  const stagePrompts = parseStagePrompts(row.stage_prompts);
  return {
    id: String(row.id),
    name: String(row.name),
    ...(row.description !== null && row.description !== undefined
      ? { description: String(row.description) }
      : {}),
    visibility: row.visibility === 'organization' ? 'organization' : 'personal',
    ownerUserId,
    role,
    allowedActions: allowedActionsForRole(role),
    canManage: role === 'owner',
    prompt: String(row.prompt ?? TASKBOARD_DEFAULT_PROMPT),
    ...(Object.keys(stageModels).length ? { stageModels } : {}),
    ...(Object.keys(stagePrompts).length ? { stagePrompts } : {}),
    ...(row.model !== null && row.model !== undefined && String(row.model).trim()
      ? { model: String(row.model) }
      : {}),
    ...(repository ? { repository } : {}),
    ...(integrationPolicy ? { integrationPolicy } : {}),
    version: Number(row.version),
    ...(row.archived_at ? { archivedAt: toIso(row.archived_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function allowedActionsForRole(role: TaskBoardMemberRole): TaskBoardAllowedAction[] {
  const read: TaskBoardAllowedAction[] = ['board.read'];
  if (role === 'viewer') return read;
  const editor: TaskBoardAllowedAction[] = [
    ...read,
    'task.create',
    'task.update',
    'task.reorder',
    'comment.create',
    'execution.trigger',
  ];
  if (role === 'editor') return editor;
  const maintainer: TaskBoardAllowedAction[] = [
    ...editor,
    'task.transition',
    'task.archive',
    'task.delete',
    'execution.cancel',
    'integration.create',
    'integration.authorize',
    'integration.cancel',
  ];
  if (role === 'maintainer') return maintainer;
  return [...TASKBOARD_ALLOWED_ACTIONS];
}

function resolveBoardRole(row: Record<string, unknown>, currentUserId: string): TaskBoardMemberRole {
  if (String(row.owner_user_id) === currentUserId) return 'owner';
  const value = String(row.board_role ?? 'viewer');
  return value === 'editor' || value === 'maintainer' ? value : 'viewer';
}

export function boardRepositoryFragment(
  lockedBoardRepository: TaskBoardRepositoryConfig | undefined,
  rowRepository: unknown,
): { boardRepository?: TaskBoardRepositoryConfig } {
  const repository = lockedBoardRepository ?? parseJsonObject<TaskBoardRepositoryConfig>(rowRepository);
  return repository ? { boardRepository: repository } : {};
}

export function parseJsonObject<T>(value: unknown): T | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

export function parseStagePrompts(value: unknown): TaskBoardStagePrompts {
  const parsed = parseJsonObject<Record<string, unknown>>(value);
  if (!parsed) return {};
  return normalizeStagePrompts({
    ...(typeof parsed.work === 'string' ? { work: parsed.work } : {}),
    ...(typeof parsed.review === 'string' ? { review: parsed.review } : {}),
    ...(typeof parsed.merge === 'string' ? { merge: parsed.merge } : {}),
  });
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
