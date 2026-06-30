/**
 * Memory & Agent Context Loader
 *
 * 读取工作区 MEMORY.md 和 agents.md，供 runner.ts 注入到 systemPrompt 中。
 * - MEMORY.md：长期记忆上下文
 * - agents.md：per-user Agent 指令（替代 SDK 自动加载的 CLAUDE.md）
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * 将 PERSONA.md 拆分为编辑器注释（hints）和实际人格定义（body）。
 * 头部的 # 标题、> 引用和空行属于 hints，其余为 body。
 */
export function parsePersona(content: string): { hints: string; body: string } {
  const lines = content.split('\n');
  let headerEnd = 0;
  const hintLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('>') || trimmed === '') {
      if (trimmed.startsWith('>')) hintLines.push(trimmed.slice(1).trim());
      headerEnd = i + 1;
    } else {
      break;
    }
  }
  return { hints: hintLines.join('\n').trim(), body: lines.slice(headerEnd).join('\n').trim() };
}

const DEFAULT_MAX_LINES = 200;
const PERSONA_MAX_LINES = 500;

/**
 * 从工作区加载 MEMORY.md 内容
 * 文件不存在或为空时返回 null
 */
export async function loadMemoryContext(
  agentCwd: string,
  maxLines: number = DEFAULT_MAX_LINES,
): Promise<string | null> {
  const memoryPath = join(agentCwd, 'MEMORY.md');
  try {
    const content = await readFile(memoryPath, 'utf-8');
    const trimmed = content.trim();
    if (!trimmed) return null;

    const lines = trimmed.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n...[截断，共 ${lines.length} 行]`;
    }
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * 从用户工作区加载 PERSONA.md 内容
 * 文件不存在或为空时返回 null
 */
export async function loadPersona(
  agentCwd: string,
  maxLines: number = PERSONA_MAX_LINES,
): Promise<string | null> {
  const personaPath = join(agentCwd, 'PERSONA.md');
  try {
    const content = await readFile(personaPath, 'utf-8');
    const trimmed = content.trim();
    if (!trimmed) return null;

    // 剥离编辑器注释（标题 + blockquote），只注入实际人格定义
    const { body } = parsePersona(trimmed);
    if (!body) return null;

    const lines = body.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n...[截断，共 ${lines.length} 行]`;
    }
    return body;
  } catch {
    return null;
  }
}


