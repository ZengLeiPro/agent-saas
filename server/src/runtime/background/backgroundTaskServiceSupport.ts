import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { UserIdentity } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import type { RunRecord, RunStatus, RunStore } from '../runStore.js';
import { SUBAGENT_RESULT_MAX_CHARS } from '../subagent/subagentLimits.js';
import type { SubagentOutcome } from '../subagent/subagentRunner.js';
import { metadataString } from './backgroundTaskMetadata.js';
import { truncateResult, type StoredBackgroundResult } from './backgroundTaskFormatting.js';

const logger = createLogger('BackgroundTaskService');

export function requireBackgroundRunStore(runStore: RunStore | undefined): RunStore {
  if (!runStore?.enqueueBackgroundTask || !runStore.listBackgroundTasks) {
    throw new Error('后台 Agent/命令需要 PG durable runtime，当前后端不支持。');
  }
  return runStore;
}

export function sessionIdentity(session: {
  userId: string;
  username: string;
  userRole?: 'admin' | 'user';
  tenantId?: string;
}): UserIdentity {
  return {
    id: session.userId,
    username: session.username,
    role: session.userRole ?? 'user',
    ...(session.tenantId ? { tenantId: session.tenantId } : {}),
  };
}

export function outcomeToRunStatus(
  status: SubagentOutcome['status'],
): Extract<RunStatus, 'completed' | 'failed' | 'cancelled'> {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

export function isTerminal(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned'
  );
}

export function failureResult(
  status: 'failed' | 'cancelled',
  message: string,
): StoredBackgroundResult {
  return {
    status,
    text: '',
    errorMessage: message,
    totalTokens: 0,
    toolUseCount: 0,
    turnCount: 0,
    durationMs: 0,
  };
}

export async function persistResultText(
  record: RunRecord,
  text: string,
  childRunId: string,
): Promise<{ text: string; spillPath?: string }> {
  if (text.length <= SUBAGENT_RESULT_MAX_CHARS) return { text };
  const cwd = metadataString(record.metadata, 'cwd');
  if (!cwd) return { text: truncateResult(text) };
  const spillPath = join('assets', 'background-tasks', `${childRunId}.md`);
  try {
    const fullPath = join(cwd, spillPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, text, 'utf-8');
    return { text: truncateResult(text), spillPath };
  } catch (error) {
    logger.warn(
      `后台任务结果 spill 失败 task=${record.runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { text: truncateResult(text) };
  }
}
