/**
 * 工具执行摘要（给人看）的服务端产出规则。
 *
 * 背景：前端渲染器与契约已上线，但服务端一度对 presentation 零产出——
 * 与 `[CITE]` 引用溯源卡（shared/src/lib/markers.ts）同一个失败模式：
 * 解析器、组件、测试俱全，无人产出，四个月零使用。本模块是那条通道的产出端。
 *
 * ## 两条硬规则
 *
 * 1. **只写确定为真的信息。** 本模块运行在 `PlatformToolRuntime.invoke` 的
 *    收口点，此处拿到的 `content` 已被各 provider 截断（Shell/Read ≤64KB），
 *    在截断后的文本上数行数、数命中数会**静默错报**。因此规则一律只用
 *    **入参侧**数据；需要精确统计的字段必须由对应 provider 在截断前自产，
 *    并通过 `ToolResult.presentation` 直接带上来（本模块见到已有值即不覆盖）。
 *
 * 2. **宁可没有，不可编造。** 没有规则的工具优雅退化为无 presentation，
 *    渲染与本模块引入前逐像素一致。摘要里的数字会被渲染成对齐键值表，
 *    排版的精确感会放大读者对数字的信任——错报的代价高于不报。
 */

/**
 * 摘要行。**与 shared 的 `DetailLine` 结构等价**。
 *
 * server 不依赖 shared 包（两端是结构性契约而非共享类型：server 直通
 * `TranscriptBlock[]`，前端按 `ApiTranscriptBlock` 解读），故此处本地定义。
 * 权威校验器是前端的 `normalizeToolPresentation`——它对任何脏数据返回 null
 * 并回退原始 payload，所以两边结构漂移不会导致崩溃，只会导致摘要不显示。
 * 修改本类型时必须同步 `shared/src/lib/toolPresentation.ts`。
 */
import {
  extractConnectorFacts,
  extractStdoutSection,
  parseConnectorCommand as parseConnectorCommandWith,
  type ConnectorCommand,
} from './connectorCommand.js';
import {
  BUILTIN_CONNECTOR_DICTIONARY,
  type ConnectorDictionaryEntry,
} from './connectorDictionary.js';

export type PresentationDetailLine =
  | string
  | { k: string; v: string }
  | { tree: '├' | '└'; k: string; v: string }
  | { no: number; text: string }
  | { indent: number; text: string }
  | { section: string }
  | { warn: string }
  | { insight: string; label?: string }
  | { risk: 'high' | 'medium'; text: string; action?: string }
  | { verdict: 'pass' | 'fail' | 'warn' | 'pending'; text: string; note?: string }
  | { quote: string; source?: string }
  | { original: string; translation?: string }
  | { fields: Array<{ k: string; v: string }> };

/** 与 shared 的 `ToolPresentation` 结构等价，见上方说明 */
export interface ToolPresentation {
  title: string;
  detail?: PresentationDetailLine[];
  status?: 'ok' | 'warn' | 'blocked' | 'waiting';
  receipt?: { id: string; system: string; readBack?: boolean };
  /** 外部系统动作标记：渲染层据此把这条抽出活动分组单独成行（见 shared `ToolConnectorAction`） */
  connector?: { system: string; write: boolean };
}

/** 规则覆盖状态。用于覆盖率断言，见 toolPresentationCoverage.test.ts */
export type PresentationSourceState =
  /** 已有规则，且规则只用确定为真的数据 */
  | 'covered'
  /** 有规则但只覆盖入参侧；结果侧统计待对应 provider 在截断前自产 */
  | 'partial'
  /** 尚无规则，退化为无摘要 */
  | 'none';

export interface PresentationSourceEntry {
  tool: string;
  state: PresentationSourceState;
  /** state !== 'covered' 时必填：还缺什么 */
  gap?: string;
  /**
   * 摘要在哪一层产出。缺省 `server-metadata`＝本模块按 provider 的截断前
   * metadata 产出。`mapping` 是例外：该工具的关键数字在服务端写 tool_use 行
   * 时尚未产生（如子 Agent 的耗时/token 要等子 run 结束聚合），只能在
   * shared 的映射层组装——这类工具不受本模块规则表约束。
   */
  producedIn?: 'server-metadata' | 'mapping';
}

function parseInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function basename(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

/** 命令行超长时保留头部，避免摘要行被一条长命令撑爆 */
function briefCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, ' ').trim();
  return singleLine.length > 120 ? `${singleLine.slice(0, 120)}…` : singleLine;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

/**
 * 生效的连接器映射词典。
 *
 * 内置词典（`connectorDictionary.ts`）是**默认种子**；平台管理里配置过就用
 * 配置的那份，保存即热更新（CLI 升级后运营改词典即可，不必发版）。
 * 这里刻意用一个模块级可替换引用而不是每次查 DB：摘要产出在工具执行的
 * 收口点上，多一次 IO 就是给每次工具调用加一次延迟。
 */
let activeConnectorDictionary: readonly ConnectorDictionaryEntry[] = BUILTIN_CONNECTOR_DICTIONARY;

/**
 * 租户级覆盖（2026-08-04 任务 E）。合并规则=**整条覆盖**：同 binary 的租户条目
 * 完整替换平台条目（不做字段级 merge——半平台半租户的杂交条目没人能推理）；
 * 租户新增的 binary 追加。合并视图在 set 时预计算，工具收口点零额外开销。
 */
let tenantConnectorOverrides: ReadonlyMap<string, readonly ConnectorDictionaryEntry[]> = new Map();
let mergedConnectorViewByTenant: ReadonlyMap<string, readonly ConnectorDictionaryEntry[]> = new Map();

function rebuildMergedConnectorViews(): void {
  const merged = new Map<string, readonly ConnectorDictionaryEntry[]>();
  for (const [tenantId, overrides] of tenantConnectorOverrides) {
    if (!overrides.length) continue;
    const byBinary = new Map(activeConnectorDictionary.map((entry) => [entry.binary, entry]));
    for (const entry of overrides) byBinary.set(entry.binary, entry);
    merged.set(tenantId, [...byBinary.values()]);
  }
  mergedConnectorViewByTenant = merged;
}

/** 平台管理保存后调用；传 null 表示回落内置词典 */
export function setConnectorDictionary(dictionary: readonly ConnectorDictionaryEntry[] | null): void {
  activeConnectorDictionary = dictionary?.length ? dictionary : BUILTIN_CONNECTOR_DICTIONARY;
  rebuildMergedConnectorViews();
}

/** 租户覆盖注册（tenantId → 覆盖条目）。整体替换语义；传 null 清空。 */
export function setTenantConnectorDictionaries(
  overrides: Record<string, readonly ConnectorDictionaryEntry[]> | null,
): void {
  tenantConnectorOverrides = new Map(Object.entries(overrides ?? {}));
  rebuildMergedConnectorViews();
}

export function getConnectorDictionary(): readonly ConnectorDictionaryEntry[] {
  return activeConnectorDictionary;
}

/** 解析用词典：有租户覆盖走合并视图，否则平台词典。 */
export function resolveConnectorDictionary(tenantId?: string): readonly ConnectorDictionaryEntry[] {
  if (!tenantId) return activeConnectorDictionary;
  return mergedConnectorViewByTenant.get(tenantId) ?? activeConnectorDictionary;
}

/** MCP server 名 → 客户读得懂的系统名。未登记的直接用原名，不硬凑。 */
const MCP_SYSTEM_NAMES: Record<string, string> = {
  dingtalk: '钉钉',
  dws: '钉钉',
  feishu: '飞书',
  lark: '飞书',
  github: 'GitHub',
  notion: 'Notion',
  slack: 'Slack',
  gmail: 'Gmail',
  'google-drive': 'Google 云端硬盘',
  'google-calendar': 'Google 日历',
};

/**
 * buildToolPresentation 执行期间的解析租户。规则表（RULES/METADATA_RULES）全部
 * 是同步函数，这个模块级变量只在 buildToolPresentation 的同步段内有值——
 * 不跨 await、不逃逸，等价于把 tenantId 穿进每条规则但不用改 30 个规则签名。
 */
let currentParseTenantId: string | undefined;

/** 从命令行里认出连接器动作；不是连接器命令时返回 null（绝不硬猜） */
export function parseConnectorCommand(command: string, tenantId?: string): ConnectorCommand | null {
  return parseConnectorCommandWith(command, resolveConnectorDictionary(tenantId ?? currentParseTenantId));
}

/**
 * MCP 工具摘要。
 *
 * 工具名恒为 `mcp__<server>__<tool>`，只有入参可用（MCP 结果没有统一 metadata
 * 契约），所以这里给的是"调了哪个系统的什么动作、带了哪些关键参数"，
 * 不编造条数、耗时这类它拿不到的统计。
 */
export function buildMcpPresentation(toolName: string, input: Record<string, unknown>): ToolPresentation | null {
  if (!toolName.startsWith('mcp__')) return null;
  const [server, ...rest] = toolName.slice('mcp__'.length).split('__');
  const tool = rest.join('__');
  if (!server || !tool) return null;
  const system = MCP_SYSTEM_NAMES[server] ?? server;
  const detail: PresentationDetailLine[] = [{ k: '动作', v: tool }];
  const keys = Object.keys(input).slice(0, 4);
  keys.forEach((key, index) => {
    const value = input[key];
    if (value === undefined || value === null || typeof value === 'object') return;
    const text = String(value);
    detail.push({
      tree: index === keys.length - 1 ? '└' : '├',
      k: key,
      v: text.length > 80 ? `${text.slice(0, 80)}…` : text,
    });
  });
  return { title: `${system} · ${tool}`, detail, status: 'ok' };
}

type Rule = (input: Record<string, unknown>) => ToolPresentation | null;

/**
 * 基于执行元数据的规则。
 *
 * 与入参侧规则的关键区别：metadata 来自**截断之前**的真实执行结果
 * （Shell 的 exitCode/字节数/耗时、Write 的写入字节数），所以可以给出
 * 精确统计而不会错报。有 metadata 规则时优先用它。
 */
type MetadataRule = (
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  /** 工具返回正文（成功时是 content，失败时是 error）。只用于连接器 stdout 提取。 */
  resultText?: string,
) => ToolPresentation | null;

const METADATA_RULES: Record<string, MetadataRule> = {
  Shell: (input, metadata, resultText) => {
    const command = str(input.command);
    if (!command) return null;
    const exitCode = num(metadata.exitCode);
    const signal = str(metadata.signal);
    const stdoutBytes = num(metadata.stdoutBytes);
    const stderrBytes = num(metadata.stderrBytes);
    const durationMs = num(metadata.durationMs);

    // 连接器命令先还原成业务语言：客户关心的是「钉钉 · 创建待办」，不是一行 shell
    const connector = parseConnectorCommand(command);
    const detail: PresentationDetailLine[] = connector
      ? [{ k: '系统', v: connector.system }, { k: '命令', v: briefCommand(command) }]
      : [{ k: '命令', v: briefCommand(command) }];
    if (exitCode !== undefined) detail.push({ tree: '├', k: '退出码', v: String(exitCode) });
    else if (signal) detail.push({ tree: '├', k: '终止信号', v: signal });
    if (stdoutBytes !== undefined) detail.push({ tree: '├', k: '输出', v: formatBytes(stdoutBytes) });
    if (stderrBytes) detail.push({ tree: '├', k: '错误输出', v: formatBytes(stderrBytes) });
    if (durationMs !== undefined) detail.push({ tree: '└', k: '耗时', v: formatDuration(durationMs) });
    if (metadata.outputExceeded === true) detail.push({ warn: '输出超出捕获上限，已截断' });
    if (metadata.timedOut === true) detail.push({ warn: '执行超时' });
    if (metadata.aborted === true) detail.push({ warn: '已被中止' });

    const technicallyFailed = metadata.timedOut === true
      || metadata.aborted === true
      || (exitCode !== undefined && exitCode !== 0)
      || (exitCode === undefined && !!signal);

    // 只对连接器命令扫 stdout：对任意 Shell 做同样的扫描会把 git sha、容器 id、
    // 毫秒时间戳全当成「业务对象 ID」（生产样本 ID 样 token 精度极差）
    const facts = connector && resultText
      ? extractConnectorFacts(extractStdoutSection(resultText) ?? '', connector.entry)
      : null;
    if (facts) {
      if (facts.fields.length) detail.push({ fields: facts.fields });
      if (facts.url) detail.push({ k: '链接', v: facts.url });
    }

    // 回执只在「连接器识别成功 + 动作是写操作 + 拿到对象 ID 或业务域名链接 +
    // 回执没自报失败」四条同时成立时才盖章。回执是系统盖的章，盖错一次比不盖
    // 一百次更贵——查询类动作（get/list/status）拿到的 ID 是查出来的对象，
    // 不是本次执行创建/改动的证明，盖上去就是把「看过」冒充成「做过」。
    const receiptId = facts && !facts.failed ? facts.objectId ?? facts.url : undefined;
    const receipt = connector?.isWrite && receiptId && !technicallyFailed
      ? { id: receiptId, system: connector.system }
      : undefined;

    return {
      // description 是模型对本次执行的意图说明；没有它时，连接器命令仍能给出业务标题
      title: str(input.description) ?? (connector ? `${connector.system} · ${connector.action}` : '执行命令'),
      detail,
      status: technicallyFailed || facts?.failed ? 'warn' : 'ok',
      ...(receipt ? { receipt } : {}),
      // 动了外部系统的调用打标记：渲染层据此抽出单独成行（与 receipt 分工——
      // receipt 是「拿到单据号」，connector 是「这次动了客户的系统」，
      // 写操作失败或没返回 ID 时没有 receipt，但客户仍该看见 AI 动了他的钉钉）
      ...(connector ? { connector: { system: connector.system, write: connector.isWrite } } : {}),
    };
  },

  Write: (input, metadata) => {
    const filePath = str(metadata.path) ?? str(input.file_path);
    if (!filePath) return null;
    const bytes = num(metadata.bytesWritten);
    const detail: PresentationDetailLine[] = [{ k: '路径', v: filePath }];
    if (bytes !== undefined) detail.push({ tree: '└', k: '写入', v: formatBytes(bytes) });
    return { title: `写入 ${basename(filePath)}`, detail, status: 'ok' };
  },

  Read: (input, metadata) => {
    const filePath = str(metadata.path) ?? str(input.file_path) ?? str(input.path);
    if (!filePath) return null;
    const linesRead = num(metadata.linesRead);
    const fileBytes = num(metadata.fileBytes);
    const truncated = metadata.truncated === true;

    const detail: PresentationDetailLine[] = [{ k: '路径', v: filePath }];
    // 请求范围与实读行数分开写：两者不一致本身就是重要信息
    if (metadata.ranged === true) {
      const offset = num(input.offset) ?? 1;
      const limit = num(input.limit);
      detail.push({
        tree: '├',
        k: '请求范围',
        v: limit !== undefined ? `第 ${offset}–${offset + limit} 行` : `自第 ${offset} 行`,
      });
    }
    if (linesRead !== undefined) detail.push({ tree: '├', k: '实读', v: `${linesRead.toLocaleString('zh-CN')} 行` });
    if (fileBytes !== undefined) detail.push({ tree: '└', k: '文件大小', v: formatBytes(fileBytes) });
    if (truncated) {
      const shown = num(metadata.shownBytes);
      detail.push({ warn: shown !== undefined ? `超出单次读取上限，仅返回前 ${formatBytes(shown)}` : '内容已截断' });
    }

    return {
      title: `读取 ${basename(filePath)}`,
      detail,
      status: truncated ? 'warn' : 'ok',
    };
  },

  WebSearch: (input, metadata) => {
    const query = str(metadata.query) ?? str(input.query);
    if (!query) return null;
    const detail: PresentationDetailLine[] = [{ k: '检索词', v: query }];
    const provider = str(metadata.provider);
    if (provider) detail.push({ tree: '├', k: '来源', v: provider });
    const count = num(metadata.resultCount);
    if (count !== undefined) detail.push({ tree: '└', k: '命中', v: `${count} 条` });
    if (metadata.truncated === true) detail.push({ warn: '结果过多，已截断' });
    return { title: '联网检索', detail, status: 'ok' };
  },

  WebFetch: (input, metadata) => {
    const url = str(metadata.finalUrl) ?? str(metadata.url) ?? str(input.url);
    if (!url) return null;
    const detail: PresentationDetailLine[] = [{ k: '来源', v: url }];
    // 发生跳转时把原始地址也写出来——落到哪个域名是安全相关的事实
    const original = str(metadata.url);
    const finalUrl = str(metadata.finalUrl);
    if (original && finalUrl && original !== finalUrl) {
      detail.push({ tree: '├', k: '原始地址', v: original });
    }
    const status = num(metadata.status);
    if (status !== undefined) detail.push({ tree: '├', k: 'HTTP', v: String(status) });
    const returned = num(metadata.returnedLength);
    const raw = num(metadata.rawLength);
    if (returned !== undefined) {
      const ratio = raw !== undefined && raw > returned ? `（原文 ${raw.toLocaleString('zh-CN')} 字）` : '';
      detail.push({ tree: '├', k: '正文', v: `${returned.toLocaleString('zh-CN')} 字${ratio}` });
    }
    const tookMs = num(metadata.tookMs);
    if (tookMs !== undefined) detail.push({ tree: '└', k: '耗时', v: formatDuration(tookMs) });
    if (metadata.truncated === true) detail.push({ warn: '正文超出上限，已截断' });
    return { title: '读取网页', detail, status: metadata.truncated === true ? 'warn' : 'ok' };
  },

  GenerateImage: (input, metadata) => {
    const engine = str(metadata.engine);
    const detail: PresentationDetailLine[] = [];
    const prompt = str(input.prompt);
    if (prompt) detail.push({ k: '画面', v: prompt });
    if (engine) detail.push({ tree: '├', k: '引擎', v: engine });
    const size = str(metadata.size);
    if (size) detail.push({ tree: '├', k: '尺寸', v: size });
    const count = num(metadata.count);
    if (count !== undefined) detail.push({ tree: '├', k: '数量', v: `${count} 张` });
    // 扣费是客户最该看见的一行，缺省时不猜
    const credits = num(metadata.creditsCharged);
    if (credits !== undefined) {
      const note = str(metadata.pricingNote);
      detail.push({ tree: '└', k: '积分', v: note ? `${credits}（${note}）` : String(credits) });
    } else if (str(metadata.billingNote)) {
      detail.push({ tree: '└', k: '计费', v: str(metadata.billingNote)! });
    }
    return detail.length ? { title: '生成图片', detail, status: 'ok' } : null;
  },

  Edit: (input, metadata) => {
    const filePath = str(metadata.path) ?? str(input.file_path);
    if (!filePath) return null;
    const replacements = num(metadata.replacements);
    const occurrences = num(metadata.occurrences);
    const before = num(metadata.bytesBefore);
    const after = num(metadata.bytesAfter);

    const detail: PresentationDetailLine[] = [{ k: '路径', v: filePath }];
    if (replacements !== undefined) {
      // 命中多处但只替换一处时把两个数都写出来——这正是 replace_all 语义最容易看漏的地方
      const hint = occurrences !== undefined && occurrences !== replacements ? `（命中 ${occurrences} 处）` : '';
      detail.push({ tree: '├', k: '替换', v: `${replacements} 处${hint}` });
    }
    if (before !== undefined && after !== undefined) {
      const delta = after - before;
      const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
      detail.push({ tree: '└', k: '体积变化', v: `${sign}${formatBytes(Math.abs(delta))}` });
    }
    return { title: `修改 ${basename(filePath)}`, detail, status: 'ok' };
  },
};

const RULES: Record<string, Rule> = {
  Read: (input) => {
    const filePath = str(input.file_path);
    if (!filePath) return null;
    const detail: ToolPresentation['detail'] = [{ k: '路径', v: filePath }];
    const offset = input.offset;
    const limit = input.limit;
    if (typeof offset === 'number' || typeof limit === 'number') {
      const from = typeof offset === 'number' ? offset : 0;
      const span = typeof limit === 'number' ? `${from}–${from + limit}` : `自第 ${from} 行`;
      detail.push({ tree: '└', k: '范围', v: `第 ${span} 行` });
    }
    return { title: `读取 ${basename(filePath)}`, detail };
  },

  Write: (input) => {
    const filePath = str(input.file_path);
    if (!filePath) return null;
    return { title: `写入 ${basename(filePath)}`, detail: [{ k: '路径', v: filePath }] };
  },

  Edit: (input) => {
    const filePath = str(input.file_path);
    if (!filePath) return null;
    const detail: ToolPresentation['detail'] = [{ k: '路径', v: filePath }];
    if (input.replace_all === true) detail.push({ tree: '└', k: '模式', v: '全部替换' });
    return { title: `修改 ${basename(filePath)}`, detail };
  },

  Shell: (input) => {
    const command = str(input.command);
    if (!command) return null;
    // description 是模型对本次执行的意图说明，比命令本身更接近业务语言
    const description = str(input.description);
    const connector = parseConnectorCommand(command);
    const detail: ToolPresentation['detail'] = connector
      ? [{ k: '系统', v: connector.system }, { k: '命令', v: briefCommand(command) }]
      : [{ k: '命令', v: briefCommand(command) }];
    return {
      title: description ?? (connector ? `${connector.system} · ${connector.action}` : '执行命令'),
      detail,
      // 入参侧（尚未拿到执行结果）同样打标记：运行中的连接器行就该独立可见，
      // 不能等结果回来才从活动组里跳出来
      ...(connector ? { connector: { system: connector.system, write: connector.isWrite } } : {}),
    };
  },

  WebSearch: (input) => {
    const query = str(input.query);
    if (!query) return null;
    return { title: '联网检索', detail: [{ k: '检索词', v: query }] };
  },

  WebFetch: (input) => {
    const url = str(input.url);
    if (!url) return null;
    const detail: ToolPresentation['detail'] = [{ k: '来源', v: url }];
    const prompt = str(input.prompt);
    if (prompt) detail.push({ tree: '└', k: '提取目标', v: prompt });
    return { title: '读取网页', detail };
  },

  Agent: (input) => {
    const description = str(input.description);
    if (!description) return null;
    const detail: ToolPresentation['detail'] = [];
    const agentType = str(input.subagent_type);
    if (agentType) detail.push({ k: '子 Agent', v: agentType });
    const model = str(input.model);
    if (model) detail.push({ tree: '└', k: '模型', v: model });
    return detail.length ? { title: description, detail } : { title: description };
  },
};

/**
 * 产出方登记表（治理条款）。
 *
 * 每个在真实会话里高频出现的工具都必须在此登记；state 非 covered 时必须写明
 * gap。`toolPresentationCoverage.test.ts` 断言这张表与 RULES 一致，并对
 * 未覆盖数量设只减不增的上限——这是防止「数据后补」再次无限期拖下去的闸门。
 */
export const PRESENTATION_SOURCES: readonly PresentationSourceEntry[] = [
  { tool: 'Read', state: 'covered' },
  { tool: 'Write', state: 'covered' },
  { tool: 'Edit', state: 'covered' },
  {
    tool: 'Shell',
    state: 'covered',
    gap: '成功路径已用截断前 metadata（退出码/字节数/耗时/截断与超时标记）。'
      + '失败路径当前在 toolRuntime 直接 throw，摘要随之丢失——待「失败态进契约」批次一并处理',
  },
  { tool: 'WebSearch', state: 'covered' },
  { tool: 'WebFetch', state: 'covered' },
  {
    tool: 'Agent',
    state: 'covered',
    producedIn: 'mapping',
    gap: '子 run 的耗时/token/轮次在服务端写 tool_use 行时尚未产生，摘要由 shared 的 mapBlock 取聚合值组装',
  },
  { tool: 'GenerateImage', state: 'covered' },
  { tool: 'Skill', state: 'none', gap: '刻意不做：Skill 的 tool_result 是技能正文，摘要价值近乎零；观众关心的是技能内部的 Shell/Read，已被覆盖' },
  {
    tool: 'mcp__*',
    state: 'partial',
    producedIn: 'mapping',
    gap: '07-26 已按 `mcp__<server>__<tool>` 前缀产出「系统 · 动作 + 关键入参」摘要，'
      + '把钉钉/飞书/GitHub 等动作从 `MCP:server/tool` 还原成业务语言。'
      + '但 MCP 结果没有统一 metadata 契约，拿不到写入条数、单据号与回读结果，'
      + '因此不算 covered——要到 covered 需要各 server 回传结构化回执（ToolReceipt）',
  },
] as const;

/**
 * 未覆盖（state !== 'covered'）工具数的上限，**只减不增**。
 *
 * 每让一个工具真正做到 covered，就把这个数字减一并在 PR 里说明。
 * 07-25：Shell/Write 接截断前 metadata（9→7）；Read/Edit 补 provider metadata（7→5）；
 * WebSearch/WebFetch/GenerateImage/Agent 接各自真实结果（5→1）。仅剩 Skill，刻意不做。
 * 调高它需要 code review 显式批准——这正是 `[CITE]` 当年缺的那道闸门。
 *
 * **07-26 例外，1→2**：新登记 `mcp__*`。理由是它此前根本不在表内（连接器动作
 * 显示为 `MCP:server/tool`，是演示与真实之间最大的一处落差），这次把它显式纳入
 * 治理并给出入参侧摘要，但 MCP 缺统一 metadata 契约，诚实标记为 partial
 * 而不是硬凑成 covered。各 server 回传结构化回执后，这个数应回到 1。
 */
export const PRESENTATION_TODO_BUDGET = 2;

/**
 * 在工具执行结果上补一份「给人看」摘要。
 *
 * @param toolName 工具名（`ToolDescriptor.name`，非 id）
 * @param toolInput 原始入参（JSON 字符串或对象）
 * @param existing provider 已自产的 presentation；有值时原样返回，不覆盖
 * @param metadata provider 在截断前自产的执行元数据
 * @param resultText 工具返回正文；仅用于连接器命令的 stdout 硬事实提取
 * @param tenantId 会话租户；有租户词典覆盖时连接器解析走合并视图
 */
export function buildToolPresentation(
  toolName: string,
  toolInput: unknown,
  existing?: ToolPresentation,
  metadata?: Record<string, unknown>,
  resultText?: string,
  tenantId?: string,
): ToolPresentation | undefined {
  // provider 在截断前自产的摘要信息量严格更高，规则不得覆盖
  if (existing) return existing;
  const input = parseInput(toolInput);
  currentParseTenantId = tenantId;
  try {
    // metadata 来自截断前的真实执行结果，优先于只看入参的规则
    const metadataRule = METADATA_RULES[toolName];
    if (metadataRule && metadata) {
      const fromMetadata = metadataRule(input, metadata, resultText);
      if (fromMetadata) return fromMetadata;
    }
    const rule = RULES[toolName];
    if (rule) return rule(input) ?? undefined;
    // MCP 工具名是动态的（mcp__<server>__<tool>），走前缀规则而不是精确表
    return buildMcpPresentation(toolName, input) ?? undefined;
  } catch {
    // 摘要是锦上添花，任何异常都不得影响工具执行结果本身
    return undefined;
  } finally {
    currentParseTenantId = undefined;
  }
}

/**
 * 携带摘要的工具执行错误。
 *
 * 工具失败时链路是 `throw` → 上层 catch → 构造错误 tool_result，摘要在这一跳
 * 会丢。但失败恰恰是最该说清楚的时刻：客户看到「读取 差旅.md · 有异常 · 文件
 * 不存在」远好过看到一行「已执行，有异常」。
 */
export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly presentation?: ToolPresentation,
    /** 截断前的结构化事实（已过 extractToolResultMetadata 白名单），随失败事件落库 */
    readonly resultMetadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

/**
 * 失败时的摘要。
 *
 * 优先用错误自带的（那是 provider 在截断前按真实 metadata 产出的）；
 * 否则退回入参侧规则，并强制标记为 warn——**失败的执行绝不允许显示为 ok**。
 * 入参侧规则本身不产出 status，所以这里必须显式兜底。
 */
export function buildFailurePresentation(
  toolName: string,
  toolInput: unknown,
  error: unknown,
  tenantId?: string,
): ToolPresentation | undefined {
  if (error instanceof ToolExecutionError && error.presentation) {
    return { ...error.presentation, status: error.presentation.status ?? 'warn' };
  }
  const base = buildToolPresentation(toolName, toolInput, undefined, undefined, undefined, tenantId);
  return base ? { ...base, status: 'warn' } : undefined;
}

/**
 * 进 `tool_result` durable 事件的结构化元数据白名单。
 *
 * 为什么要有这一层：`metadata` 在 provider 手里是**截断前**的真实执行结果，
 * 但落 durable 事件前必须收敛——事件是生产事实源，写进去的每个 key 都会被
 * 长期读取，塞一整个 provider metadata 等于把内部实现细节固化成对外契约。
 * 这张表只放「客户/排障都能直接用、且语义长期稳定」的字段。
 *
 * 与 presentation 的分工：presentation 是**给人看的中文摘要**（会随文案调整），
 * metadata 是**给程序判定的原值**（退出码徽标、失败统计）。同一份原材料，
 * 两个消费面，谁也不该从对方的文本里正则回捞。
 */
const RESULT_METADATA_FIELDS: Record<string, readonly string[]> = {
  Shell: ['exitCode', 'signal', 'durationMs', 'stdoutBytes', 'stderrBytes', 'timedOut', 'aborted', 'outputExceeded'],
  Read: ['linesRead', 'fileBytes', 'shownBytes', 'truncated', 'ranged'],
  Write: ['bytesWritten'],
  Edit: ['replacements', 'occurrences', 'bytesBefore', 'bytesAfter'],
};

/** metadata 里的字符串值上限——signal 之类的短枚举，超长即视为脏数据丢弃 */
const RESULT_METADATA_TEXT_LIMIT = 120;

/**
 * 从 provider 的截断前 metadata 里挑出可长期落库的结构化事实。
 *
 * 只收标量（number/boolean/短 string）：durable 事件要能被 SQL 直接过滤统计，
 * 嵌套对象会立刻退化成「又一段需要正则的文本」。未登记的工具返回 undefined，
 * 与 presentation 同一条原则——宁可没有，不可编造。
 */
export function extractToolResultMetadata(
  toolName: string,
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const fields = RESULT_METADATA_FIELDS[toolName];
  if (!fields) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of fields) {
    const value = metadata[key];
    if (typeof value === 'number') {
      if (Number.isFinite(value)) picked[key] = value;
    } else if (typeof value === 'boolean') {
      picked[key] = value;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && trimmed.length <= RESULT_METADATA_TEXT_LIMIT) picked[key] = trimmed;
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** 供覆盖率测试使用 */
export function listPresentationRuleNames(): string[] {
  return [...new Set([...Object.keys(RULES), ...Object.keys(METADATA_RULES)])];
}

/** 供覆盖率测试使用：哪些工具有基于截断前元数据的精确规则 */
export function listMetadataRuleNames(): string[] {
  return Object.keys(METADATA_RULES);
}
