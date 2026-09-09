import { z } from 'zod';

import {
  generateUtilityTextWithFallback,
  type TitleGenerationOptions,
  type TitleGeneratorConfig,
} from './titleGenerator.js';

export const SESSION_GROUPING_SYSTEM_PROMPT = `你的唯一任务是把一组会话整理成清晰、稳定的会话分组。禁止调用工具，禁止执行命令，禁止输出解释。
规则：
- 只能使用输入中提供的 sessionId，不得编造、改写或遗漏
- 分组名称使用会话主要语言，简洁明确，不超过 15 个汉字或 8 个英文单词
- 优先形成可长期复用的业务主题，避免只有一个会话的分组；无法可靠归类时放入 ungroupedSessionIds
- 最多返回 12 个分组，同一个 sessionId 只能出现一次
- 只输出 JSON：{"groups":[{"name":"分组名","sessionIds":["id"]}],"ungroupedSessionIds":["id"]}`;

export interface SessionGroupingCandidate {
  sessionId: string;
  title: string;
  userMessages: string[];
  assistantReplies: string[];
}

export interface SessionGroupingSuggestion {
  groups: Array<{ name: string; sessionIds: string[] }>;
  ungroupedSessionIds: string[];
}

const responseSchema = z.object({
  groups: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(30),
        sessionIds: z.array(z.string()).max(100),
      }),
    )
    .max(12),
  ungroupedSessionIds: z.array(z.string()).max(100).default([]),
});

function parseJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return JSON.parse(source);
}

export function validateSessionGroupingSuggestion(
  raw: string,
  allowedSessionIds: readonly string[],
): SessionGroupingSuggestion {
  const parsed = responseSchema.parse(parseJsonObject(raw));
  const allowed = new Set(allowedSessionIds);
  const assigned = new Set<string>();
  const grouped = new Set<string>();
  const groupedByName = new Map<string, { name: string; sessionIds: string[] }>();
  parsed.groups.forEach((group) => {
    const sessionIds = group.sessionIds.filter((sessionId) => {
      if (!allowed.has(sessionId)) throw new Error(`智能分组返回了未知会话：${sessionId}`);
      if (assigned.has(sessionId)) throw new Error(`智能分组重复返回会话：${sessionId}`);
      assigned.add(sessionId);
      grouped.add(sessionId);
      return true;
    });
    const key = group.name.toLocaleLowerCase();
    const existing = groupedByName.get(key);
    if (existing) existing.sessionIds.push(...sessionIds);
    else if (sessionIds.length > 0) groupedByName.set(key, { name: group.name, sessionIds });
  });
  for (const sessionId of parsed.ungroupedSessionIds) {
    if (!allowed.has(sessionId)) throw new Error(`智能分组返回了未知会话：${sessionId}`);
    if (assigned.has(sessionId)) throw new Error(`智能分组重复返回会话：${sessionId}`);
    assigned.add(sessionId);
  }
  return {
    groups: [...groupedByName.values()],
    ungroupedSessionIds: allowedSessionIds.filter((sessionId) => !grouped.has(sessionId)),
  };
}

export async function generateSessionGroupingSuggestion(input: {
  candidates: SessionGroupingCandidate[];
  existingGroupNames: string[];
  configs: TitleGeneratorConfig[];
  systemPrompt: string;
  options?: Omit<TitleGenerationOptions, 'systemPrompt'>;
}): Promise<SessionGroupingSuggestion | null> {
  const userPrompt = JSON.stringify({
    existingGroupNames: input.existingGroupNames,
    sessions: input.candidates.map((candidate) => ({
      sessionId: candidate.sessionId,
      title: candidate.title,
      userMessages: candidate.userMessages.map((message) => message.slice(0, 500)),
      assistantReplies: candidate.assistantReplies.map((message) => message.slice(0, 500)),
    })),
  });
  const raw = await generateUtilityTextWithFallback(userPrompt, input.configs, {
    ...input.options,
    systemPrompt: input.systemPrompt,
    maxOutputTokens: 4096,
    timeoutMs: 45_000,
  });
  if (!raw) return null;
  return validateSessionGroupingSuggestion(
    raw,
    input.candidates.map((candidate) => candidate.sessionId),
  );
}
