import { realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { splitByMessageMarkers } from '../../../shared/src/lib/markers.js';
import type { TaskBoardAttachment, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { isInside, relativeWorkspacePath, resolveWorkspacePath } from '../agent/toolRuntimePaths.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import type { TaskboardExecutionStore } from './types.js';

export async function reconcileTerminalContinuation(input: {
  store: TaskboardExecutionStore;
  eventStore: EventStore;
  taskId: string;
  run: RunRecord;
  agentCwd: string;
}): Promise<TaskBoardTask | null> {
  const { store, eventStore, taskId, run, agentCwd } = input;
  if (run.status === 'completed') {
    const events = eventStore.listByRun
      ? await eventStore.listByRun(run.sessionId, run.runId)
      : await eventStore.list(run.sessionId);
    const output = finalAssistantText(events, run.runId, run.sessionId)
      || 'Agent 继续执行完成，但没有返回文本交付。';
    const attachments = await extractContinuationAttachments(output, run, agentCwd);
    return store.completeContinuation(taskId, run.runId, {
      status: 'succeeded',
      commentBody: limitComment(`Agent 交付\n\n${stripFileMarkers(output)}`),
      ...(attachments.length ? { attachments } : {}),
    });
  }
  if (run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'orphaned') return null;
  const cancelled = run.status === 'cancelled';
  const reason = run.statusReason || `Runtime 状态：${run.status}`;
  return store.completeContinuation(taskId, run.runId, {
    status: cancelled ? 'cancelled' : 'failed',
    error: reason,
    commentBody: limitComment(`Agent 继续执行${cancelled ? '已取消' : '失败'}\n\n${reason}`),
  });
}

export function extractContinuationAttachments(
  output: string,
  run: RunRecord,
  agentCwd: string,
): Promise<TaskBoardAttachment[]> {
  if (!run.userId) return Promise.resolve([]);
  const userCwd = resolveUserCwd(agentCwd, {
    id: run.userId,
    username: '',
    role: 'user',
    ...(run.tenantId ? { tenantId: run.tenantId } : {}),
  });
  return extractAgentAttachments(output, userCwd);
}

export async function extractAgentAttachments(
  output: string,
  userCwd: string,
): Promise<TaskBoardAttachment[]> {
  let realUserCwd: string;
  try {
    realUserCwd = await realpath(userCwd);
  } catch {
    return [];
  }
  const paths = [...new Set(splitByMessageMarkers(output)
    .filter((segment): segment is Extract<ReturnType<typeof splitByMessageMarkers>[number], { type: 'file' }> => (
      segment.type === 'file' && Boolean(segment.filePath)
    ))
    .map((segment) => segment.filePath))]
    .slice(0, 50);
  const attachments = await Promise.all(paths.map(async (filePath): Promise<TaskBoardAttachment | null> => {
    try {
      const absolutePath = resolveWorkspacePath(userCwd, filePath);
      const realFilePath = await realpath(absolutePath);
      if (!isInside(realUserCwd, realFilePath)) return null;
      const fileStat = await stat(realFilePath);
      if (!fileStat.isFile()) return null;
      const relativePath = relativeWorkspacePath(userCwd, absolutePath);
      const originalName = relativePath.split('/').pop() || relativePath;
      const mimeType = mimeTypeFromName(originalName);
      return {
        originalName,
        relativePath,
        size: fileStat.size,
        mimeType,
        isImage: mimeType.startsWith('image/'),
      };
    } catch {
      return null;
    }
  }));
  return attachments.filter((attachment): attachment is TaskBoardAttachment => attachment !== null);
}

function finalAssistantText(events: PlatformEvent[], runId: string, sessionId: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant_message' || event.incomplete
      || event.runId !== runId || event.sessionId !== sessionId) continue;
    const content = event.content?.trim();
    if (content) return content;
  }
  return '';
}

export function stripFileMarkers(output: string): string {
  return output.replace(/\[FILE\]\{.*?\}\[\/FILE\]/g, '').trim();
}

function mimeTypeFromName(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
  };
  return types[extension] ?? 'application/octet-stream';
}

function limitComment(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 20_000) return normalized;
  return `${normalized.slice(0, 19_950)}\n\n[回执内容过长，已截断]`;
}
