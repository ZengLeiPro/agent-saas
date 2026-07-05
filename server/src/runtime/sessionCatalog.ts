import { getTranscriptPath, findTranscriptOrMetaPathBySessionId } from '../data/transcripts/store.js';
import { readSessionMeta, writeSessionMeta, updateSessionMeta, type SessionMeta } from '../data/transcripts/meta.js';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';

export type RuntimeSessionStatus = 'running' | 'idle' | 'waiting_approval' | 'finished' | 'error';

export interface RuntimeSessionRecord {
  sessionId: string;
  userId: string;
  username: string;
  userRole?: 'admin' | 'user';
  tenantId?: string;
  channel: string;
  cwd: string;
  transcriptPath: string;
  modelRef?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  status?: RuntimeSessionStatus;
  /**
   * 会话种类（2026-07-06 子 agent 工具）。'subagent' = Agent 工具派生的 hidden
   * session：不进会话列表，Run Trace 可见。与 SessionMeta.kind 一一对应。
   */
  kind?: 'subagent';
  createdAt: string;
  updatedAt: string;
}

export interface SessionCatalog {
  upsert(record: RuntimeSessionRecord): Promise<void>;
  get(sessionId: string): Promise<RuntimeSessionRecord | null>;
  markStatus(sessionId: string, status: RuntimeSessionStatus): Promise<void>;
  findTranscriptPath(sessionId: string): Promise<string | null>;
}

export interface FileSessionCatalogOptions {
  agentCwd: string;
}

/**
 * File-backed catalog that keeps the current transcript/meta layout while
 * exposing the minimal lookup contract needed by wake(sessionId).
 */
export class FileSessionCatalog implements SessionCatalog {
  constructor(private readonly options: FileSessionCatalogOptions) {}

  async upsert(record: RuntimeSessionRecord): Promise<void> {
    const existing = await readSessionMeta(record.transcriptPath);
    const meta: SessionMeta = {
      ...(existing ?? {}),
      userId: record.userId,
      username: record.username,
      userRole: record.userRole,
      ...(record.tenantId ? { tenantId: record.tenantId } : {}),
      channel: record.channel,
      createdAt: existing?.createdAt ?? record.createdAt,
      cwd: record.cwd,
      transcriptPath: record.transcriptPath,
      workspaceId: record.workspaceId,
      runtimeStatus: record.status,
      updatedAt: record.updatedAt,
      ...(record.modelRef ? { model: record.modelRef } : {}),
      ...(record.executionTarget ? { executionTarget: record.executionTarget } : {}),
      ...(record.kind ? { kind: record.kind } : {}),
    } as SessionMeta & { transcriptPath?: string };
    await writeSessionMeta(record.transcriptPath, meta);
  }

  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    const transcriptPath = await this.findTranscriptPath(sessionId);
    if (!transcriptPath) return null;
    const meta = await readSessionMeta(transcriptPath);
    if (!meta) return null;
    return this.toRecord(sessionId, transcriptPath, meta);
  }

  async markStatus(sessionId: string, status: RuntimeSessionStatus): Promise<void> {
    const transcriptPath = await this.findTranscriptPath(sessionId);
    if (!transcriptPath) return;
    await updateSessionMeta(transcriptPath, {
      runtimeStatus: status,
      updatedAt: new Date().toISOString(),
    });
  }

  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return findTranscriptOrMetaPathBySessionId(sessionId);
  }

  private toRecord(sessionId: string, transcriptPath: string, meta: SessionMeta): RuntimeSessionRecord {
    const now = new Date().toISOString();
    return {
      sessionId,
      userId: meta.userId,
      username: meta.username,
      ...(isUserRole(meta.userRole) ? { userRole: meta.userRole } : {}),
      ...(meta.tenantId ? { tenantId: meta.tenantId } : {}),
      channel: meta.channel,
      cwd: meta.cwd ?? this.options.agentCwd,
      transcriptPath,
      ...(meta.model ? { modelRef: meta.model } : {}),
      ...(isExecutionTargetKind(meta.executionTarget) ? { executionTarget: meta.executionTarget } : {}),
      ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      ...(isRuntimeSessionStatus(meta.runtimeStatus) ? { status: meta.runtimeStatus } : {}),
      ...(meta.kind === 'subagent' ? { kind: 'subagent' as const } : {}),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt ?? meta.createdAt ?? now,
    };
  }
}

export function createRuntimeSessionRecord(args: {
  sessionId: string;
  userId?: string;
  username?: string;
  userRole?: 'admin' | 'user';
  tenantId?: string;
  channel: string;
  cwd: string;
  modelRef?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  status?: RuntimeSessionStatus;
  kind?: 'subagent';
}): RuntimeSessionRecord {
  const now = new Date().toISOString();
  return {
    sessionId: args.sessionId,
    userId: args.userId ?? '',
    username: args.username ?? '',
    ...(args.userRole ? { userRole: args.userRole } : {}),
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    channel: args.channel,
    cwd: args.cwd,
    transcriptPath: getTranscriptPath(args.cwd, args.sessionId, { userId: args.userId, tenantId: args.tenantId }),
    ...(args.modelRef ? { modelRef: args.modelRef } : {}),
    ...(args.executionTarget ? { executionTarget: args.executionTarget } : {}),
    workspaceId: args.workspaceId ?? args.sessionId,
    status: args.status ?? 'running',
    ...(args.kind ? { kind: args.kind } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function isExecutionTargetKind(value: unknown): value is ExecutionTargetKind {
  return value === 'server-local'
    || value === 'server-container'
    || value === 'server-remote'
    || value === 'client';
}

function isUserRole(value: unknown): value is 'admin' | 'user' {
  return value === 'admin' || value === 'user';
}

function isRuntimeSessionStatus(value: unknown): value is RuntimeSessionStatus {
  return value === 'running'
    || value === 'idle'
    || value === 'waiting_approval'
    || value === 'finished'
    || value === 'error';
}
