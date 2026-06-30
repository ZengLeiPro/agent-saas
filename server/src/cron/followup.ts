/**
 * Cron Followup Context Builder
 *
 * 根据 Cron 运行记录（runId）构建追问上下文。
 * 供 DingtalkChannel 等通道在用户发送"追问 <runId> <question>"时调用。
 * 将 Cron run-log 和 transcript 的存储细节封装在 cron 模块内部。
 */

import { findRunLogEntryByRunId } from './run-log.js';
import { findTranscriptPathBySessionId, parseTranscriptFile } from '../data/transcripts/index.js';

const MAX_CONTEXT_CHARS = 40_000;
const MAX_BLOCKS = 200;

export interface FollowupResult {
  context: string;
  question: string;
}

/**
 * 根据 runId 构建追问上下文
 *
 * @param runId - Cron 运行记录 ID
 * @param question - 用户追问内容（空字符串时使用默认提示）
 * @param cronRunsDir - Cron 运行日志目录
 */
export async function buildFollowupContext(
  runId: string,
  question: string,
  cronRunsDir: string,
): Promise<FollowupResult> {
  const userQuestion = question || '请基于这次定时任务的运行日志回答我的追问。';

  const run = await findRunLogEntryByRunId(runId, { runsDir: cronRunsDir });
  if (!run) {
    return {
      context: `[追问上下文]\n未找到该 runId 对应的运行记录（runId=${runId}）。`,
      question: userQuestion,
    };
  }

  let transcriptPath = run.transcriptPath;
  if (!transcriptPath && run.sessionId) {
    transcriptPath = (await findTranscriptPathBySessionId(run.sessionId)) || undefined;
  }

  if (!transcriptPath) {
    return {
      context: `[追问上下文]\n未找到该 runId 对应的 transcript 文件（runId=${run.runId}）。`,
      question: userQuestion,
    };
  }

  const parsed = await parseTranscriptFile(transcriptPath);

  const parts: string[] = [];
  parts.push(`[追问上下文]\n你正在回答一条"定时任务运行(runId=${run.runId})"的追问。\n`);
  parts.push(
    `任务：${run.jobName}\n状态：${run.status}\n时间：${new Date(run.startedAtMs).toLocaleString('zh-CN')}\n耗时：${(
      run.durationMs / 1000
    ).toFixed(1)}s\nsessionId：${run.sessionId ?? '(unknown)'}\n`,
  );

  if (run.error) {
    parts.push(`\n[运行错误]\n${run.error}\n`);
  }

  parts.push(`\n[结构化日志（用于追问；完整日志建议在 Web 查看）]\n`);

  let acc = parts.join('');
  let added = 0;
  for (const b of parsed.blocks) {
    if (b.kind === 'meta') continue;
    const blockText = `\n### ${b.title} (${b.kind})\n${b.content}\n`;
    if (acc.length + blockText.length > MAX_CONTEXT_CHARS) {
      acc += `\n...(日志过长，已截断；请在 Web 端运行历史用 runId=${run.runId} 查看完整过程日志)\n`;
      break;
    }
    acc += blockText;
    added += 1;
    if (added >= MAX_BLOCKS) {
      acc += `\n...(日志块过多，已截断；请在 Web 端运行历史用 runId=${run.runId} 查看完整过程日志)\n`;
      break;
    }
  }

  return {
    context: acc.trim(),
    question: userQuestion,
  };
}
