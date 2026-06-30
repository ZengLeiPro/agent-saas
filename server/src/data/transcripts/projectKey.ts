/**
 * Legacy transcript path utilities.
 *
 * New Agent SaaS-owned transcript projections live under:
 *   ~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/<sessionId>.jsonl
 *
 * The old Claude-compatible root is retained only for explicit migration utilities:
 *   ~/.claude/projects/<cwd-derived-projectKey>/<sessionId>.jsonl
 */
import * as os from "node:os";
import * as path from "node:path";

/** New canonical root for Agent SaaS legacy transcript projections. */
export const AGENT_LEGACY_TRANSCRIPTS_ROOT = path.join(
  os.homedir(),
  ".agent-saas",
  "legacy-transcripts",
);

/** Old Claude Code / Agent SDK transcript root kept for migration fallback. */
export const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

/** Backward-compatible alias for legacy migration code that still scans Claude projects. */
export const ALLOWED_ROOT = CLAUDE_PROJECTS_ROOT;

export interface TranscriptOwnerRef {
  tenantId?: string;
  userId?: string;
}

/**
 * 从工作目录推导旧 Claude projectKey。
 *
 * 仅用于读取/迁移旧 ~/.claude/projects 布局；新 Agent SaaS transcript 路径
 * 不再由 cwd 决定。
 */
export function deriveProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function safePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function hasTranscriptOwnerRef(owner?: TranscriptOwnerRef): owner is Required<TranscriptOwnerRef> {
  return Boolean(owner?.tenantId && owner?.userId);
}

/** New canonical per-tenant/per-user transcript directory. */
export function getAgentTranscriptDir(owner: Required<TranscriptOwnerRef>): string {
  return path.join(
    AGENT_LEGACY_TRANSCRIPTS_ROOT,
    safePathSegment(owner.tenantId),
    safePathSegment(owner.userId),
  );
}

/** Ownerless dev/test sessions stay under Agent SaaS storage, not ~/.claude/projects. */
export function getAnonymousAgentTranscriptDir(cwd: string): string {
  return path.join(
    AGENT_LEGACY_TRANSCRIPTS_ROOT,
    "__anonymous",
    safePathSegment(deriveProjectKey(cwd)),
  );
}

/** Old Claude-compatible project directory for cwd-derived transcripts. */
export function getClaudeProjectDir(cwd: string): string {
  const projectKey = deriveProjectKey(cwd);
  return path.join(CLAUDE_PROJECTS_ROOT, projectKey);
}

/**
 * 获取指定 cwd 对应的旧 project 目录。
 * Kept for explicit legacy migration/debug tools that need the Claude-compatible path.
 */
export function getProjectDir(cwd: string): string {
  return getClaudeProjectDir(cwd);
}

function isInsideRoot(resolved: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const allowedPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  return resolved === resolvedRoot || resolved.startsWith(allowedPrefix);
}

/**
 * 安全校验：确保路径在新 Agent SaaS transcript 根或旧 Claude fallback 根下。
 */
export function assertAllowedTranscriptPath(transcriptPath: string): string {
  const resolved = path.resolve(transcriptPath);
  if (
    isInsideRoot(resolved, AGENT_LEGACY_TRANSCRIPTS_ROOT) ||
    isInsideRoot(resolved, CLAUDE_PROJECTS_ROOT)
  ) {
    return resolved;
  }
  throw new Error("Transcript path is outside allowed directories");
}

/**
 * 校验 sessionId 格式（UUID v4 或 UUID 样式）
 */
export function isValidSessionId(sessionId: string): boolean {
  const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuidPattern.test(sessionId);
}
