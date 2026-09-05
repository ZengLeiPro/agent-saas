/**
 * DetailLine 的语义判别与排版分组（纯函数，无 DOM / React 依赖）。
 *
 * 与 `web/src/components/detailSemantics.ts` + `PresentationDetail.groupDetailLines`
 * + `BusinessStepFlow.migrateLegacySectionVerdicts` 同一套判定。Web 与 Mobile 的
 * 分型渲染必须落在同一批判定上：一端把「17/18」判成中性、另一端判成通过，
 * 销售演示里同一条会话就会呈现两种结论。
 *
 * 全部判定遵守同一条纪律：**宁可判不出来，也不能判错**。TodoOutcome.stat 带可选的
 * 结构化判定位 `verdict`：服务端/模型显式给出时以它为准；缺省时回落到基于 value 的
 * 文本保守判别，任何拿不准的一律退回中性 / 不隐藏。
 */
import type { DetailLine } from './toolPresentation';
import type { PresentationTone, RecordsBlock } from './presentation/types';

/** stat 的结构化判定位取值。`neutral` 表示「明确不下结论」，不等同于缺省。 */
export type OutcomeStatVerdict = 'pass' | 'fail' | 'neutral';

export interface OutcomeStat {
  label: string;
  value: string;
  /** 显式判定位；缺省时回落到 value 文本的保守判别。 */
  verdict?: OutcomeStatVerdict;
}

// ---------------------------------------------------------------------------
// 1. 关键值判别
// ---------------------------------------------------------------------------

/**
 * 「数字 / 金额 / 比例 / 日期 / 时间」这类值在键值卡里配强调色。
 * 用穷举白名单而不是「含数字即强调」——后者会把 "SO-1001 已回写" 这类
 * 长句子整条染成品牌色，卡片会花掉。
 */
const EMPHASIS_PATTERNS: RegExp[] = [
  /^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$/, // 1,234.5
  /^[+-]?\d+(\.\d+)?%$/, // 12.5%
  /^[¥$€£]\s?[+-]?\d{1,3}(,\d{3})*(\.\d+)?$/, // ¥1,234.00
  /^[+-]?\d{1,3}(,\d{3})*(\.\d+)?\s?(个|项|条|张|份|次|人|家|笔|件|台|套|页|行|列|字|元|万|亿|天|小时|分钟|秒|kb|mb|gb|tb)$/i,
  /^\d+\s*\/\s*\d+$/, // 17/18
  /^\d{4}[-/年]\d{1,2}([-/月]\d{1,2}日?)?$/, // 2026-08-03 / 2026 年 8 月
  /^\d{1,2}[-/月]\d{1,2}日?$/, // 08-03
  /^\d{1,2}:\d{2}(:\d{2})?$/, // 14:05
];

export function isEmphasisValue(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 24) return false;
  return EMPHASIS_PATTERNS.some((pattern) => pattern.test(v));
}

// ---------------------------------------------------------------------------
// 2. 标签判定语义
// ---------------------------------------------------------------------------

export type StatVerdict = 'pass' | 'fail' | null;

const FAIL_SYMBOL = /[✗✘✕✖×❌]/;
const PASS_SYMBOL = /[✓✔√]/;
// 否定式必须先于肯定式匹配：「未通过」里含「通过」。
const FAIL_TEXT =
  /(未通过|不通过|未满足|不满足|不合规|不一致|未达标|不达标|未匹配|无法匹配|不匹配|未覆盖|失败|异常|驳回|退回|缺失|超期|逾期|阻断|拒绝|风险)/;
const PASS_TEXT = /(通过|满足|合规|达标|一致|成功|正常|已核对|已覆盖|无差异|无例外)/;

/**
 * 结构化判定位 `verdict` 优先：它由服务端/模型显式给出，比任何文本猜测更可信，
 * 显式 `neutral` 也压过文本判别（「明确不下结论」不该被 value 里的「通过」改判）。
 *
 * 缺省时回落到文本判别，只看 **value**，不看 label。
 * chip 的形态是「维度名 + 结论/计数」，label 是维度名：
 * 「失败 0」的 label 含「失败」但这条是好消息，按 label 上色会把 0 失败染红。
 *
 * 含数字的 value 一律判为中性（计数值）。代价是「17/18 通过」在没有 `verdict` 时
 * 拿不到绿色，收益是任何计数标签都不会被误判——符合「宁可不上色不误上色」。
 */
export function statVerdict(stat: OutcomeStat): StatVerdict {
  if (stat.verdict === 'pass' || stat.verdict === 'fail') return stat.verdict;
  if (stat.verdict === 'neutral') return null;

  const v = stat.value.trim();
  if (!v) return null;
  if (/[\d０-９]/.test(v)) return null;
  if (FAIL_SYMBOL.test(v) || FAIL_TEXT.test(v)) return 'fail';
  if (PASS_SYMBOL.test(v) || PASS_TEXT.test(v)) return 'pass';
  return null;
}

// ---------------------------------------------------------------------------
// 3. 槽位去重
// ---------------------------------------------------------------------------

/** 全角数字归一 + 去空白 + 去尾部标点 + 小写。 */
function normalizeToken(raw: string): string {
  return raw
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .replace(/[：:、，,。.·・;；]+$/, '')
    .toLowerCase();
}

/**
 * 值归一：只在「数字 + 计量单位」时剥掉尾部单位，让「3」与「3 个」判定为同一个值。
 * 必须要求单位前是数字，否则「文件」会被剥成「文」（「件」也在单位表里）。
 */
function normalizeValue(raw: string): string {
  const token = normalizeToken(raw);
  const matched = /^(.*\d)(个|项|条|张|份|次|人|家|笔|件|台|套|页|行|列|字)$/.exec(token);
  return matched ? matched[1] : token;
}

function pairKey(k: string, v: string): string {
  return `${normalizeToken(k)} ${normalizeValue(v)}`;
}

/** 抽出 detail 里真正以「键 值」两列呈现的行：k/v 行、树形 k/v 行、字段网格。 */
export function collectDetailKeyValues(detail?: readonly DetailLine[]): OutcomeStat[] {
  const pairs: OutcomeStat[] = [];
  for (const line of detail ?? []) {
    if (!line || typeof line !== 'object') continue;
    if ('k' in line && 'v' in line) {
      pairs.push({ label: line.k, value: line.v });
    } else if ('fields' in line) {
      for (const field of line.fields) pairs.push({ label: field.k, value: field.v });
    }
  }
  return pairs;
}

/**
 * 渲染层硬约束的槽位去重。
 *
 * - 与常显详情键值行「同键且同值」的**中性**标签隐藏——同一组数字不该
 *   在一屏里出现两遍。
 * - 判定类标签（绿/红）永远保留：它承载的是结论而不是数字。
 *
 * 匹配条件刻意收得很紧（键与值都要归一后完全相等），宁可少隐藏不可误隐藏。
 */
export function visibleOutcomeStats(
  stats: readonly OutcomeStat[] | undefined,
  detail: readonly DetailLine[] | undefined,
): OutcomeStat[] {
  if (!stats?.length) return [];

  const detailPairs = collectDetailKeyValues(detail);
  if (!detailPairs.length) return [...stats];

  const shown = new Set(detailPairs.map((pair) => pairKey(pair.label, pair.value)));
  return stats.filter(
    (stat) => statVerdict(stat) !== null || !shown.has(pairKey(stat.label, stat.value)),
  );
}

// ---------------------------------------------------------------------------
// 4. 连续 warn 行聚合
// ---------------------------------------------------------------------------

export type DetailGroup =
  { kind: 'line'; line: DetailLine } | { kind: 'warnGroup'; header: string; warns: string[] };

export const DEFAULT_WARN_HEADER = '需要注意';

function isWarnLine(line: DetailLine | undefined): line is { warn: string } {
  return typeof line === 'object' && line !== null && 'warn' in line;
}

function isSectionLine(line: DetailLine | undefined): line is { section: string } {
  return typeof line === 'object' && line !== null && 'section' in line;
}

/**
 * 连续的缺口/警告行聚合为一个色块（demo B11 缺口区的容器形态）。
 * 紧邻其前的小节标题行被吸收为色块标题；没有则用默认标题。
 * 只影响 warn 行的排版分组，其他行原样保持顺序。
 */
export function groupDetailLines(detail: readonly DetailLine[]): DetailGroup[] {
  const groups: DetailGroup[] = [];
  for (let i = 0; i < detail.length; i++) {
    const line = detail[i];
    if (isSectionLine(line) && isWarnLine(detail[i + 1])) {
      const warns: string[] = [];
      let j = i + 1;
      for (; isWarnLine(detail[j]); j++) warns.push((detail[j] as { warn: string }).warn);
      groups.push({ kind: 'warnGroup', header: line.section, warns });
      i = j - 1;
    } else if (isWarnLine(line)) {
      const warns: string[] = [line.warn];
      let j = i + 1;
      for (; isWarnLine(detail[j]); j++) warns.push((detail[j] as { warn: string }).warn);
      groups.push({ kind: 'warnGroup', header: DEFAULT_WARN_HEADER, warns });
      i = j - 1;
    } else {
      groups.push({ kind: 'line', line });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 5. 历史「小节 + 判定行」升级为 checklist 记录块
// ---------------------------------------------------------------------------

const VERDICT_RECORD_TONE: Readonly<
  Record<'pass' | 'fail' | 'warn' | 'pending', PresentationTone>
> = Object.freeze({ pass: 'success', fail: 'danger', warn: 'warn', pending: 'muted' });

export type StepDetailPart =
  { kind: 'detail'; lines: DetailLine[] } | { kind: 'records'; block: RecordsBlock };

function isVerdictLine(
  line: DetailLine | undefined,
): line is { verdict: 'pass' | 'fail' | 'warn' | 'pending'; text: string; note?: string } {
  return typeof line === 'object' && line !== null && 'verdict' in line;
}

/**
 * 历史剧本把判定清单写成「section 标题 + 连续 verdict 行」，新的契约里它是
 * checklist 记录块。这里在渲染前做一次等价升格，让两种来源落到同一套表格排版。
 */
export function migrateLegacySectionVerdicts(
  detail: readonly DetailLine[] | undefined,
): StepDetailPart[] {
  if (!detail?.length) return [];
  const parts: StepDetailPart[] = [];
  let plainLines: DetailLine[] = [];
  const flushPlainLines = () => {
    if (!plainLines.length) return;
    parts.push({ kind: 'detail', lines: plainLines });
    plainLines = [];
  };

  for (let index = 0; index < detail.length;) {
    const section = detail[index];
    if (!isSectionLine(section) || !isVerdictLine(detail[index + 1])) {
      plainLines.push(section);
      index += 1;
      continue;
    }

    flushPlainLines();
    index += 1;
    const items: RecordsBlock['items'] = [];
    for (;;) {
      const verdict = detail[index];
      if (!isVerdictLine(verdict)) break;
      items.push({
        label: verdict.text,
        tone: VERDICT_RECORD_TONE[verdict.verdict],
        ...(verdict.note ? { note: verdict.note } : {}),
      });
      index += 1;
    }
    parts.push({
      kind: 'records',
      block: { kind: 'records', layout: 'checklist', title: section.section, items },
    });
  }

  flushPlainLines();
  return parts;
}
