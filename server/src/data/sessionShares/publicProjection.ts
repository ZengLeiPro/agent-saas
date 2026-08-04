import path from 'node:path';

import { splitByMessageMarkers } from '../../../../shared/src/lib/markers.js';
import type { TranscriptBlock } from '../transcripts/parse.js';
import type { SessionShareSnapshot } from './store.js';

export interface SessionShareAllowedFile {
  relativePath: string;
  fileName: string;
  /** 文件由正文 Markdown 直接引用，分享确认页应默认勾选。 */
  inlineInBody?: true;
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

const REDACTED_PLACEHOLDER = '[已脱敏]';

/**
 * 匿名分享正文的凭据脱敏规则（2026-08-04 收窄）。
 *
 * 只保留「命中即等于凭据泄露」的强特征：手机号、身份证、银行卡、邮箱、内部
 * 错误码与技术归因等弱规则误报率远高于收益，已整体移除。命中片段就地替换为
 * [已脱敏]，不再整场阻断分享。
 *
 * 每条都必须覆盖凭据本体（而不只是它的标题行/前缀），否则打码会留下真值。
 */
const SENSITIVE_PUBLIC_SHARE_PATTERNS: Array<{ label: string; pattern: RegExp; replacement?: string }> = [
  {
    label: '私钥',
    // 必须吃掉整个 PEM 块；缺 END 时兜底到文本末尾，宁可多脱敏也不留下私钥正文。
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*-----|$)/gi,
  },
  { label: 'Bearer 凭据', pattern: /(\bBearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, replacement: `$1${REDACTED_PLACEHOLDER}` },
  {
    label: 'Basic 凭据',
    pattern: /(\bAuthorization\s*:\s*Basic\s+)[A-Za-z0-9+/=]{8,}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
  },
  {
    label: 'API 凭据',
    // 前缀必须带原生分隔符，否则 \bsk[-_A-Za-z0-9]{12,} 会命中 skillsManagement 之类的普通标识符。
    pattern: /\b(?:sk-|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|npm_|xox[baprs]-|AIza|LTAI|AKIA|ASIA)[-_A-Za-z0-9]{12,}\b/g,
  },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    label: '连接凭据',
    pattern: /(\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/)[^:\s/@]+:[^@\s/]+@/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}@`,
  },
  {
    label: '密码或 Token',
    // 值必须像凭据：≥16 位、纯 ASCII 凭据字符且字母数字混合，避免命中中文说明文字。
    pattern: /(\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token)\s*[:=：]\s*)["']?(?=[A-Za-z0-9._+\/=-]*[A-Za-z])(?=[A-Za-z0-9._+\/=-]*\d)[A-Za-z0-9._+\/=-]{16,}["']?/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
  },
  {
    label: '密码或 Token',
    pattern: /((?:密码|密钥|令牌)\s*[:=：]\s*)["']?(?=[A-Za-z0-9._+\/=-]*[A-Za-z])(?=[A-Za-z0-9._+\/=-]*\d)[A-Za-z0-9._+\/=-]{16,}["']?/g,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
  },
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

/** 把正文里的凭据就地替换为 [已脱敏]，其余内容原样保留。 */
export function redactPublicShareText(text: string): string {
  return SENSITIVE_PUBLIC_SHARE_PATTERNS.reduce(
    (acc, { pattern, replacement }) => acc.replace(pattern, replacement ?? REDACTED_PLACEHOLDER),
    text,
  );
}

/**
 * 附件文件名不能打码——它要和 relativePath 对应上，改写会让下载链路对不上号，
 * 所以文件名保持 fail closed，命中就拒绝本次分享。
 */
function assertShareFileNameSafe(fileName: string): void {
  if (redactPublicShareText(fileName) !== fileName) {
    throw new SessionShareProjectionError('附件文件名包含凭据，请改名后再分享');
  }
}

const INLINE_MARKDOWN_MEDIA_RE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

function normalizeMarkdownMediaPath(src: string): string | null {
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // 非法 percent-encoding 保持原值，交给路径白名单拒绝。
  }
  return normalizeSessionShareFilePath(decoded);
}

/** 提取正文 Markdown 中直接展示的本地图片/视频路径。 */
function collectInlineMarkdownMediaPaths(content: string): string[] {
  const filePaths = new Set<string>();
  for (const match of content.matchAll(INLINE_MARKDOWN_MEDIA_RE)) {
    const normalized = normalizeMarkdownMediaPath(match[1]);
    if (normalized) filePaths.add(normalized);
  }
  return [...filePaths];
}

function filterInlineMarkdownMedia(content: string, selectedPaths: ReadonlySet<string>): string {
  return content.replace(INLINE_MARKDOWN_MEDIA_RE, (markdown, src: string) => {
    const normalized = normalizeMarkdownMediaPath(src);
    if (!normalized || selectedPaths.has(normalized)) return markdown;
    return '[正文媒体未公开]';
  });
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

  const content = redactPublicShareText(
    filterInlineMarkdownMedia(filterFileMarkers(block.content, selectedPaths), selectedPaths),
  );
  return {
    id: block.id,
    ...(block.tsMs !== undefined ? { tsMs: block.tsMs } : {}),
    kind: block.kind,
    title: redactPublicShareText(block.title ?? ''),
    defaultOpen: false,
    content,
    ...(block.isError ? { isError: true } : {}),
    ...(block.isVoiceTranscript ? { isVoiceTranscript: true } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function collectSessionShareCandidateFiles(blocks: TranscriptBlock[]): SessionShareAllowedFile[] {
  const files = new Map<string, SessionShareAllowedFile>();
  const addFile = (relativePath: string, inlineInBody = false) => {
    const current = files.get(relativePath);
    files.set(relativePath, {
      relativePath,
      fileName: path.basename(relativePath),
      ...(inlineInBody || current?.inlineInBody ? { inlineInBody: true } : {}),
    });
  };

  for (const block of blocks) {
    for (const attachment of block.attachments ?? []) {
      const normalized = attachment.relativePath
        ? normalizeSessionShareFilePath(attachment.relativePath)
        : null;
      if (normalized) addFile(normalized);
    }
    for (const segment of splitByMessageMarkers(block.content)) {
      if (segment.type !== 'file') continue;
      const normalized = normalizeSessionShareFilePath(segment.filePath);
      if (normalized) addFile(normalized);
    }
    for (const relativePath of collectInlineMarkdownMediaPaths(block.content)) {
      addFile(relativePath, true);
    }
  }
  return [...files.values()]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
      assertShareFileNameSafe(file.fileName);
      return {
        relativePath: file.relativePath,
        fileName: file.fileName,
        ...(file.inlineInBody ? { inlineInBody: true as const } : {}),
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
