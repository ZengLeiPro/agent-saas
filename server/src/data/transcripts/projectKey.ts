/**
 * Legacy transcript path utilities.
 *
 * New Agent SaaS-owned transcript projections live under:
 *   ~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/<sessionId>.jsonl
 *
 */
import * as os from "node:os";
import * as path from "node:path";

/** New canonical root for Agent SaaS legacy transcript projections. */
export const AGENT_LEGACY_TRANSCRIPTS_ROOT = path.join(
  os.homedir(),
  ".agent-saas",
  "legacy-transcripts",
);

/** Canonical root used by runtime projections and migration helpers. */
export const ALLOWED_ROOT = AGENT_LEGACY_TRANSCRIPTS_ROOT;

export interface TranscriptOwnerRef {
  tenantId?: string;
  userId?: string;
}

/** 从工作目录推导 ownerless dev/test transcript bucket 名。 */
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

/** Ownerless dev/test sessions stay under Agent SaaS storage. */
export function getAnonymousAgentTranscriptDir(cwd: string): string {
  return path.join(
    AGENT_LEGACY_TRANSCRIPTS_ROOT,
    "__anonymous",
    safePathSegment(deriveProjectKey(cwd)),
  );
}

export function getProjectDir(cwd: string): string {
  return getAnonymousAgentTranscriptDir(cwd);
}

function isInsideRoot(resolved: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const allowedPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  return resolved === resolvedRoot || resolved.startsWith(allowedPrefix);
}

/** 安全校验：确保路径在 Agent SaaS transcript 根下。 */
export function assertAllowedTranscriptPath(transcriptPath: string): string {
  const resolved = path.resolve(transcriptPath);
  if (isInsideRoot(resolved, AGENT_LEGACY_TRANSCRIPTS_ROOT)) {
    return resolved;
  }
  throw new Error("Transcript path is outside allowed directories");
}

/**
 * 校验 sessionId 格式（UUID v4 或 UUID 样式）。
 *
 * 2026-07-06 起额外接受 `sub-<uuid>`：子 agent hidden session 的服务端生成 id
 * （runtime/subagent/subagentRunner.ts，D2——前缀让日志 / Run Trace 一眼可辨）。
 * 字符集不变（固定前缀字面量 + hex + 连字符），不引入路径穿越面；会话列表仍按
 * meta.kind='subagent' 过滤，放行该 id 只是让 detail / catalog 能按 id 找回子会话。
 */
export function isValidSessionId(sessionId: string): boolean {
  const uuidPattern = /^(?:sub-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuidPattern.test(sessionId);
}
