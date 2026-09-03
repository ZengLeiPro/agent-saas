import {
  TRANSCRIPT_STREAM_LINE_PREFIX_CHARS,
  TRANSCRIPT_STREAM_LINE_TAIL_CHARS,
} from '../data/transcripts/parse.js';

/**
 * transcript JSONL 里的 tool_result 长期原样落盘工具原文，生产上出现过单行
 * 5,304,669 字符（历史最大 269,261,793），既拖慢 transcript 读取，也让写入侧
 * 每次都要把整份原文物化成一个巨型字符串再 JSON.stringify。
 *
 * 而 transcript 的每一个消费者都读不到这些中段：
 *   - 会话详情/搜索：parseTranscriptFile 对每条 tool_result 截到 16KB（更早的 4KB）；
 *   - 超阈值单行：readTranscriptLinesBounded 只保留首尾各 64KB；
 *   - 模型上下文：projectToolResultContentForModel 只给 8KB。
 * 因此这里按读取侧 oversized 窗口同值收口，对上述所有消费者逐字节等价，
 * 只去掉无人读取的中段。工具原文全量仍在 durable EventStore，可用
 * SessionContext(action="trace") 按行/按字符检索。
 */
export const TRANSCRIPT_TOOL_RESULT_HEAD_CHARS = TRANSCRIPT_STREAM_LINE_PREFIX_CHARS;
export const TRANSCRIPT_TOOL_RESULT_TAIL_CHARS = TRANSCRIPT_STREAM_LINE_TAIL_CHARS;
export const TRANSCRIPT_TOOL_RESULT_MAX_CHARS =
  TRANSCRIPT_TOOL_RESULT_HEAD_CHARS + TRANSCRIPT_TOOL_RESULT_TAIL_CHARS;

export function projectToolResultContentForTranscript(content: string, toolUseId: string): string {
  if (content.length <= TRANSCRIPT_TOOL_RESULT_MAX_CHARS) return content;
  const head = content.slice(0, TRANSCRIPT_TOOL_RESULT_HEAD_CHARS);
  const tail = content.slice(-TRANSCRIPT_TOOL_RESULT_TAIL_CHARS);
  const omitted = content.length - head.length - tail.length;
  return (
    `${head}\n[tool_result 已截断：共 ${content.length} 字符，省略中间 ${omitted} 字符；` +
    `完整原文见 SessionContext(action="trace", toolCallId=${JSON.stringify(toolUseId)})]\n${tail}`
  );
}
