/**
 * Session transcript → MessageItem mapping functions.
 * Platform-agnostic: no browser-specific APIs.
 */

import type { MessageItem } from '../types/message';
import type { ApiSessionDetail, ApiTranscriptBlock } from '../types/session';
import { resolveDisplayToolName } from './toolDisplay';

// -- Interactive tool history restore --

const INTERACTIVE_RESULT_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

function parseAnswersFromResult(
  resultText: string,
  knownQuestions?: string[],
): Record<string, string> {
  const answers: Record<string, string> = {};
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
        ? input.answers as Record<string, string>
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
      return {
        id, type: "user", content: parsed.text,
        ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
        ...(parsed.isVoiceTranscript || block.isVoiceTranscript ? { isVoiceTranscript: true } : {}),
        timestamp: block.tsMs,
      };
    }
    case "text":
      return { id, type: "text", content: block.content, streaming: false, ...(owner ? { owner } : {}), timestamp: block.tsMs };
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
      if (block.toolName === "AskUserQuestion") {
        return tryConvertAskUser(block, resultText);
      }
      if (block.toolName === "EnterPlanMode" || block.toolName === "ExitPlanMode") {
        return tryConvertPlanMode(block, resultText);
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
        ...(resultText !== undefined ? { result: resultText, resultReady: true } : {}),
      };
    }

    case "tool_result": {
      if (INTERACTIVE_RESULT_TOOLS.has(block.toolName || "")) return null;
      if (block.toolId && toolResultMap.has(block.toolId)) return null;
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
