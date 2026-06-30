/**
 * Tool display utilities — tool name resolution + description extraction.
 *
 * Pure functions, no runtime dependencies. Used by:
 * - Server streaming path (eventConsumer → toolNameResolver)
 * - Client transcript loading (sessionsApi → mapBlock)
 * - Client render layer (ToolBlock / ActivityGroup)
 */

// ============================================
// Tool Name Resolution
// ============================================

export interface ResolveToolNameParams {
  toolId: string;
  toolName: string;
  toolInput: string;
}

export type ToolNameResolver = (params: ResolveToolNameParams) => string;

export interface ToolNameStrategyParams extends ResolveToolNameParams {
  currentName: string;
}

export type ToolNameStrategy = (params: ToolNameStrategyParams) => string | undefined;

const INTERNAL_TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task',
  skill: 'Skill',
};

export const normalizeInternalToolNameStrategy: ToolNameStrategy = ({ currentName }) => {
  const normalized = INTERNAL_TOOL_NAME_MAP[currentName.toLowerCase()];
  return normalized === currentName ? undefined : normalized;
};

export const resolveMcpToolNameStrategy: ToolNameStrategy = ({ currentName }) => {
  if (!currentName.startsWith('mcp__')) {
    return undefined;
  }

  const parts = currentName.split('__');
  if (parts.length >= 3) {
    const serverName = parts[1];
    const toolName = parts.slice(2).join('__');
    return `MCP:${serverName}/${toolName}`;
  }

  const rest = currentName.slice('mcp__'.length) || 'unknown';
  return `MCP:${rest}`;
};

export const resolveSkillToolNameStrategy: ToolNameStrategy = ({ currentName, toolInput }) => {
  if (currentName.startsWith('Skill:')) {
    return undefined;
  }
  if (currentName !== 'Skill' || !toolInput) {
    return undefined;
  }

  try {
    const params = JSON.parse(toolInput) as { skill?: unknown };
    const rawSkill = params?.skill;
    const skillName = typeof rawSkill === 'string' && rawSkill.trim()
      ? rawSkill.trim()
      : '未知';
    return `Skill:${skillName}`;
  } catch {
    return undefined;
  }
};

export function composeToolNameResolver(strategies: ToolNameStrategy[]): ToolNameResolver {
  return (params) => {
    let currentName = params.toolName;

    for (const strategy of strategies) {
      const next = strategy({ ...params, currentName });
      if (next) {
        currentName = next;
      }
    }

    return currentName;
  };
}

/**
 * Display-layer tool name resolver (composable strategies):
 * 1) Normalize internal tool names (bash → Bash)
 * 2) Format MCP tool names (mcp__server__tool → MCP:server/tool)
 * 3) Parameterize Skill names (Skill → Skill:commit)
 */
export const resolveDisplayToolName: ToolNameResolver = composeToolNameResolver([
  normalizeInternalToolNameStrategy,
  resolveMcpToolNameStrategy,
  resolveSkillToolNameStrategy,
]);

/** Check if a tool name refers to a Skill tool (e.g. "Skill", "Skill:commit") */
export function isSkillTool(toolName: string | undefined): boolean {
  return toolName === 'Skill' || (toolName?.startsWith('Skill:') ?? false);
}

// ============================================
// Tool Detail Extraction
// ============================================

/** Tools that use `file_path` as their primary detail */
const FILE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit']);

/** Tools that use `pattern` as their primary detail */
const PATTERN_TOOLS = new Set(['Grep', 'Glob']);

/**
 * Extract the `description` field from a tool's JSON input.
 * Returns undefined if input is unparseable (e.g. streaming partial JSON) or has no description.
 */
export function extractToolDescription(toolInput: string): string | undefined {
  if (!toolInput) return undefined;
  try {
    const parsed = JSON.parse(toolInput);
    return typeof parsed?.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Extract a string field from toolInput JSON. */
function extractStringField(toolInput: string, field: string): string | undefined {
  if (!toolInput) return undefined;
  try {
    const parsed = JSON.parse(toolInput);
    const val = parsed?.[field];
    return typeof val === 'string' && val.trim() ? val.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Extract `file_path` from toolInput JSON. */
function extractFilePath(toolInput: string): string | undefined {
  return extractStringField(toolInput, 'file_path');
}

// ============================================
// Structured Display Info
// ============================================

export interface ToolDisplayInfo {
  /** Tool name (e.g. "Bash", "Read") */
  name: string;
  /** Optional detail text (description or file_path) */
  detail?: string;
  /** How to truncate the detail when it overflows: 'end' for descriptions, 'start' for file paths */
  detailTruncate: 'end' | 'start';
}

/**
 * Get structured display info for a tool call.
 * Components use this to render name + detail with appropriate truncation direction.
 */
export function getToolDisplayInfo(toolName: string, toolInput: string): ToolDisplayInfo {
  // Try description first (Bash, Agent, etc.)
  const desc = extractToolDescription(toolInput);
  if (desc) {
    return { name: toolName, detail: desc, detailTruncate: 'end' };
  }

  // Try file_path for Read/Write/Edit
  if (FILE_PATH_TOOLS.has(toolName)) {
    const filePath = extractFilePath(toolInput);
    if (filePath) {
      return { name: toolName, detail: filePath, detailTruncate: 'start' };
    }
  }

  // Try pattern for Grep/Glob
  if (PATTERN_TOOLS.has(toolName)) {
    const pattern = extractStringField(toolInput, 'pattern');
    if (pattern) {
      return { name: toolName, detail: pattern, detailTruncate: 'end' };
    }
  }

  return { name: toolName, detailTruncate: 'end' };
}

/**
 * Build a plain-text display label: "ToolName: detail" or just "ToolName".
 * Used by summaries that don't need structured rendering.
 * Safe to call during streaming (partial JSON simply returns toolName only).
 */
export function getToolDisplayLabel(toolName: string, toolInput: string): string {
  const info = getToolDisplayInfo(toolName, toolInput);
  return info.detail ? `${info.name}: ${info.detail}` : info.name;
}
