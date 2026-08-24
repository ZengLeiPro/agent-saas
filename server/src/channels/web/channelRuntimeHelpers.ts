import { readdir } from 'node:fs/promises';
import { Semaphore } from '../../runtime/fileReadCoalesce.js';
import { openTrustedDirectory, withTrustedFile } from '../../security/trustedFile.js';

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
  const plansRelativePath = '.ky-agent/plans';

  try {
    const plans = await openTrustedDirectory(userCwd, plansRelativePath);
    try {
      const now = Date.now();
      let latest: { mtime: number; content: string } | null = null;
      const files = await readdir(plans.fdPath);
      for (const name of files) {
        if (!name.endsWith('.md')) continue;
        try {
          const candidate = await withTrustedFile(
            userCwd,
            `${plansRelativePath}/${name}`,
            async file => ({
              mtime: file.stats.mtimeMs,
              content: await file.handle.readFile({ encoding: 'utf-8' }),
            }),
          );
          if (candidate.mtime > (latest?.mtime ?? 0) && (now - candidate.mtime) < 60_000) {
            latest = candidate;
          }
        } catch {
          // Ignore files that disappear or become unsafe while the directory is scanned.
        }
      }
      return latest?.content ?? null;
    } finally {
      await plans.handle.close();
    }
  } catch {
    return null;
  }
}
