/**
 * Session Fork 模块
 *
 * 从已有会话的指定用户消息处"分叉"：截取之前的对话历史到新 JSONL，
 * 并提取该消息文本供客户端预填输入框。
 */
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { assertAllowedTranscriptPath } from "./projectKey.js";
import { writeSessionMeta, type SessionMeta } from "./meta.js";
import {
  stripMemoryContext,
  stripTimestampPrefix,
  stripVoiceSttTag,
} from "./parse.js";

export interface ForkResult {
  newSessionId: string;
  newTranscriptPath: string;
  /** 清理后的用户消息文本，供客户端预填输入框 */
  forkMessage: string;
}

export interface ForkOptions {
  sourceTranscriptPath: string;
  /** 新 JSONL 写入目录（用户的 projectKey 目录） */
  targetProjectDir: string;
  /** 前端传入的 block ID，如 "line-5-user" 或 "line-5-user-1" */
  blockId: string;
  /** 原会话的 meta（可 null） */
  sourceMeta: SessionMeta | null;
  /** 执行 fork 的用户身份（用于新会话的 meta） */
  requestUser?: { userId: string; username: string; tenantId?: string };
}

const BLOCK_ID_RE = /^line-(\d+)/;

/**
 * 从源 JSONL 指定位置分叉出新会话
 */
export async function forkSession(opts: ForkOptions): Promise<ForkResult> {
  const { sourceTranscriptPath, targetProjectDir, blockId, sourceMeta, requestUser } = opts;

  // 1. 解析目标行号
  const match = blockId.match(BLOCK_ID_RE);
  if (!match) {
    throw new Error(`Invalid blockId format: ${blockId}`);
  }
  const targetLineNumber = parseInt(match[1], 10);
  if (!Number.isFinite(targetLineNumber) || targetLineNumber < 1) {
    throw new Error(`Invalid line number in blockId: ${blockId}`);
  }

  // 2. 流式读取源 JSONL
  const resolved = assertAllowedTranscriptPath(sourceTranscriptPath);
  await fs.access(resolved);

  const rl = readline.createInterface({
    input: createReadStream(resolved, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  const truncatedLines: string[] = [];
  let forkMessage = "";
  let currentLine = 0;

  for await (const line of rl) {
    currentLine += 1;
    if (!line.trim()) continue;

    if (currentLine < targetLineNumber) {
      // 收集目标行之前的所有行
      truncatedLines.push(line);
    } else if (currentLine === targetLineNumber) {
      // 提取用户消息文本，验证目标行确实是用户消息
      forkMessage = extractUserText(line);
      if (forkMessage === "" && !isUserMessageLine(line)) {
        throw new Error(
          `Line ${targetLineNumber} is not a user message`,
        );
      }
      break; // 不需要继续读取
    }
  }

  if (currentLine < targetLineNumber) {
    throw new Error(
      `blockId line ${targetLineNumber} not found (file has ${currentLine} lines)`,
    );
  }

  // 3. 生成新会话
  const newSessionId = randomUUID();
  const newTranscriptPath = path.join(
    targetProjectDir,
    `${newSessionId}.jsonl`,
  );

  // 确保目标目录存在
  await fs.mkdir(targetProjectDir, { recursive: true });

  // 写入截断的 JSONL（空历史也合法 — 表示从第一条消息 fork）
  await fs.writeFile(newTranscriptPath, truncatedLines.join("\n") + (truncatedLines.length > 0 ? "\n" : ""));

  // 4. 写入 meta（使用请求者身份，而非源会话身份）
  if (sourceMeta || requestUser) {
    const newMeta: SessionMeta = {
      userId: requestUser?.userId ?? sourceMeta!.userId,
      username: requestUser?.username ?? sourceMeta!.username,
      ...(requestUser?.tenantId || sourceMeta?.tenantId ? { tenantId: requestUser?.tenantId ?? sourceMeta?.tenantId } : {}),
      channel: sourceMeta?.channel ?? 'web',
      createdAt: new Date().toISOString(),
      model: sourceMeta?.model,
    };
    await writeSessionMeta(newTranscriptPath, newMeta);
  }

  return { newSessionId, newTranscriptPath, forkMessage };
}

/**
 * 判断 JSONL 行是否为用户消息
 */
function isUserMessageLine(rawLine: string): boolean {
  try {
    const obj = JSON.parse(rawLine);
    return obj?.type === "user" && obj?.message?.content != null;
  } catch {
    return false;
  }
}

/**
 * 从 JSONL 行中提取用户输入的纯文本
 */
function extractUserText(rawLine: string): string {
  let obj: any;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return "";
  }

  if (obj?.type !== "user" || !obj?.message?.content) {
    return "";
  }

  const content = obj.message.content;

  // content 可能是字符串或数组
  if (typeof content === "string") {
    return cleanUserText(content);
  }

  if (Array.isArray(content)) {
    // 找第一个 type:"text" 块
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        return cleanUserText(block.text);
      }
    }
  }

  return "";
}

/**
 * 清理用户文本：去除系统注入的前缀
 */
function cleanUserText(text: string): string {
  let cleaned = stripMemoryContext(text);
  cleaned = stripTimestampPrefix(cleaned);
  cleaned = stripVoiceSttTag(cleaned);
  return cleaned.trim();
}
