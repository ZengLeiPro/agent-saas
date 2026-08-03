/**
 * 连接器命令解析 + 连接器 stdout 的硬事实提取。
 *
 * ## 为什么原来的「只看 tokens[0]」不够
 *
 * 2026-08-03 生产摸底（近 7 天 11,487 次 Shell 调用）：
 *   - **91.9% 是复合命令**（含 `&&` / `;` / `|`）
 *   - **65% 的首词是 `cd`**
 * 所以只看第一个 token 的识别器只能认出 1.83% 的 Shell 调用；按段扫描后
 * 上限是 2.7%。这不是算法问题，是原材料形态问题——但那 0.9 个百分点恰好
 * 全部落在「AI 真的在动客户外部系统」的那些调用上，是业务事实的主力来源。
 *
 * ## 两条硬规则（与 toolPresentationBuilder 同源）
 *
 * 1. **宁可没有，不可编造。** 解析不确定就返回 null；stdout 里没有可解析的
 *    JSON 就不产出字段。摘要里的字段会被渲染成对齐大字卡，排版的精确感会
 *    放大读者对数字的信任——错报的代价高于不报。
 * 2. **读不等于写。** `--help`、`list`、`status` 不得产出「AI 动了你家系统」
 *    的观感。生产里 11.6% 的 dws 调用是读 `--help`，把它渲染成「钉钉 · 待办」
 *    是最直接的语义造假。
 */

import {
  matchesUrlWhitelist,
  type ConnectorActionVerb,
  type ConnectorDictionaryEntry,
} from './connectorDictionary.js';

export interface ConnectorCommand {
  system: string;
  /** 业务动作短语，如「创建待办」「查询待办」 */
  action: string;
  /** 是否写操作。回执徽标与「动了外部系统」的措辞只给它。 */
  isWrite: boolean;
  /** 命中的连接器条目，后续 stdout 提取要用它的 urlWhitelist */
  entry: ConnectorDictionaryEntry;
}

/** 段首可以安全剥掉的包装命令 */
const WRAPPER_PREFIXES = new Set(['npx', 'pnpm', 'pnpx', 'bunx', 'yarn', 'sudo', 'nohup', 'time', 'command', 'exec', 'env']);

/** 首词是这些时整段不可能是连接器调用，直接跳过（`cd` 占生产首词的 65%） */
const NON_COMMAND_HEADS = new Set(['cd', 'set', 'export', 'unset', 'source', '.', 'alias', 'shift', 'local', 'readonly']);

const VAR_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 按 shell 控制符切段，尊重引号。
 *
 * 不做完整 shell 语法解析：这里的目标不是执行，而是「在一串命令里找出可能的
 * 连接器调用」。切错一段的代价是少认一个动作（可接受），认错一段的代价是
 * 造一条假业务事实（不可接受）——所以后续每一步都只做确定性判断。
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && i + 1 < command.length) {
      current += char + command[i + 1];
      i += 1;
      continue;
    }
    if (char === ';' || char === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    if (char === '&' && command[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (char === '|') {
      // `||` 与 `|` 同等对待：两边都可能是独立命令
      if (command[i + 1] === '|') i += 1;
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** 按空白切 token，尊重引号；引号本身会被剥掉（token 语义是「值」） */
export function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  const push = (): void => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;
    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === '\\' && i + 1 < segment.length) {
      current += segment[i + 1];
      started = true;
      i += 1;
      continue;
    }
    current += char;
    started = true;
  }
  push();
  return tokens;
}

function basename(value: string): string {
  const parts = value.split('/').filter(Boolean);
  return parts[parts.length - 1] || value;
}

interface SegmentMatch {
  entry: ConnectorDictionaryEntry;
  /** binary 之后、第一个 flag 之前的位置参数 */
  sub: string[];
  tokens: string[];
}

function matchSegment(
  segment: string,
  dictionary: readonly ConnectorDictionaryEntry[],
): SegmentMatch | null {
  const tokens = tokenizeSegment(segment);
  let index = 0;
  // 剥前缀：变量赋值（`WT=projects/x dws ...`）与包装命令（`npx` / `sudo` / `env`）
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (VAR_ASSIGNMENT.test(token) || WRAPPER_PREFIXES.has(token)) {
      index += 1;
      continue;
    }
    break;
  }
  const head = tokens[index];
  if (!head || NON_COMMAND_HEADS.has(head)) return null;
  const binary = basename(head);
  const entry = dictionary.find((item) => item.enabled && basename(item.binary) === binary);
  if (!entry) return null;

  const rest = tokens.slice(index + 1);
  // 排除规则按整 token 匹配：`--help-me` 不该被 `-h` 命中
  const excluded = new Set(entry.excludePatterns.map((pattern) => pattern.trim()).filter(Boolean));
  if (rest.some((token) => excluded.has(token))) return null;

  // 位置参数只取到第一个 flag 为止：`dws todo create --title 复核合同` 的
  // 「复核合同」是 flag 的值，不是子命令，混进来会被当成动词
  const sub: string[] = [];
  for (const token of rest) {
    if (token.startsWith('-')) break;
    sub.push(token);
  }
  return { entry, sub, tokens: rest };
}

function resolveAction(entry: ConnectorDictionaryEntry, sub: string[]): { action: string; isWrite: boolean } {
  if (sub.length === 0) return { action: '命令行调用', isWrite: false };
  const moduleToken = sub[0]!;
  const moduleName = entry.modules[moduleToken] ?? moduleToken;

  let verbToken: string | undefined;
  let verb: ConnectorActionVerb | undefined;
  for (const token of sub.slice(1)) {
    const candidate = entry.actionVerbs[token];
    if (candidate) {
      verbToken = token;
      verb = candidate;
      break;
    }
  }
  if (verb && verbToken) {
    return { action: `${verb.name}${moduleName}`, isWrite: verb.write };
  }
  // 动词未登记：只写「模块 · 原词」，不猜它是读还是写
  const fallbackVerb = sub.length > 1 ? sub[sub.length - 1] : undefined;
  return {
    action: fallbackVerb ? `${moduleName} · ${fallbackVerb}` : moduleName,
    isWrite: false,
  };
}

/**
 * 从命令行里认出连接器动作；不是连接器命令时返回 null（绝不硬猜）。
 *
 * 多段命中时优先取**写操作**：`dws auth status --format json ; dws todo create ...`
 * 里客户关心的是那次创建，不是前面的探活。没有写操作时取第一个命中的段。
 */
export function parseConnectorCommand(
  command: string,
  dictionary: readonly ConnectorDictionaryEntry[],
): ConnectorCommand | null {
  if (!command.trim()) return null;
  let firstMatch: ConnectorCommand | null = null;
  for (const segment of splitCommandSegments(command)) {
    const matched = matchSegment(segment, dictionary);
    if (!matched) continue;
    const { action, isWrite } = resolveAction(matched.entry, matched.sub);
    const candidate: ConnectorCommand = {
      system: matched.entry.systemName,
      action,
      isWrite,
      entry: matched.entry,
    };
    if (isWrite) return candidate;
    if (!firstMatch) firstMatch = candidate;
  }
  return firstMatch;
}

// ---------------------------------------------------------------------------
// stdout 硬事实提取
// ---------------------------------------------------------------------------

/** 整段 JSON 只占 3.7%，贪婪片段扫描能到 9.2%——这是这条路上性价比最高的一步 */
const MAX_SCAN_CHARS = 200_000;
const MAX_FRAGMENTS = 24;
const MAX_FIELD_VALUE_CHARS = 120;
const MAX_FIELDS = 6;

/** 惯用键白名单。不在表里的键一律不进摘要——摘要不是 JSON 查看器。 */
const FIELD_LABELS: Record<string, string> = {
  id: 'ID',
  url: '链接',
  taskId: '任务 ID',
  taskUuid: '任务 UUID',
  recordId: '记录 ID',
  title: '标题',
  subject: '主题',
  status: '状态',
  success: '结果',
  errorMsg: '错误信息',
  errorCode: '错误码',
  dingOpenErrcode: '钉钉错误码',
};

/** `*_id` / `*Id` 这类结尾也算惯用键；键名本身即标签 */
function isIdLikeKey(key: string): boolean {
  return /_id$/.test(key) || (/[a-z0-9]Id$/.test(key) && key.length > 2);
}

function isWhitelistedKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELD_LABELS, key) || isIdLikeKey(key);
}

/**
 * 贪婪扫描：在自由文本里逐字符找可平衡解析的 `{` / `[` 片段。
 *
 * 生产实况要求这么做——agent 常写 `printf '=== auth ===' ; dws auth status
 * --format json ; printf ...`，整段 stdout 不是合法 JSON，但中间那段是。
 */
export function scanJsonFragments(text: string): unknown[] {
  const source = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const fragments: unknown[] = [];
  let i = 0;
  while (i < source.length && fragments.length < MAX_FRAGMENTS) {
    const char = source[i]!;
    if (char !== '{' && char !== '[') {
      i += 1;
      continue;
    }
    const end = findBalancedEnd(source, i);
    if (end === -1) {
      i += 1;
      continue;
    }
    try {
      fragments.push(JSON.parse(source.slice(i, end + 1)) as unknown);
      i = end + 1;
      continue;
    } catch {
      // 不是合法 JSON（Python repr 的单引号、被截断的片段…）——不猜，往前挪一格
      i += 1;
    }
  }
  return fragments;
}

function findBalancedEnd(text: string, start: number): number {
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let quote = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') { quote = true; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface ConnectorFacts {
  /** 白名单键的抽取结果，按发现顺序 */
  fields: Array<{ k: string; v: string }>;
  /** 外部系统对象标识（优先 taskUuid > taskId > recordId > id > 其它 *_id） */
  objectId?: string;
  /** 命中业务域名白名单的链接 */
  url?: string;
  /** 回执显式报失败（success:false / 非零 errorCode）——此时不得盖回执章 */
  failed: boolean;
}

const ID_PRIORITY = ['taskUuid', 'taskId', 'recordId', 'id'];

function formatValue(key: string, value: unknown): string | undefined {
  if (typeof value === 'boolean') {
    if (key === 'success') return value ? '成功' : '失败';
    return value ? '是' : '否';
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_FIELD_VALUE_CHARS ? `${trimmed.slice(0, MAX_FIELD_VALUE_CHARS)}…` : trimmed;
}

function collectFromObject(
  node: unknown,
  depth: number,
  sink: (key: string, value: unknown) => void,
): void {
  if (depth > 4 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 8)) collectFromObject(item, depth + 1, sink);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value && typeof value === 'object') {
      collectFromObject(value, depth + 1, sink);
      continue;
    }
    if (isWhitelistedKey(key)) sink(key, value);
  }
}

/** 只认业务域名白名单。裸 URL 正则在生产样本里 34% 是噪声域名，一律不要。 */
export function extractWhitelistedUrl(text: string, whitelist: readonly string[]): string | undefined {
  if (!whitelist.length) return undefined;
  const matches = text.match(/https?:\/\/[^\s"'<>）)，,；;]+/g);
  if (!matches) return undefined;
  for (const raw of matches) {
    const candidate = raw.replace(/[.。、]+$/, '');
    let host: string;
    try {
      host = new URL(candidate).hostname;
    } catch {
      continue;
    }
    if (matchesUrlWhitelist(host, whitelist)) return candidate;
  }
  return undefined;
}

/**
 * 从连接器命令的 stdout 里提取硬事实。
 *
 * 只在连接器识别成功后调用——对任意 Shell 的 stdout 做同样的扫描会把 git sha、
 * 容器 id、毫秒时间戳全当成「业务对象 ID」（生产样本里 ID 样 token 命中率
 * 22.3%，精度极差）。限定在连接器命令上，命中的才是真回执。
 */
export function extractConnectorFacts(
  stdout: string,
  entry: ConnectorDictionaryEntry,
): ConnectorFacts | null {
  if (!stdout.trim()) return null;
  const fields: Array<{ k: string; v: string }> = [];
  const seen = new Set<string>();
  const raw = new Map<string, unknown>();
  let failed = false;

  for (const fragment of scanJsonFragments(stdout)) {
    collectFromObject(fragment, 0, (key, value) => {
      if (!raw.has(key)) raw.set(key, value);
      if (key === 'success' && value === false) failed = true;
      if ((key === 'errorCode' || key === 'dingOpenErrcode') && typeof value === 'number' && value !== 0) failed = true;
      if (seen.has(key) || fields.length >= MAX_FIELDS) return;
      const formatted = formatValue(key, value);
      if (formatted === undefined) return;
      seen.add(key);
      fields.push({ k: FIELD_LABELS[key] ?? key, v: formatted });
    });
  }

  let objectId: string | undefined;
  for (const key of ID_PRIORITY) {
    const value = raw.get(key);
    if (typeof value === 'string' && value.trim()) { objectId = value.trim(); break; }
    if (typeof value === 'number' && Number.isFinite(value)) { objectId = String(value); break; }
  }
  if (!objectId) {
    for (const [key, value] of raw) {
      if (!isIdLikeKey(key)) continue;
      if (typeof value === 'string' && value.trim()) { objectId = value.trim(); break; }
      if (typeof value === 'number' && Number.isFinite(value)) { objectId = String(value); break; }
    }
  }
  if (objectId && objectId.length > MAX_FIELD_VALUE_CHARS) objectId = undefined;

  // URL 走全文扫描而不只看 JSON 的 url 键：白名单已经保证了不会误收噪声域名，
  // 而链接常常出现在自由文本行里（`已创建，查看：https://…`）
  const url = extractWhitelistedUrl(stdout, entry.urlWhitelist);

  if (!fields.length && !objectId && !url) return null;
  return { fields, ...(objectId ? { objectId } : {}), ...(url ? { url } : {}), failed };
}

/**
 * 从 `formatShellOutput` 的信封里取出 stdout 段。
 *
 * 信封格式（`toolOutput.ts`）是平台自己产的、本地与远端 hand 同形态，所以这是
 * 在摘要产出时机能拿到的、最接近一手 stdout 的东西。**不退化为扫描整段正文**：
 * header 与 stderr 里的内容不该被当成回执。
 */
export function extractStdoutSection(output: string): string | undefined {
  const marker = output.indexOf('\n[stdout]\n');
  if (marker === -1) return undefined;
  const start = marker + '\n[stdout]\n'.length;
  const stderrAt = output.indexOf('\n[stderr]\n', start);
  const section = stderrAt === -1 ? output.slice(start) : output.slice(start, stderrAt);
  return section.trim() ? section : undefined;
}
