/**
 * 路径规范化：§5.2 壳 / 子端共用的应用路径规范化，§3.3 `pfx` 匹配，§4.5 工具名。
 */
import {
  APP_PATH_MAX_LENGTH,
  RESERVED_QUERY_PARAMS,
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_PREFIX,
} from './types/constants.js';

export type PathErrorCode =
  | 'not_absolute'
  | 'scheme'
  | 'double_slash'
  | 'dot_segment'
  | 'percent_encoded_separator'
  | 'backslash'
  | 'whitespace'
  | 'too_long'
  | 'not_a_prefix'
  | 'tool_name_too_long'
  | 'empty';

export class PathError extends Error {
  readonly code: PathErrorCode;

  constructor(code: PathErrorCode, message: string) {
    super(message);
    this.name = 'PathError';
    this.code = code;
  }
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;
const PERCENT_SEPARATOR = /%2[fe]/iu;

/**
 * §5.2 应用路径规范化（壳与子端共用）。
 *
 * 校验：以单个 `/` 开头；禁 scheme、`//`、`..`、`%2f`/`%2e`（不分大小写）、反斜杠、空白；
 * 长度 ≤ 512（与附录 C `$defs.path` 的 maxLength 一致）。
 * 规范化：去尾斜杠（根 `/` 保留）、query 键排序、剔除保留参数 `ky`/`ky_iid`/`ky_nonce`。
 *
 * 注：附录 C 的正则对 query 里的 `..` 会误杀，规范已声明可接受，这里与之保持一致。
 */
export function normalizeAppPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new PathError('empty', 'path 不能为空');
  }
  if (path.length > APP_PATH_MAX_LENGTH) {
    throw new PathError('too_long', `path 超过 ${APP_PATH_MAX_LENGTH} 字符`);
  }
  if (SCHEME.test(path)) throw new PathError('scheme', 'path 不得带 scheme');
  if (path.includes('\\')) throw new PathError('backslash', 'path 不得含反斜杠');
  if (/\s/u.test(path)) throw new PathError('whitespace', 'path 不得含空白字符');
  if (!path.startsWith('/')) throw new PathError('not_absolute', 'path 必须以 / 开头');
  if (path.includes('//')) throw new PathError('double_slash', 'path 不得含 //');
  if (path.includes('..')) throw new PathError('dot_segment', 'path 不得含 ..');
  if (PERCENT_SEPARATOR.test(path)) {
    throw new PathError('percent_encoded_separator', 'path 不得含 %2f / %2e');
  }

  const hashAt = path.indexOf('#');
  const hash = hashAt === -1 ? '' : path.slice(hashAt);
  const withoutHash = hashAt === -1 ? path : path.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  const rawQuery = queryAt === -1 ? '' : withoutHash.slice(queryAt + 1);
  let pathname = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);

  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname.length === 0) pathname = '/';

  const query = normalizeQuery(rawQuery);
  return `${pathname}${query ? `?${query}` : ''}${hash}`;
}

/** 剔除保留参数并按键名（UTF-16 code unit）稳定排序；不做百分号解码 / 重编码。 */
function normalizeQuery(rawQuery: string): string {
  if (!rawQuery) return '';
  const entries: Array<{ key: string; raw: string; order: number }> = [];
  let order = 0;
  for (const part of rawQuery.split('&')) {
    if (part === '') continue;
    const equalsAt = part.indexOf('=');
    const key = equalsAt === -1 ? part : part.slice(0, equalsAt);
    if ((RESERVED_QUERY_PARAMS as readonly string[]).includes(key)) continue;
    entries.push({ key, raw: part, order });
    order += 1;
  }
  entries.sort((left, right) => {
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    return left.order - right.order;
  });
  return entries.map((entry) => entry.raw).join('&');
}

/**
 * §3.3 `pfx` 匹配用的 pathname 规范化：
 * 拒原文含 `%2f`/`%2e` → 一次百分号解码 → 拒解码后仍含 `%2f`/`%2e`（不分大小写）
 * → 拒反斜杠 → 合并 `//` → 拒 `..` 段。
 *
 * 与 normalizeAppPath 的区别：这里**合并** `//` 而不是拒绝（施工总则 §3.4）。
 * §9.3-3 的「`//` → 403」由合并后仍存在的 `..` 段兜住，例如 `/api/app//../admin/x`。
 *
 * 施工总则 §3.4 只要求「拒解码后仍含 %2f/%2e」，那只拦得住 `%252f` 这类双重编码。
 * 这里额外先查一次原文，让 §9.3-3 的「`%2f` → 403」成立：授权判定与路由框架对
 * `%2f` 的解释一旦不一致就会出现授权面与执行面的错位，一律 fail-closed。
 */
export function normalizePathname(pathname: string): string {
  if (typeof pathname !== 'string' || pathname.length === 0) {
    throw new PathError('empty', 'pathname 不能为空');
  }
  if (PERCENT_SEPARATOR.test(pathname)) {
    throw new PathError('percent_encoded_separator', 'pathname 含 %2f / %2e');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new PathError('percent_encoded_separator', 'pathname 百分号编码非法');
  }
  if (PERCENT_SEPARATOR.test(decoded)) {
    throw new PathError('percent_encoded_separator', 'pathname 解码后仍含 %2f / %2e');
  }
  if (decoded.includes('\\')) throw new PathError('backslash', 'pathname 不得含反斜杠');
  if (!decoded.startsWith('/')) throw new PathError('not_absolute', 'pathname 必须以 / 开头');
  const merged = decoded.replace(/\/{2,}/gu, '/');
  if (merged.split('/').includes('..')) throw new PathError('dot_segment', 'pathname 含 .. 段');
  return merged;
}

/**
 * 完整 segment 前缀匹配：`/api/app/` 匹配 `/api/app/x`，不匹配 `/api/apps`。
 * pathname 非法（`%2f`、`..`、反斜杠等）时返回 false，由调用方回 403。
 */
export function matchPathPrefix(pathname: string, prefixes: readonly string[]): boolean {
  let normalized: string;
  try {
    normalized = normalizePathname(pathname);
  } catch {
    return false;
  }
  return prefixes.some((prefix) => isSegmentPrefix(normalized, prefix));
}

function isSegmentPrefix(pathname: string, prefix: string): boolean {
  if (!prefix.startsWith('/') || !prefix.endsWith('/') || prefix === '/') return false;
  return pathname.startsWith(prefix);
}

/** manifest `pathPrefixes` 里的每一项都必须是「以 / 开头结尾且不是 /」的前缀。 */
export function assertPathPrefix(prefix: string): void {
  if (!prefix.startsWith('/') || !prefix.endsWith('/') || prefix === '/') {
    throw new PathError('not_a_prefix', `非法路径前缀 ${prefix}`);
  }
}

/** §4.5 工具名规范化：`-` 与 `.` 变 `_`。 */
export function normalizeToolSegment(value: string): string {
  return value.replaceAll('-', '_').replaceAll('.', '_');
}

/** §4.5 工具名 `app__<systemId>__<capabilityId>`，规范化后 ≤ 64。 */
export function toolName(systemId: string, capabilityId: string): string {
  const name = `${TOOL_NAME_PREFIX}${normalizeToolSegment(systemId)}__${normalizeToolSegment(capabilityId)}`;
  if (name.length > TOOL_NAME_MAX_LENGTH) {
    throw new PathError(
      'tool_name_too_long',
      `工具名 ${name} 长度 ${name.length} 超过 ${TOOL_NAME_MAX_LENGTH}`,
    );
  }
  return name;
}
