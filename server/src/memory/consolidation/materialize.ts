/**
 * 记忆候选 → 当日文件的确定性物化（2026-07-29 P1 崩溃幂等修复批次）。
 *
 * MemoryCommit（正常路径）与 engine 崩溃恢复路径共用同一序列化与写入逻辑，
 * 保证「同一 proposal 无论谁物化，产物字节一致」——这是 postimage hash 可
 * 用于恢复判定的前提。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { MemoryCandidateOperation } from './types.js';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function formatMemoryDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function serializeCandidate(op: MemoryCandidateOperation, date: string): string {
  const keyShort = sha256Text(op.memoryKey).slice(0, 8);
  const attributionLabel = op.attribution === 'user_statement'
    ? '用户原话'
    : op.attribution === 'agent_inference' ? 'Agent推论' : '外部资料';
  const supersedes = op.supersedesMemoryKey ? `（更正先前条目 ${op.supersedesMemoryKey.slice(0, 8)}）` : '';
  const evidenceRef = op.evidence.map((item) => `seq=${item.sessionSequence}`).join(',');
  return `- [mem:${keyShort}] ${date}｜${attributionLabel}：${op.text}${supersedes}（证据 ${evidenceRef}）`;
}

/** 基于当前文件内容计算追加后的完整产物（纯函数，供 hash 预计算与实际写入共用）。 */
export function buildDailyFileNext(existing: string, operations: MemoryCandidateOperation[], date: string): string {
  const lines = operations.map((op) => serializeCandidate(op, date));
  return existing.length > 0
    ? `${existing.replace(/\n*$/, '\n')}${lines.join('\n')}\n`
    : `# ${date}\n\n${lines.join('\n')}\n`;
}

export interface MaterializeResult {
  filePath: string;
  baseHash: string;
  postimageHash: string;
}

/** 原子写当日文件（tmp + rename）。调用方必须已持有 per-user PG commit lock。 */
export async function materializeDailyOperations(input: {
  workspaceRoot: string;
  operations: MemoryCandidateOperation[];
  date: string;
}): Promise<MaterializeResult> {
  const filePath = join(input.workspaceRoot, 'memory', `${input.date}.md`);
  const existing = await readFile(filePath, 'utf8').catch(() => '');
  const next = buildDailyFileNext(existing, input.operations, input.date);
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, next, 'utf8');
  await rename(tmpPath, filePath);
  return { filePath, baseHash: sha256Text(existing), postimageHash: sha256Text(next) };
}

/** 读当日文件当前 hash（恢复判定用）。文件不存在 = 空串 hash。 */
export async function readDailyFileHash(workspaceRoot: string, date: string): Promise<string> {
  const filePath = join(workspaceRoot, 'memory', `${date}.md`);
  const existing = await readFile(filePath, 'utf8').catch(() => '');
  return sha256Text(existing);
}
