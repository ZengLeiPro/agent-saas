/**
 * Session transcript → MessageItem mapping functions.
 * Platform-agnostic: no browser-specific APIs.
 */

import type { MessageItem, SubagentStatus } from '../types/message';
import type { AskUserAnswers } from '../types/message';
import type { ApiSessionDetail, ApiTranscriptBlock } from '../types/session';
import { resolveDisplayToolName } from './toolDisplay';
import { normalizeToolPresentation, type DetailLine, type ToolPresentation } from './toolPresentation';
import { normalizeToolResultMetadata } from './toolResultMetadata';
import { normalizeDisplay } from './presentation/registry';

// -- Interactive tool history restore --

const INTERACTIVE_RESULT_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Agent",
]);

function parseSubagentDescription(content: string): string {
  try {
    const input = JSON.parse(content) as { description?: unknown; agent_type?: unknown };
    if (typeof input.description === "string" && input.description.trim()) {
      return input.description.trim();
    }
    if (typeof input.agent_type === "string" && input.agent_type.trim()) {
      return input.agent_type.trim();
    }
  } catch { /* parse failure */ }
  return "子任务";
}

function parseAnswersFromResult(
  resultText: string,
  knownQuestions?: string[],
): AskUserAnswers {
  const answers: AskUserAnswers = {};
  // Raw runtime writes AskUserQuestion results as structured JSON.
  try {
    const parsed = JSON.parse(resultText) as { answers?: unknown };
    if (parsed.answers && typeof parsed.answers === 'object' && !Array.isArray(parsed.answers)) {
      for (const [question, answer] of Object.entries(parsed.answers)) {
        if (typeof answer === 'string'
          || (Array.isArray(answer) && answer.every((item) => typeof item === 'string'))) {
          answers[question] = answer;
        }
      }
      return answers;
    }
  } catch { /* legacy SDK result text */ }

  // SDK result 文案前缀随版本变化，需同时兼容：
  //   - 旧（≤0.2.x）: User has answered your question(s): "q1"="a1", "q2"="a2". You can now ...
  //   - 新（0.3.156+）: Your question(s) has/have been answered: "q1"="a1", "q2"="a2". You can now ...
  const match = resultText.match(
    /^(?:User has answered your questions?|Your questions? (?:has|have) been answered):\s*(.+)\.\s*You can now/s,
  );
  if (!match) return answers;
  const body = match[1];

  // When we know the question texts, use them as anchors — handles quotes inside questions
  if (knownQuestions && knownQuestions.length > 0) {
    for (let i = 0; i < knownQuestions.length; i++) {
      const q = knownQuestions[i];
      const marker = `"${q}"="`;
      const start = body.indexOf(marker);
      if (start === -1) continue;
      const valStart = start + marker.length;
      // Value ends at: next question's marker, or end of body
      let valEnd = body.length;
      if (i < knownQuestions.length - 1) {
        const nextMarker = `", "${knownQuestions[i + 1]}"="`;
        const nextIdx = body.indexOf(nextMarker, valStart);
        if (nextIdx !== -1) valEnd = nextIdx;
      }
      let val = body.slice(valStart, valEnd);
      if (val.endsWith('"')) val = val.slice(0, -1);
      answers[q] = val;
    }
    return answers;
  }

  // Fallback: simple regex for older transcripts without known questions
  const pairRegex = /"([^"]+)"="([^"]*)"/g;
  let m;
  while ((m = pairRegex.exec(body)) !== null) {
    answers[m[1]] = m[2];
  }
  return answers;
}

function tryConvertAskUser(
  block: ApiTranscriptBlock,
  resultText: string | undefined,
): MessageItem | null {
  if (resultText === undefined) return null;
  try {
    const input = JSON.parse(block.content);
    if (Array.isArray(input?.questions)) {
      // Prefer answers embedded in tool input (set by updatedInput in runner.ts),
      // fall back to parsing from resultText using known questions as anchors
      const knownQuestions = input.questions.map((q: { question: string }) => q.question);
      const answers = (input.answers && typeof input.answers === 'object' && Object.keys(input.answers).length > 0)
        ? input.answers as AskUserAnswers
        : parseAnswersFromResult(resultText, knownQuestions);
      return {
        id: block.id,
        type: "ask_user",
        interactionId: "",
        questions: input.questions,
        status: "answered",
        answers,
      };
    }
  } catch { /* parse failure */ }
  return null;
}

const PLAN_MODE_DISPLAY: Record<string, string> = {
  EnterPlanMode: "进入规划模式",
  ExitPlanMode: "规划方案审批",
};

function extractPlanContent(resultText: string): string {
  // SDK 有两种 marker："## Approved Plan:\n" 和 "## Approved Plan (edited by user):\n"
  const match = resultText.match(/## Approved Plan[^:\n]*:\n/);
  if (match && match.index !== undefined) {
    return resultText.slice(match.index + match[0].length).trim();
  }
  return "";
}

/** 从 ExitPlanMode 的 tool_use input JSON 中提取 plan 字段 */
function extractPlanFromInput(blockContent: string): string {
  try {
    const input = JSON.parse(blockContent);
    if (typeof input?.plan === "string") return input.plan.trim();
  } catch { /* parse failure */ }
  return "";
}

const ENTER_PLAN_DESCRIPTION = "Agent 请求进入规划模式，将在只读模式下探索代码库并设计实现方案。";

function tryConvertPlanMode(
  block: ApiTranscriptBlock,
  resultText: string | undefined,
): MessageItem | null {
  if (resultText === undefined) return null;
  const toolName = block.toolName || "unknown";
  const displayName = PLAN_MODE_DISPLAY[toolName] || toolName;
  // EnterPlanMode 成功: "Entered plan mode..."
  // ExitPlanMode 成功: "User has approved your plan..."
  // 拒绝/异常: "User denied" / "Tool interaction failed" / "<tool_use_error>..." 等
  const isDenied = toolName === "EnterPlanMode"
    ? !resultText.startsWith("Entered plan mode")
    : !resultText.startsWith("User has approved");

  let toolInput = "";
  if (toolName === "EnterPlanMode") {
    toolInput = ENTER_PLAN_DESCRIPTION;
  } else if (toolName === "ExitPlanMode") {
    // 优先从 tool_result 提取（包含用户编辑后的最终版本）
    toolInput = extractPlanContent(resultText);
    // fallback：从 tool_use input 的 plan 字段提取（适用于 denied 等无 marker 的场景）
    if (!toolInput) {
      toolInput = extractPlanFromInput(block.content);
    }
  }

  return {
    id: block.id,
    type: "permission_request",
    interactionId: "",
    toolName: displayName,
    toolInput,
    status: isDenied ? "denied" : "allowed",
  };
}

/**
 * 子 Agent 摘要。
 *
 * 与其他工具的差别：这些数字（耗时/token/工具次数/轮次）是子 run 结束后才
 * 聚合出来的，服务端写 tool_use 行时还不存在，因此只能在映射层组装。
 * 全部字段直取 durable 聚合值，不做任何推算。
 */
function subagentPresentation(
  agentType: string,
  status: SubagentStatus,
  subagent: ApiTranscriptBlock['subagent'],
): ToolPresentation | undefined {
  const detail: DetailLine[] = [];
  if (subagent?.model) detail.push({ k: '模型', v: subagent.model });
  if (typeof subagent?.turnCount === 'number') detail.push({ tree: '├', k: '轮次', v: `${subagent.turnCount}` });
  if (typeof subagent?.toolUseCount === 'number') detail.push({ tree: '├', k: '工具调用', v: `${subagent.toolUseCount} 次` });
  if (typeof subagent?.totalTokens === 'number') {
    detail.push({ tree: '├', k: 'Token', v: subagent.totalTokens.toLocaleString('zh-CN') });
  }
  if (typeof subagent?.durationMs === 'number') {
    const ms = subagent.durationMs;
    const v = ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
    detail.push({ tree: '└', k: '耗时', v });
  }
  if (subagent?.errorMessage) detail.push({ indent: 0, text: `⚠ ${subagent.errorMessage}` });
  if (!detail.length) return undefined;
  const failed = status === 'failed' || status === 'timeout' || status === 'cancelled';
  return { title: agentType, detail, status: failed ? 'warn' : 'ok' };
}

// -- FILE marker parsing --

const FILE_MARKER_RE = /\[FILE\](\{.*?\})\[\/FILE\]/g;

function extractFileMessages(blockId: string, content: string, owner?: string): MessageItem[] {
  const results: MessageItem[] = [];
  let idx = 0;
  for (const match of content.matchAll(FILE_MARKER_RE)) {
    try {
      const payload = JSON.parse(match[1]);
      const filePath: string = payload.filePath || payload.path;
      if (!filePath) continue;
      results.push({
        id: `${blockId}-file-${idx++}`,
        type: "file_download",
        fileName: payload.fileName || filePath.split("/").pop() || "file",
        fileType: payload.fileType || "",
        filePath,
        fileSize: payload.fileSize ?? 0,
        ...(owner ? { owner } : {}),
      });
    } catch { /* skip */ }
  }
  return results;
}

// -- Strip AI-injected metadata from user prompt --

const ATTACHMENT_INSTRUCTION_RE = /\n\n\[用户上传了以下附件[^\]]*\]\n[\s\S]*$/;
const AI_FALLBACK_TEXT = 'Please check the attachments I uploaded';
const VOICE_STT_PREFIX = /^\[这是一条语音转文字的消息，可能存在识别准确度问题\]\s*/;

interface ParsedPrompt {
  text: string;
  attachments?: Array<{ name: string }>;
  isVoiceTranscript?: boolean;
}

/**
 * 从 transcript prompt 中剥离注入给 AI 的元数据：
 * - 附件指令文本 → 提取文件名列表
 * - 语音 STT 前缀 → 标记为语音转写
 */
function parsePromptContent(content: string): ParsedPrompt {
  const result: ParsedPrompt = { text: content };

  // 1. 剥离附件指令
  const attMatch = result.text.match(ATTACHMENT_INSTRUCTION_RE);
  if (attMatch) {
    const attachments: Array<{ name: string }> = [];
    for (const line of attMatch[0].split('\n')) {
      const m = line.match(/^- (.+?) \(/);
      if (m) attachments.push({ name: m[1] });
    }
    result.text = result.text.slice(0, attMatch.index!);
    if (attachments.length > 0) result.attachments = attachments;
  }

  // 2. 剥离 AI fallback 占位文本
  if (result.text === AI_FALLBACK_TEXT && result.attachments) result.text = '';

  // 3. 检测语音 STT 前缀
  if (VOICE_STT_PREFIX.test(result.text)) {
    result.text = result.text.replace(VOICE_STT_PREFIX, '');
    result.isVoiceTranscript = true;
  }

  return result;
}

// -- Generic block mapping --

function mapBlock(
  block: ApiTranscriptBlock,
  toolResultMap: Map<string, string>,
  owner?: string,
): MessageItem | null {
  const id = block.id;
  switch (block.kind) {
    case "prompt": {
      const parsed = parsePromptContent(block.content);
      // 优先结构化字段（raw runtime transcript user 行顶层 attachments）；
      // 文本正则解析仅作旧 SDK 时代 transcript 的 fallback。
      const attachments = block.attachments?.length ? block.attachments : parsed.attachments;
      const text = parsed.text === AI_FALLBACK_TEXT && attachments?.length ? '' : parsed.text;
      return {
        id, type: "user", content: text,
        ...(attachments?.length ? { attachments } : {}),
        ...(parsed.isVoiceTranscript || block.isVoiceTranscript ? { isVoiceTranscript: true } : {}),
        ...(block.clientMsgId ? { clientMsgId: block.clientMsgId } : {}),
        timestamp: block.tsMs,
      };
    }
    case "text": {
      // 呈现块来自不可信来源，归一后才进渲染层；未知 kind 静默丢弃
      const display = normalizeDisplay(block.display);
      return {
        id, type: "text", content: block.content, streaming: false,
        ...(block.runId ? { runId: block.runId } : {}),
        ...(block.finalOutput ? { finalOutput: true } : {}),
        ...(owner ? { owner } : {}),
        ...(block.guardrailEventId ? { guardrailEventId: block.guardrailEventId } : {}),
        ...(display ? { display } : {}),
        timestamp: block.tsMs,
      };
    }
    case "thinking":
      return {
        id,
        type: "thinking",
        content: block.content || "",
        streaming: false,
        ...(typeof block.durationMs === "number" ? { durationMs: block.durationMs } : {}),
      };

    case "tool_use": {
      const resultText = block.toolId ? toolResultMap.get(block.toolId) : undefined;
      // 摘要来自不可信来源（transcript 文件 / 演示剧本），必须规范化后再入渲染层
      const presentation = normalizeToolPresentation(block.presentation);
      // 结构化执行事实同一条通道、同一条不可信边界规则
      const toolMetadata = normalizeToolResultMetadata(block.toolMetadata);
      if (block.toolName === "AskUserQuestion" && !block.publicActivityOnly) {
        return tryConvertAskUser(block, resultText);
      }
      if ((block.toolName === "EnterPlanMode" || block.toolName === "ExitPlanMode") && !block.publicActivityOnly) {
        return tryConvertPlanMode(block, resultText);
      }
      if (block.toolName === "Agent" && !block.publicActivityOnly) {
        const terminal = resultText !== undefined
          || block.executionStatus === "completed"
          || block.executionStatus === "failed"
          || block.executionStatus === "cancelled";
        const subagentStatus = block.subagent?.status
          ?? (block.executionStatus === "failed"
            ? "failed"
            : block.executionStatus === "cancelled"
              ? "cancelled"
              : terminal
                ? "completed"
                : "running");
        const resultPreview = block.subagent?.resultPreview
          ?? (resultText?.trim() ? resultText.trim().slice(0, 2_000) : undefined);
        const agentType = block.subagent?.description || parseSubagentDescription(block.content);
        // 摘要在这里组装而非服务端：子 Agent 的耗时/token/轮次是 run 结束后才
        // 聚合到 block.subagent 上的，而 tool_use 行在派发时就已写出。
        // 字段全部取自 durable 事件的真实聚合值，不含任何推算。
        const presentation = subagentPresentation(agentType, subagentStatus, block.subagent);
        return {
          id,
          type: "subagent",
          ...(presentation ? { presentation } : {}),
          toolId: block.toolId || "",
          agentType,
          status: subagentStatus,
          ...(block.subagent?.childSessionId ? { childSessionId: block.subagent.childSessionId } : {}),
          ...(block.subagent?.childRunId ? { childRunId: block.subagent.childRunId } : {}),
          ...(block.subagent?.model ? { model: block.subagent.model } : {}),
          ...(typeof block.subagent?.durationMs === "number" ? { durationMs: block.subagent.durationMs } : {}),
          ...(typeof block.subagent?.totalTokens === "number" ? { totalTokens: block.subagent.totalTokens } : {}),
          ...(typeof block.subagent?.toolUseCount === "number" ? { toolUseCount: block.subagent.toolUseCount } : {}),
          ...(typeof block.subagent?.turnCount === "number" ? { turnCount: block.subagent.turnCount } : {}),
          ...(block.subagent?.errorMessage ? { errorMessage: block.subagent.errorMessage } : {}),
          ...(resultPreview ? { resultPreview } : {}),
        };
      }
      const resolvedName = resolveDisplayToolName({
        toolId: block.toolId || "",
        toolName: block.toolName || "unknown",
        toolInput: block.content,
      });
      return {
        id,
        type: "tool_use",
        toolName: resolvedName,
        toolInput: block.content,
        toolId: block.toolId || "",
        streaming: false,
        ...(typeof block.durationMs === "number" ? { durationMs: block.durationMs } : {}),
        ...(block.executionStatus
          ? { executionStatus: block.executionStatus }
          : resultText !== undefined
            ? { executionStatus: "completed" as const }
            : {}),
        ...(resultText !== undefined ? { result: resultText, resultReady: true } : {}),
        ...(presentation ? { presentation } : {}),
        ...(toolMetadata ? { toolMetadata } : {}),
        // 只有「带业务摘要」的块才允许默认展开——原始 payload 不因 defaultOpen 上主流。
        // 真实会话 parse.ts 对 tool_use 恒写 defaultOpen:false，此通道现阶段仅剧本使用。
        ...(presentation && block.defaultOpen ? { defaultExpanded: true } : {}),
      };
    }

    case "tool_result": {
      if (INTERACTIVE_RESULT_TOOLS.has(block.toolName || "")) return null;
      if (block.toolId && toolResultMap.has(block.toolId)) return null;
      // 仅对「孤儿」tool_result 生效：已与 tool_use 配对的在上一行就 return null 了。
      // 正常链路里 presentation 由 parse 阶段反向嫁接到 tool_use block，走 :292 那条路。
      const resultPresentation = normalizeToolPresentation(block.presentation);
      const resolvedResultName = resolveDisplayToolName({
        toolId: block.toolId || "",
        toolName: block.toolName || "unknown",
        toolInput: "",
      });
      return {
        id,
        type: "tool_result",
        toolName: resolvedResultName,
        result: block.content,
        toolId: block.toolId || "",
        ...(resultPresentation ? { presentation: resultPresentation } : {}),
      };
    }

    case "meta":
      return null;
    default:
      return null;
  }
}

/**
 * Convert session detail to MessageItem array.
 * Two-pass scan: build toolId→result map, then convert each block.
 */
export function mapSessionDetailToMessages(detail: ApiSessionDetail, owner?: string): MessageItem[] {
  const toolResultMap = new Map<string, string>();
  for (const block of detail.blocks) {
    if (block.kind === "tool_result" && block.toolId) {
      toolResultMap.set(block.toolId, block.content);
    }
  }

  const messages: MessageItem[] = [];
  for (const block of detail.blocks) {
    const msg = mapBlock(block, toolResultMap, owner);
    if (msg) messages.push(msg);
    if (block.kind === "text") {
      messages.push(...extractFileMessages(block.id, block.content, owner));
    }
  }

  // Cron 会话：第一条 user 消息只显示任务名称
  if (detail.source?.type === 'cron') {
    const firstUser = messages.find(m => m.type === 'user');
    if (firstUser && firstUser.type === 'user') {
      firstUser.displayContent = `正在执行「${detail.source.label}」`;
    }
  }

  return messages;
}
