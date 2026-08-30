import path from 'node:path';

import { isBusinessTodo, parseTodos } from '../../../../shared/src/lib/extractTodos.js';
import { normalizeToolPresentation } from '../../../../shared/src/lib/toolPresentation.js';
import { normalizeToolResultMetadata } from '../../../../shared/src/lib/toolResultMetadata.js';
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
    if (normalized) return selectedPaths.has(normalized) ? markdown : '[正文媒体未公开]';
    // 远程 https 媒体不属于工作区附件；其余 data/绝对/越界路径一律 fail closed。
    return /^https:\/\//i.test(src) ? markdown : '[正文媒体未公开]';
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

const PUBLIC_EXECUTION_STATUSES = new Set<NonNullable<TranscriptBlock['executionStatus']>>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

function clampPublicText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = redactPublicShareText(value.trim());
  return text ? text.slice(0, maxLength) : undefined;
}

/** 只在已归一化的展示结构上递归脱敏，绝不把原始工具 payload 带出分享快照。 */
function redactStructuredValue(value: unknown): unknown {
  if (typeof value === 'string') return redactPublicShareText(value);
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, redactStructuredValue(item)]),
  );
}

/** TodoWrite 是用户可见的业务呈现数据；公开页只保留归一化后的 business 项并逐字段脱敏。 */
function publicTodoWriteContent(block: TranscriptBlock): string | undefined {
  if (block.toolName !== 'TodoWrite') return undefined;
  const todos = parseTodos(block.content);
  if (todos === undefined) return undefined;
  const businessTodos = (todos ?? []).filter(isBusinessTodo);
  // empty / task-only 是完整的全量替换快照：公开页必须保留匿名 reset，
  // 否则旧业务 section 会继续吞掉后续工具与最终正文。
  return JSON.stringify({ todos: redactStructuredValue(businessTodos) });
}

function publicExecutionStatus(value: unknown): TranscriptBlock['executionStatus'] | undefined {
  if (typeof value !== 'string' || !PUBLIC_EXECUTION_STATUSES.has(value as NonNullable<TranscriptBlock['executionStatus']>)) {
    return undefined;
  }
  return value as NonNullable<TranscriptBlock['executionStatus']>;
}

function publicDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), 24 * 60 * 60 * 1000);
}

function publicToolPresentation(block: TranscriptBlock): unknown {
  const normalized = normalizeToolPresentation(block.presentation);
  if (normalized) {
    // detail/panel/panelBase 可能承载文件正文或业务面板快照；匿名页只保留过程归属
    // 所需的纯摘要、状态、连接器动作和受约束回执。
    return {
      title: clampPublicText(normalized.title, 160) ?? '工具调用',
      ...(normalized.status ? { status: normalized.status } : {}),
      ...(normalized.receipt ? { receipt: redactStructuredValue(normalized.receipt) } : {}),
      ...(normalized.connector ? { connector: redactStructuredValue(normalized.connector) } : {}),
    };
  }

  // 没有业务摘要的旧工具记录仍需在分享页留下可见的安全活动行；只用工具标题，
  // 不把 tool input/raw 作为 fallback。
  const title = clampPublicText(block.title, 160)
    ?? `工具调用: ${clampPublicText(block.toolName, 96) ?? 'unknown'}`;
  return { title };
}

function publicToolMetadata(block: TranscriptBlock): unknown {
  // 通用执行 metadata 可能含 Edit.diff 等审计载荷，不能绕过 selected file allowlist
  // 进入匿名 DTO。公开页唯一需要的 metadata 是正式 Artifact 交付卡的有界标识。
  if (block.toolName !== 'Artifact') return undefined;
  const normalized = normalizeToolResultMetadata(block.toolMetadata);
  if (normalized?.artifactAction !== 'deliver') return undefined;
  const artifactId = clampPublicText(normalized.artifactId, 120);
  const fileName = clampPublicText(normalized.fileName, 512);
  const artifactKind = normalized.artifactKind;
  if (!artifactId || !fileName
    || !(artifactKind === 'file' || artifactKind === 'screenshot' || artifactKind === 'patch'
      || artifactKind === 'log' || artifactKind === 'blob')) return undefined;
  const sizeBytes = typeof normalized.sizeBytes === 'number'
    && Number.isFinite(normalized.sizeBytes)
    && normalized.sizeBytes >= 0
    ? normalized.sizeBytes
    : undefined;
  const mimeType = clampPublicText(normalized.mimeType, 120);
  return {
    artifactAction: 'deliver',
    artifactId,
    artifactKind,
    fileName,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function publicToolResultContent(block: TranscriptBlock): string {
  // 这些固定前缀只用于让 shared mapper 恢复同一套历史 UI；不携带原始审批方案。
  if (block.isError) return 'Tool interaction failed.';
  if (block.toolName === 'EnterPlanMode') {
    return block.content.trim().startsWith('Entered plan mode')
      ? 'Entered plan mode.'
      : 'User denied entering plan mode.';
  }
  if (block.toolName === 'ExitPlanMode') {
    return block.content.trim().startsWith('User has approved')
      ? 'User has approved your plan.'
      : 'User denied the plan.';
  }
  return '';
}

function publicToolBlock(
  block: TranscriptBlock,
  publicToolId: string | undefined,
  publicRunId: string | undefined,
  toolResult: TranscriptBlock | undefined,
): TranscriptBlock {
  const toolName = clampPublicText(block.toolName, 128) ?? 'unknown';
  const executionStatus = toolResult
    ? toolResult.isError ? 'failed' : 'completed'
    : publicExecutionStatus(block.executionStatus);
  const durationMs = publicDurationMs(block.durationMs);
  const presentation = publicToolPresentation(block);
  const toolMetadata = publicToolMetadata(block);
  const todoWriteContent = publicTodoWriteContent(block);
  return {
    id: block.id,
    ...(block.tsMs !== undefined ? { tsMs: block.tsMs } : {}),
    kind: 'tool_use',
    title: clampPublicText(block.title, 160) ?? `工具调用: ${toolName}`,
    defaultOpen: false,
    // 普通工具仍只显示安全摘要；TodoWrite 例外保留已归一化、脱敏的业务呈现快照，
    // 并使用不透明 runId 维持跨用户消息的同 Run 归属，不暴露原始 payload/标识。
    content: todoWriteContent ?? '',
    publicActivityOnly: true,
    ...(todoWriteContent && publicRunId ? { runId: publicRunId } : {}),
    ...(block.isError || toolResult?.isError ? { isError: true } : {}),
    ...(toolName ? { toolName } : {}),
    ...(publicToolId ? { toolId: publicToolId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(executionStatus ? { executionStatus } : {}),
    ...(presentation ? { presentation } : {}),
    ...(toolMetadata ? { toolMetadata } : {}),
  };
}

function publicToolResultBlock(block: TranscriptBlock, publicToolId: string): TranscriptBlock {
  const toolName = clampPublicText(block.toolName, 128) ?? 'unknown';
  return {
    id: block.id,
    ...(block.tsMs !== undefined ? { tsMs: block.tsMs } : {}),
    kind: 'tool_result',
    title: '工具结果',
    defaultOpen: false,
    content: publicToolResultContent(block),
    publicActivityOnly: true,
    ...(block.isError ? { isError: true } : {}),
    ...(toolName ? { toolName } : {}),
    toolId: publicToolId,
  };
}

function publicBlock(
  block: TranscriptBlock,
  selectedPaths: ReadonlySet<string>,
  options: { publicToolId?: string; publicRunId?: string; toolResult?: TranscriptBlock } = {},
): TranscriptBlock | null {
  if (block.kind === 'tool_use') {
    return publicToolBlock(block, options.publicToolId, options.publicRunId, options.toolResult);
  }
  if (block.kind === 'tool_result') {
    return options.publicToolId ? publicToolResultBlock(block, options.publicToolId) : null;
  }
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
 * 旧分享与新建分享统一走安全投影：保留用户/助手正文，以及不含原始 payload 的
 * 工具活动摘要；TodoWrite 额外保留归一化、脱敏后的 business 快照（含 reset）与不透明 runId。
 * thinking、其他原始 tool input/result、raw、原始 runId 与原始账号标识全部移除；
 * 附件只留下快照显式 allowlist。
 */
export function projectSessionShareSnapshot(
  snapshot: SessionShareSnapshot,
  options: { selectedFilePaths?: readonly string[] } = {},
): SessionShareSnapshot {
  const selectedPaths = new Set(
    options.selectedFilePaths
      ?? (snapshot.allowedFiles ?? []).map((file) => file.relativePath),
  );
  // 工具结果只用于在 shared mapper 中恢复「已完成/失败」状态；对外改成快照内的
  // 不透明关联 ID，并把结果正文替换为固定占位，不泄露原始 tool input/result。
  const publicToolIds = new Map<string, string>();
  let toolSequence = 0;
  for (const block of snapshot.blocks) {
    if (block.kind !== 'tool_use' || !block.toolId || publicToolIds.has(block.toolId)) continue;
    toolSequence += 1;
    publicToolIds.set(block.toolId, `shared-tool-${toolSequence}`);
  }
  const publicRunIds = new Map<string, string>();
  let runSequence = 0;
  for (const block of snapshot.blocks) {
    if (block.kind !== 'tool_use' || block.toolName !== 'TodoWrite' || !block.runId
      || publicRunIds.has(block.runId) || !publicTodoWriteContent(block)) continue;
    runSequence += 1;
    publicRunIds.set(block.runId, `shared-run-${runSequence}`);
  }

  const toolResults = new Map<string, TranscriptBlock>();
  for (const block of snapshot.blocks) {
    if (block.kind === 'tool_result' && block.toolId && !toolResults.has(block.toolId)) {
      toolResults.set(block.toolId, block);
    }
  }

  const blocks = snapshot.blocks
    .map((block) => publicBlock(block, selectedPaths, {
      ...(block.toolId && publicToolIds.has(block.toolId)
        ? { publicToolId: publicToolIds.get(block.toolId) }
        : {}),
      ...(block.runId && publicRunIds.has(block.runId)
        ? { publicRunId: publicRunIds.get(block.runId) }
        : {}),
      ...(block.kind === 'tool_use' && block.toolId && toolResults.has(block.toolId)
        ? { toolResult: toolResults.get(block.toolId) }
        : {}),
    }))
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
