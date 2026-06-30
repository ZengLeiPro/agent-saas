import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';

import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

// 注意：JS string.length 是 UTF-16 code units（≈字符数），不是字节数。CJK 内容
// 下 1 字符 ≈ 3 字节，所以 64K chars ≈ 192KB UTF-8 体积，仍在合理 context 范围内。
// 保留以 CHARS 命名，避免与 _BYTES 单位混淆。
const MAX_SKILL_DOC_CHARS = 64 * 1024;
// Skill 名字校验：与 routes/skills.ts safeName 同口径，防 path traversal。
const SAFE_SKILL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
function isSafeSkillName(skill: string): boolean {
  return SAFE_SKILL_NAME_RE.test(skill);
}

type SkillInput = {
  skill: string;
  args?: string;
};

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
}

/**
 * Effective skill 解析器。dispatch 时调用方按用户 username 计算"对该用户可见 + 已选"的
 * skill 集合，注入到 SkillToolProvider，提供给：
 *   1. L1 注入 buildInstructions（让模型知道这些 skill 存在）
 *   2. Skill 工具调用时的校验白名单（防越权读 pool 隐藏的 skill）
 */
export interface EffectiveSkillsResolver {
  list(context: ToolCallContext): SkillEntry[];
  /**
   * 解析 skill 物理路径。需要在 SkillToolProvider 之外注入，因为这一层
   * 不知道 sharedDir / agentCwd / username 推导规则。
   *
   * 返回 null = 找不到，工具会回错误信息。
   */
  resolveSkillDir(skill: string, context: ToolCallContext): string | null;
}

export const skillToolDescriptor: ToolDescriptor<SkillInput> = {
  id: 'Skill',
  name: 'Skill',
  displayName: 'Skill',
  description: loadToolDescription('Skill'),
  schema: z.object({
    skill: z.string().min(1).describe('Skill name from the available-skills list, e.g. "image-gen", "case-study".'),
    args: z.string().optional().describe('Optional plain-text arguments forwarded into the skill body.'),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'skill.invoke',
};

export class SkillToolProvider implements ToolProvider {
  constructor(private readonly resolver: EffectiveSkillsResolver) {}

  list(): ToolDescriptor[] {
    return [skillToolDescriptor];
  }

  /**
   * 为 buildInstructions 提供"当前 context 下可见的 skill 名单 + 描述"。
   * 调用方负责按 username 派生 effective 集合。
   */
  listAvailableSkills(context: ToolCallContext): SkillEntry[] {
    return this.resolver.list(context);
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== skillToolDescriptor.id) return undefined;
    const input = skillToolDescriptor.schema.parse(call.input) as SkillInput;
    // δ: 防御性 safeName，拒绝 path traversal 字符与隐藏目录
    if (!isSafeSkillName(input.skill)) {
      return {
        content: `Skill "${input.skill}" 名字非法（必须 ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$）。`,
      };
    }
    const allowed = this.resolver.list(context).some((s) => s.name === input.skill || s.id === input.skill);
    if (!allowed) {
      return {
        content:
          `Skill "${input.skill}" 当前用户不可用。请用 <available-skills> 里列出的 name 调用，`
            + `若需新 skill 请联系 admin 在 pool 中开启。`,
      };
    }
    const skillDir = this.resolver.resolveSkillDir(input.skill, context);
    if (!skillDir || !existsSync(skillDir)) {
      return { content: `Skill "${input.skill}" 物理目录不存在（resolver 解析为 ${skillDir ?? 'null'}）。` };
    }

    const docPath = getSkillDocPath(skillDir, input.skill);
    if (!docPath || !existsSync(docPath)) {
      return {
        content: `Skill "${input.skill}" 缺少 SKILL.md 或 ${input.skill}.md（约定的两种命名都没找到）。`,
      };
    }

    let body = await readFile(docPath, 'utf-8');
    if (body.length > MAX_SKILL_DOC_CHARS) {
      body = body.slice(0, MAX_SKILL_DOC_CHARS)
        + `\n\n...[truncated at ${MAX_SKILL_DOC_CHARS} chars; use Read on this skill's reference docs for the rest]`;
    }

    const argsLine = input.args ? `\n\n<skill-args>\n${input.args}\n</skill-args>` : '';
    const hint =
      `\n\n---\n`
      + `（提示：上面 SKILL.md 可能引用 references/*.md 或 scripts/*；如有，请用 Read 按需加载，路径相对于 ${skillDir}。）`;

    return {
      content: `<skill-doc name="${input.skill}" path="${basename(docPath)}">\n${body}\n</skill-doc>${argsLine}${hint}`,
    };
  }
}

/**
 * 严格命名约定：只查 SKILL.md 或 <skillId>.md，不再退化到 "唯一 .md 文件"，
 * 避免 pool 里偶然出现的 NOTES.md / README.md 被误当成 skill 文档对模型公开。
 */
function getSkillDocPath(skillDir: string, skillId: string): string | null {
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (existsSync(skillMdPath)) return skillMdPath;

  const namedMdPath = join(skillDir, `${skillId}.md`);
  if (existsSync(namedMdPath)) return namedMdPath;

  return null;
}
