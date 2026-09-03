export const ARTIFACT_VIEW_POLICY_VERSION = 2 as const;
export const ARTIFACT_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export type ArtifactViewKind = 'image' | 'pdf' | 'markdown' | 'html' | 'text' | 'source' | 'audio' | 'video' | 'download-only';

export interface ArtifactViewModel {
  artifactId: string;
  name: string;
  safeMime: string;
  size: number;
  digest: string;
  viewKind: ArtifactViewKind;
  activeContent: boolean;
  requiresWarning: boolean;
  expiresAt: string;
  correlationId: string;
}

export interface ArtifactReadGrant {
  descriptor: ArtifactViewModel;
  readUrl: string;
}

export interface ArtifactViewPosition {
  scrollTop?: number;
  page?: number;
  mediaTime?: number;
}

export type ArtifactViewerErrorCode =
  | 'authentication_required'
  | 'access_denied'
  | 'artifact_not_found'
  | 'artifact_deleted'
  | 'artifact_quarantined'
  | 'artifact_unavailable';

export interface ArtifactViewerError {
  code: ArtifactViewerErrorCode;
  title: string;
  message: string;
  action: 'sign-in' | 'close';
  actionLabel: string;
}

export interface ArtifactViewerState {
  artifactId: string | null;
  ownerKey: string | null;
  grant: ArtifactReadGrant | null;
  position: ArtifactViewPosition;
  refreshCount: 0 | 1;
  status: 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';
  error: ArtifactViewerError | null;
}

export type ArtifactViewerEvent =
  | { type: 'open'; artifactId: string; ownerKey: string }
  | { type: 'loaded'; grant: ArtifactReadGrant }
  | { type: 'position'; position: ArtifactViewPosition }
  | { type: 'expired' }
  | { type: 'failed'; status: number; reason?: string }
  | { type: 'owner-switched'; ownerKey: string }
  | { type: 'close' };

const SAFE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SAFE_AUDIO_MIMES = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg']);
const SAFE_VIDEO_MIMES = new Set(['video/mp4', 'video/webm']);
const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml']);
const MARKDOWN_MIMES = new Set(['text/markdown', 'text/x-markdown']);
const ACTIVE_SOURCE_MIMES = new Set([
  'image/svg+xml', 'application/xml', 'text/xml',
  'application/javascript', 'text/javascript', 'application/x-javascript',
]);
const STRUCTURED_TEXT_MIMES = new Set([
  'application/json', 'application/ld+json', 'application/yaml', 'application/x-yaml',
  'application/x-ndjson', 'application/toml', 'application/sql', 'application/graphql',
]);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);
const ACTIVE_SOURCE_EXTENSIONS = new Set([
  'bat', 'cmd', 'ps1', 'sh', 'bash', 'zsh', 'fish', 'command', 'vbs', 'js', 'mjs', 'cjs',
  'py', 'pyw', 'rb', 'php', 'pl', 'lua', 'scpt', 'applescript', 'reg', 'desktop', 'url', 'webloc',
  'svg', 'xml',
]);
const NATIVE_EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'dll', 'com', 'app', 'apk', 'ipa', 'jar', 'msi', 'scr', 'dmg', 'pkg', 'deb', 'rpm', 'run',
]);
const MACRO_EXTENSIONS = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'sldm']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'dot', 'xls', 'xlsx', 'xlt', 'ppt', 'pptx', 'pot']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2', 'txz']);
const RISKY_EXTENSIONS = new Set([
  ...ACTIVE_SOURCE_EXTENSIONS,
  ...NATIVE_EXECUTABLE_EXTENSIONS,
  ...HTML_EXTENSIONS,
  ...MACRO_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
]);
const BINARY_EXTENSION_MIMES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm',
};

export interface ArtifactPolicyInput {
  artifactId: string;
  name?: string;
  declaredMime?: string;
  size?: number;
  digest?: string;
  bytes?: Uint8Array;
  expiresAt: string;
  correlationId: string;
}

export interface ArtifactPolicyResult extends ArtifactViewModel {
  disposition: 'inline' | 'attachment';
  reason?: string;
}

export function evaluateArtifactPolicy(input: ArtifactPolicyInput): ArtifactPolicyResult {
  const name = sanitizeArtifactName(input.name, input.artifactId);
  const size = Number.isSafeInteger(input.size) && (input.size ?? -1) >= 0 ? input.size! : 0;
  const digest = typeof input.digest === 'string' && /^[a-f0-9]{64}$/i.test(input.digest) ? input.digest.toLowerCase() : '';
  const declaredMime = normalizeMime(input.declaredMime);
  const magic = input.bytes ? detectArtifactMagic(input.bytes) : { mime: '', active: false, binaryExecutable: false, script: false, pdfActive: false };
  const extensions = name.toLowerCase().split('.').slice(1);
  const finalExtension = extensions.at(-1) ?? '';
  const doubleExtension = extensions.length > 1 && extensions.slice(0, -1).some(ext => RISKY_EXTENSIONS.has(ext));
  const nativeExecutable = NATIVE_EXECUTABLE_EXTENSIONS.has(finalExtension) || magic.binaryExecutable;
  const macroDocument = MACRO_EXTENSIONS.has(finalExtension);
  const archive = ARCHIVE_EXTENSIONS.has(finalExtension);
  const officeWithoutConverter = OFFICE_EXTENSIONS.has(finalExtension);
  const markdown = MARKDOWN_EXTENSIONS.has(finalExtension) || MARKDOWN_MIMES.has(declaredMime);
  const html = HTML_EXTENSIONS.has(finalExtension) || HTML_MIMES.has(declaredMime);
  const activeSource = ACTIVE_SOURCE_EXTENSIONS.has(finalExtension) || ACTIVE_SOURCE_MIMES.has(declaredMime) || magic.script;
  const textBytes = input.bytes ? isUtf8Text(input.bytes) : false;
  const active = nativeExecutable || macroDocument || magic.pdfActive || html || activeSource;

  let viewKind: ArtifactViewKind = 'download-only';
  let safeMime = 'application/octet-stream';
  let reason = 'unknown-or-malformed';

  const blockedByNameOrBytes = nativeExecutable || macroDocument || archive || doubleExtension || officeWithoutConverter || magic.pdfActive;
  if (!blockedByNameOrBytes && textBytes && textPolicyMatches(declaredMime, magic.mime) && textExtensionMatches(finalExtension)) {
    if (markdown) viewKind = 'markdown';
    else if (html) viewKind = 'html';
    else if (activeSource || isSourceText(finalExtension, declaredMime)) viewKind = 'source';
    else viewKind = 'text';
    safeMime = viewKind === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    reason = '';
  } else if (!blockedByNameOrBytes && magic.mime && binaryPolicyMatches(declaredMime, magic.mime, finalExtension)) {
    if (SAFE_IMAGE_MIMES.has(magic.mime)) {
      viewKind = 'image'; safeMime = magic.mime; reason = '';
    } else if (magic.mime === 'application/pdf') {
      viewKind = 'pdf'; safeMime = magic.mime; reason = '';
    } else if (SAFE_AUDIO_MIMES.has(magic.mime)) {
      viewKind = 'audio'; safeMime = magic.mime; reason = '';
    } else if (SAFE_VIDEO_MIMES.has(magic.mime)) {
      viewKind = 'video'; safeMime = magic.mime; reason = '';
    }
  }

  const requiresWarning = active || (viewKind === 'download-only' && !officeWithoutConverter);
  return {
    artifactId: input.artifactId,
    name,
    safeMime,
    size,
    digest,
    viewKind,
    activeContent: active,
    requiresWarning,
    expiresAt: input.expiresAt,
    correlationId: input.correlationId,
    disposition: viewKind === 'download-only' ? 'attachment' : 'inline',
    ...(reason ? { reason: active ? 'active-content' : officeWithoutConverter ? 'conversion-required' : reason } : {}),
  };
}

export function parseArtifactReadGrant(value: unknown): ArtifactReadGrant | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { descriptor?: unknown; readUrl?: unknown };
  if (typeof raw.readUrl !== 'string' || !raw.readUrl || !raw.descriptor || typeof raw.descriptor !== 'object') return null;
  const descriptor = raw.descriptor as Record<string, unknown>;
  const kinds: ArtifactViewKind[] = ['image', 'pdf', 'markdown', 'html', 'text', 'source', 'audio', 'video', 'download-only'];
  if (
    typeof descriptor.artifactId !== 'string' || !descriptor.artifactId
    || typeof descriptor.name !== 'string' || !descriptor.name
    || typeof descriptor.safeMime !== 'string'
    || typeof descriptor.size !== 'number' || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0
    || typeof descriptor.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(descriptor.digest)
    || typeof descriptor.viewKind !== 'string' || !kinds.includes(descriptor.viewKind as ArtifactViewKind)
    || typeof descriptor.activeContent !== 'boolean'
    || typeof descriptor.requiresWarning !== 'boolean'
    || typeof descriptor.expiresAt !== 'string' || !Number.isFinite(Date.parse(descriptor.expiresAt))
    || typeof descriptor.correlationId !== 'string' || !descriptor.correlationId
  ) return null;
  return { descriptor: descriptor as unknown as ArtifactViewModel, readUrl: raw.readUrl };
}

export function createArtifactViewerState(): ArtifactViewerState {
  return { artifactId: null, ownerKey: null, grant: null, position: {}, refreshCount: 0, status: 'idle', error: null };
}

export function reduceArtifactViewer(state: ArtifactViewerState, event: ArtifactViewerEvent): ArtifactViewerState {
  switch (event.type) {
    case 'open':
      return { artifactId: event.artifactId, ownerKey: event.ownerKey, grant: null, position: {}, refreshCount: 0, status: 'loading', error: null };
    case 'loaded':
      if (event.grant.descriptor.artifactId !== state.artifactId) return state;
      return { ...state, grant: event.grant, status: 'ready', error: null };
    case 'position':
      return { ...state, position: { ...state.position, ...event.position } };
    case 'expired':
      return state.refreshCount === 0
        ? { ...state, refreshCount: 1, status: 'refreshing', error: null }
        : { ...state, status: 'error', error: artifactViewerError(401, 'expired') };
    case 'failed':
      return { ...state, status: 'error', error: artifactViewerError(event.status, event.reason) };
    case 'owner-switched':
      return event.ownerKey === state.ownerKey ? state : createArtifactViewerState();
    case 'close':
      return createArtifactViewerState();
  }
}

export function artifactViewerError(status: number, reason?: string): ArtifactViewerError {
  if (reason === 'quarantine' || status === 423) return { code: 'artifact_quarantined', title: '文件已隔离', message: '安全策略已隔离此文件，无法查看或下载。', action: 'close', actionLabel: '关闭' };
  if (status === 401) return { code: 'authentication_required', title: '查看凭证已失效', message: '请重新登录后再试。', action: 'sign-in', actionLabel: '重新登录' };
  if (status === 403) return { code: 'access_denied', title: '无权查看文件', message: '当前账号或组织没有此文件的访问权限。', action: 'close', actionLabel: '关闭' };
  if (status === 404) return { code: 'artifact_not_found', title: '文件不可用', message: '文件不存在，或你已失去访问权限。', action: 'close', actionLabel: '关闭' };
  if (status === 410) return { code: 'artifact_deleted', title: '文件已删除', message: '此文件已被删除，无法恢复查看。', action: 'close', actionLabel: '关闭' };
  return { code: 'artifact_unavailable', title: '暂时无法查看文件', message: '文件加载失败，请稍后重试。', action: 'close', actionLabel: '关闭' };
}

export function isArtifactGrantExpired(grant: ArtifactReadGrant, now = Date.now(), skewMs = 5_000): boolean {
  return Date.parse(grant.descriptor.expiresAt) <= now + skewMs;
}

function normalizeMime(value?: string): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function sanitizeArtifactName(value: string | undefined, artifactId: string): string {
  const leaf = value?.split(/[\\/]/).pop()?.replace(/[\r\n\0]/g, '').trim();
  return leaf?.slice(0, 255) || `${artifactId}.bin`;
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/')
    || MARKDOWN_MIMES.has(mime)
    || HTML_MIMES.has(mime)
    || ACTIVE_SOURCE_MIMES.has(mime)
    || STRUCTURED_TEXT_MIMES.has(mime)
    || mime.endsWith('+json')
    || mime.endsWith('+xml');
}

function textPolicyMatches(declared: string, detected: string): boolean {
  if (!declared || declared === 'application/octet-stream') return true;
  return isTextMime(declared) && isTextMime(detected);
}

function textExtensionMatches(extension: string): boolean {
  return !BINARY_EXTENSION_MIMES[extension]
    && !NATIVE_EXECUTABLE_EXTENSIONS.has(extension)
    && !MACRO_EXTENSIONS.has(extension)
    && !OFFICE_EXTENSIONS.has(extension)
    && !ARCHIVE_EXTENSIONS.has(extension);
}

function binaryPolicyMatches(declared: string, detected: string, extension: string): boolean {
  const expectedByExtension = BINARY_EXTENSION_MIMES[extension];
  if (expectedByExtension && expectedByExtension !== detected) return false;
  return !declared || declared === 'application/octet-stream' || declared === detected;
}

const SOURCE_TEXT_EXTENSIONS = new Set([
  'json', 'jsonl', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'csv', 'tsv', 'sql',
  'ts', 'tsx', 'mts', 'cts', 'jsx', 'css', 'scss', 'less', 'py', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cc', 'rb', 'php', 'swift', 'kt', 'patch', 'diff',
]);

function isSourceText(extension: string, declaredMime: string): boolean {
  return SOURCE_TEXT_EXTENSIONS.has(extension)
    || STRUCTURED_TEXT_MIMES.has(declaredMime)
    || declaredMime.endsWith('+json')
    || declaredMime.endsWith('+xml');
}

function detectArtifactMagic(bytes: Uint8Array): { mime: string; active: boolean; binaryExecutable: boolean; script: boolean; pdfActive: boolean } {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  const ascii = new TextDecoder('latin1').decode(head);
  const trimmed = ascii.replace(/^\uFEFF?\s*/, '').toLowerCase();
  const binaryExecutable = starts(bytes, [0x4d, 0x5a]) || starts(bytes, [0x7f, 0x45, 0x4c, 0x46])
    || starts(bytes, [0xcf, 0xfa, 0xed, 0xfe]) || starts(bytes, [0xfe, 0xed, 0xfa, 0xcf]);
  const script = trimmed.startsWith('#!');
  const active = /^<(?:!doctype\s+html|html|script|svg|\?xml)\b/.test(trimmed)
    || /<svg\b|<script\b|<!entity\b/.test(trimmed);
  if (binaryExecutable) return { mime: '', active, binaryExecutable: true, script: false, pdfActive: false };
  if (active) return { mime: trimmed.includes('<svg') ? 'image/svg+xml' : trimmed.includes('html') || trimmed.startsWith('<script') ? 'text/html' : 'application/xml', active: true, binaryExecutable: false, script, pdfActive: false };
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return { mime: 'image/gif', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { mime: 'image/webp', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (ascii.startsWith('%PDF-')) {
    const body = new TextDecoder('latin1').decode(bytes);
    return { mime: 'application/pdf', active: false, binaryExecutable: false, script: false, pdfActive: /\/(?:JavaScript|JS|Launch|SubmitForm|ImportData)\b/i.test(body) };
  }
  if (ascii.startsWith('ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return { mime: 'audio/wav', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (ascii.startsWith('OggS')) return { mime: 'audio/ogg', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (ascii.slice(4, 8) === 'ftyp') return { mime: 'video/mp4', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', active: false, binaryExecutable: false, script: false, pdfActive: false };
  if (isUtf8Text(bytes)) return { mime: 'text/plain', active: false, binaryExecutable: false, script, pdfActive: false };
  return { mime: '', active: false, binaryExecutable: false, script: false, pdfActive: false };
}

function starts(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
