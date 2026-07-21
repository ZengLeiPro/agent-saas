import path from 'node:path';

import { splitByMessageMarkers } from '../../../../shared/src/lib/markers.js';
import type { TranscriptBlock } from '../transcripts/parse.js';
import type { SessionShareSnapshot } from './store.js';

export interface SessionShareAllowedFile {
  relativePath: string;
  fileName: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  /** 只在持久化快照内存在；公开投影永远剥离。 */
  contentBase64?: string;
}

export class SessionShareProjectionError extends Error {
  readonly code = 'SESSION_SHARE_SENSITIVE_CONTENT';

  constructor(message = '会话包含凭据或个人敏感信息，不能直接公开分享') {
    super(message);
    this.name = 'SessionShareProjectionError';
  }
}

const SENSITIVE_PUBLIC_SHARE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '私钥', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { label: 'Bearer 凭据', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i },
  { label: 'Basic 凭据', pattern: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/=]{8,}/i },
  { label: 'API 凭据', pattern: /\b(?:sk|ghp|github_pat|glpat|npm_|xox[baprs]|AIza|LTAI|AKIA|ASIA)[-_A-Za-z0-9]{12,}\b/i },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { label: '连接凭据', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:[^@\s/]+@/i },
  { label: '密码或 Token', pattern: /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token)\s*[:=：]\s*["']?[^\s,;'"，；]{6,}/i },
  { label: '密码或 Token', pattern: /(?:密码|密钥|令牌)\s*[:=：]\s*[^\s,;，；]{6,}/ },
  { label: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { label: '身份证号', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { label: '银行卡号', pattern: /(?<!\d)(?:\d[ -]?){16,19}(?!\d)/ },
  { label: '电子邮箱', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: '内部运行标识', pattern: /\b(?:run|request|tenant)[_\s-]?id\b/i },
  { label: '内部错误码', pattern: /(?:错误码|错误代码|error[_\s-]?code|status[_\s-]?code)\s*[:=：]?\s*[A-Z0-9][A-Z0-9_.:-]{2,}/i },
  { label: '内部错误码', pattern: /\bHTTP\s*[45]\d{2}\b/i },
  { label: '内部错误码', pattern: /\b(?:ERR|ERROR)_[A-Z0-9_]{3,}\b/i },
  { label: '内部错误码', pattern: /\b(?:E_[A-Z0-9_]{3,}|(?:PROVIDER|UPSTREAM|GATEWAY|MODEL|SERVICE)_[A-Z0-9_]{3,}|[A-Z0-9_]{3,}_(?:ERROR|FAILED|FAILURE|TIMEOUT|UNAVAILABLE|BAD_GATEWAY|RATE_LIMITED|OVERLOADED))\b/ },
  { label: '技术归因', pattern: /上游(?:模型|服务|接口|系统|网关|API|提供商|厂商)/i },
];

/** 分享附件只允许工作台规范目录中的显式相对路径。 */
export function normalizeSessionShareFilePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (parts[0] !== 'assets' && parts[0] !== 'uploads') return null;
  return parts.join('/');
}

function assertPublicShareTextSafe(text: string): void {
  const hit = SENSITIVE_PUBLIC_SHARE_PATTERNS.find(({ pattern }) => pattern.test(text));
  if (hit) throw new SessionShareProjectionError(`会话包含${hit.label}，请先脱敏后再分享`);
}

function filterFileMarkers(content: string, selectedPaths: ReadonlySet<string>): string {
  return content.replace(/\[FILE\]\s*(\{[\s\S]*?\})\s*\[\/FILE\]/g, (marker, rawJson: string) => {
    try {
      const parsed = JSON.parse(rawJson) as { filePath?: unknown };
      const normalized = typeof parsed.filePath === 'string'
        ? normalizeSessionShareFilePath(parsed.filePath)
        : null;
      return normalized && selectedPaths.has(normalized) ? marker : '[成果文件未公开]';
    } catch {
      return '[成果文件未公开]';
    }
  });
}

function publicBlock(block: TranscriptBlock, selectedPaths: ReadonlySet<string>): TranscriptBlock | null {
  if (block.kind !== 'prompt' && block.kind !== 'text') return null;
  const attachments = block.attachments
    ?.map((attachment) => {
      const relativePath = attachment.relativePath
        ? normalizeSessionShareFilePath(attachment.relativePath)
        : null;
      if (!relativePath || !selectedPaths.has(relativePath)) return null;
      return {
        name: path.basename(relativePath),
        ...(attachment.isImage ? { isImage: true } : {}),
        relativePath,
      };
    })
    .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);

  const content = filterFileMarkers(block.content, selectedPaths);
  assertPublicShareTextSafe(`${block.title ?? ''}\n${content}`);
  return {
    id: block.id,
    ...(block.tsMs !== undefined ? { tsMs: block.tsMs } : {}),
    kind: block.kind,
    title: block.title,
    defaultOpen: false,
    content,
    ...(block.isError ? { isError: true } : {}),
    ...(block.isVoiceTranscript ? { isVoiceTranscript: true } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function collectSessionShareCandidateFiles(blocks: TranscriptBlock[]): SessionShareAllowedFile[] {
  const filePaths = new Set<string>();
  for (const block of blocks) {
    for (const attachment of block.attachments ?? []) {
      const normalized = attachment.relativePath
        ? normalizeSessionShareFilePath(attachment.relativePath)
        : null;
      if (normalized) filePaths.add(normalized);
    }
    for (const segment of splitByMessageMarkers(block.content)) {
      if (segment.type !== 'file') continue;
      const normalized = normalizeSessionShareFilePath(segment.filePath);
      if (normalized) filePaths.add(normalized);
    }
  }
  return [...filePaths]
    .sort((left, right) => left.localeCompare(right))
    .map((relativePath) => ({ relativePath, fileName: path.basename(relativePath) }));
}

/**
 * 旧分享与新建分享统一走安全投影：只保留用户/助手正文，彻底移除 thinking、
 * tool_use、tool_result、raw、runId 与原始账号标识；附件只留下快照显式 allowlist。
 */
export function projectSessionShareSnapshot(
  snapshot: SessionShareSnapshot,
  options: { selectedFilePaths?: readonly string[] } = {},
): SessionShareSnapshot {
  const selectedPaths = new Set(
    options.selectedFilePaths
      ?? (snapshot.allowedFiles ?? []).map((file) => file.relativePath),
  );
  const blocks = snapshot.blocks
    .map((block) => publicBlock(block, selectedPaths))
    .filter((block): block is TranscriptBlock => block !== null);
  const allowedFiles = (snapshot.allowedFiles ?? collectSessionShareCandidateFiles(snapshot.blocks))
    .filter((file) => selectedPaths.has(file.relativePath))
    .map((file) => {
      assertPublicShareTextSafe(file.fileName);
      return {
        relativePath: file.relativePath,
        fileName: file.fileName,
        // 完整性哈希只保存在冻结快照内供下载时复验，不进入匿名分享 DTO。
        ...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
        ...(file.contentType ? { contentType: file.contentType } : {}),
      };
    });
  return {
    sessionId: 'shared-session',
    stats: {
      lines: blocks.length,
      parsedLines: blocks.length,
      parseErrors: 0,
    },
    blocks,
    owner: {
      userId: 'shared-user',
      username: '用户',
      realName: '用户',
    },
    allowedFiles,
  };
}
