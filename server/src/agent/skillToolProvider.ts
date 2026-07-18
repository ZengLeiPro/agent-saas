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
 *   1. Skill 工具 description 里的「当前用户可用 Skill 清单」（模型选择 skill 的唯一来源）
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

// 基础描述加载一次。动态部分（当前用户 skill 清单）在 SkillToolProvider.list(context)
// 时按用户拼接进来——工具 schema 是模型注意力最集中的位置。原 system prompt 里的
// <available-skills> xml section 已删（2026-07-03），此处是唯一权威来源。
const BASE_SKILL_DESCRIPTION = loadToolDescription('Skill');

export const skillToolDescriptor: ToolDescriptor<SkillInput> = {
  id: 'Skill',
  name: 'Skill',
  displayName: '技能',
  description: BASE_SKILL_DESCRIPTION,
  schema: z.object({
    // 不写 "e.g." + 具体 skill 名——历史上写过 "image-gen"/"case-study"，case-study 07-01 已删，
    // 对 xml 注意力弱的模型会把示例误当实际可用 skill 幻觉调用。改指向工具描述里动态注入的清单。
    skill: z.string().min(1).describe('技能名称——必须与下方“当前用户可用技能清单”中的 name 完全一致，不要根据其他示例猜测。'),
    args: z.string().optional().describe('可选的纯文本参数，会传入技能正文。'),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'skill.invoke',
  category: 'skill',
  label: '调用技能',
};

/**
 * 把用户当前可用的 skill 清单拼进 Skill 工具的 description。这里是 skill 清单的唯一
 * 权威来源——工具 schema 是所有主流模型注意力最集中的位置，比 system prompt 中段的
 * xml section 稳得多。
 */
function renderSkillDescription(skills: SkillEntry[]): string {
  if (skills.length === 0) {
    return BASE_SKILL_DESCRIPTION
      + '\n\n## 当前用户可用技能清单\n\n（当前会话未启用任何技能。不要调用此工具——所有调用都会失败。）';
  }
  const lines = skills.map((s) => `- \`${s.name}\`: ${s.description}`).join('\n');
  return BASE_SKILL_DESCRIPTION
    + '\n\n## 当前用户可用技能清单（唯一可信来源）\n\n'
    + lines
    + '\n\n**重要**：只调用上面列出的技能。参数 `skill` 必须与上表中的 `name` 完全一致。'
    + '不要从其他工具的示例、SKILL.md 引用或推测出来的名字调用技能——那样调用会失败。';
}

export class SkillToolProvider implements ToolProvider {
  constructor(private readonly resolver: EffectiveSkillsResolver) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    // context 缺失（少数 warmup/dryrun 路径）时用 base description 兜底，避免抛错；
    // 真实 dispatch 都会传 context（toolRuntime.ts:1318 flatMap((p) => p.list(context))）。
    const skills = context ? this.resolver.list(context) : [];
    return [{
      ...skillToolDescriptor,
      description: renderSkillDescription(skills),
    }];
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
        content: `技能“${input.skill}”名称非法（必须 ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$）。`,
      };
    }
    const allowedSkill = this.resolver.list(context).find((s) => s.name === input.skill || s.id === input.skill);
    if (!allowedSkill) {
      return {
        content:
          `技能“${input.skill}”当前用户不可用。请使用技能工具描述中“当前用户可用技能清单”的 name 调用，`
            + `若需新技能，请联系管理员在技能池中开启。`,
      };
    }
    const skillDir = this.resolver.resolveSkillDir(input.skill, context);
    if (!skillDir || !existsSync(skillDir)) {
      return { content: `技能“${input.skill}”的物理目录不存在或尚未同步到当前 workspace。` };
    }

    const docPath = getSkillDocPath(skillDir, input.skill);
    if (!docPath || !existsSync(docPath)) {
      return {
        content: `技能“${input.skill}”缺少 SKILL.md 或 ${input.skill}.md（约定的两种命名都没找到）。`,
      };
    }

    let body = await readFile(docPath, 'utf-8');
    if (body.length > MAX_SKILL_DOC_CHARS) {
      body = body.slice(0, MAX_SKILL_DOC_CHARS)
        + `\n\n...[truncated at ${MAX_SKILL_DOC_CHARS} chars; use Read on this skill's reference docs for the rest]`;
    }

    const argsLine = input.args ? `\n\n<skill-args>\n${input.args}\n</skill-args>` : '';
    const workspaceSkillDir = `.ky-agent/skills/${allowedSkill.id}`;
    const hint =
      `\n\n---\n`
      + `（提示：上面 SKILL.md 可能引用 references/*.md 或 scripts/*；如有，请用 Read 按需加载，`
      + `workspace 相对路径为 ${workspaceSkillDir}/...。Shell 的默认 cwd 是 workspace 根；`
      + `在 Shell 里引用技能文件时使用 $(pwd)/${workspaceSkillDir}/... 或相对路径，不要使用服务端物理路径。）`;

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
