import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { agentPath } from '../../workspace/namespace.js';
import { Semaphore } from '../../runtime/fileReadCoalesce.js';

/** Bounds cross-session approval resume work while per-file reads are coalesced. */
export const approvalResumeSemaphore = new Semaphore(8);

export const INTERACTIVE_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'RequestPluginInstall',
]);

export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned']);

/** 语音转写前缀标记（STT 注入 / 门禁判定前剥离共用） */
export const VOICE_STT_TAG = '[这是一条语音转文字的消息，可能存在识别准确度问题] ';

export function wantsToolAutoApproval(
  policy: { autoApproveTools?: boolean; autoApproveRunShell?: boolean } | undefined,
): boolean {
  return policy?.autoApproveTools === true || policy?.autoApproveRunShell === true;
}

/** 读取用户 workspace 内最近生成的 plan 文件内容。 */
export async function readLatestPlanContent(userCwd?: string): Promise<string | null> {
  if (!userCwd) return null;
  const candidates = [agentPath(userCwd, 'plans')];

  try {
    const now = Date.now();
    let latest = { name: '', mtime: 0, dir: '' };

    for (const plansDir of candidates) {
      let files: string[];
      try { files = await readdir(plansDir); } catch { continue; }
      const mdFiles = files.filter(f => f.endsWith('.md'));
      for (const f of mdFiles) {
        const s = await stat(join(plansDir, f));
        if (s.mtimeMs > latest.mtime && (now - s.mtimeMs) < 60_000) {
          latest = { name: f, mtime: s.mtimeMs, dir: plansDir };
        }
      }
    }

    if (!latest.name) return null;
    return await readFile(join(latest.dir, latest.name), 'utf-8');
  } catch {
    return null;
  }
}
