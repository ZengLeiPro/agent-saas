import { createHash } from 'node:crypto';

import type { ModelToolCall } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ToolCallRepair');

export type ToolCallRepairMode = 'off' | 'detect' | 'repair';
export type ToolCallRepairSyntax = 'named-bracket' | 'tool-bracket' | 'harmony' | 'xmlish' | 'mixed' | 'unknown';
export type ToolCallRepairOutcome =
  | 'candidate'
  | 'promoted'
  | 'rejected_unknown_tool'
  | 'rejected_malformed'
  | 'rejected_mixed_text'
  | 'rejected_protected_range'
  | 'rejected_over_cap'
  | 'scrubbed'
  | 'incomplete';

export const DEFAULT_TOOL_CALL_REPAIR_MAX_PAYLOAD_BYTES = 256_000;
export const TOOL_CALL_REPAIR_MAX_NAME_CHARS = 120;
const MAX_STREAM_WRAPPER_BYTES = 8_192;
const HARMONY_CHANNELS = ['analysis', 'commentary', 'final'] as const;

export interface RepairedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  syntax: Exclude<ToolCallRepairSyntax, 'mixed' | 'unknown'>;
  rawStart: number;
  rawEnd: number;
}

export type ToolCallRepairDecision =
  | { kind: 'none'; syntax: 'unknown' }
  | {
    kind: 'promotable';
    syntax: ToolCallRepairSyntax;
    calls: RepairedToolCall[];
  }
  | {
    kind: 'rejected';
    syntax: ToolCallRepairSyntax;
    outcome: Exclude<ToolCallRepairOutcome, 'candidate' | 'promoted' | 'scrubbed'>;
  };

export interface ToolCallRepairMetricLabels {
  provider: string;
  model: string;
  syntax: ToolCallRepairSyntax;
  mode: ToolCallRepairMode;
  outcome: ToolCallRepairOutcome;
}

const metricCounters = new Map<string, number>();

/** Privacy-safe, low-cardinality process metrics. No text, payload, arguments, ids, or session labels. */
export function recordToolCallRepairMetric(labels: ToolCallRepairMetricLabels): void {
  const safe = {
    provider: compactLabel(labels.provider),
    model: compactLabel(labels.model),
    syntax: labels.syntax,
    mode: labels.mode,
    outcome: labels.outcome,
  };
  const key = `${safe.provider}|${safe.model}|${safe.syntax}|${safe.mode}|${safe.outcome}`;
  metricCounters.set(key, (metricCounters.get(key) ?? 0) + 1);
  logger.info(
    `metric outcome=${safe.outcome} provider=${safe.provider} model=${safe.model} `
    + `syntax=${safe.syntax} mode=${safe.mode}`,
  );
}

export function getToolCallRepairMetricSnapshot(): ReadonlyArray<ToolCallRepairMetricLabels & { count: number }> {
  return Array.from(metricCounters.entries()).map(([key, count]) => {
    const [provider, model, syntax, mode, outcome] = key.split('|');
    return {
      provider: provider!,
      model: model!,
      syntax: syntax as ToolCallRepairSyntax,
      mode: mode as ToolCallRepairMode,
      outcome: outcome as ToolCallRepairOutcome,
      count,
    };
  });
}

export function resetToolCallRepairMetricSnapshotForTests(): void {
  metricCounters.clear();
}

function compactLabel(value: string): string {
  const normalized = value.trim().slice(0, 80).replace(/[^A-Za-z0-9_.:/-]/g, '_');
  return normalized || 'unknown';
}

export function toolCallRepairProviderLabel(modelRef: string | undefined): string {
  const separator = modelRef?.indexOf('/') ?? -1;
  return separator > 0 ? modelRef!.slice(0, separator) : 'unknown';
}

interface ParseResultComplete {
  kind: 'complete';
  call: RepairedToolCall;
  next: number;
}

interface ParseResultRejected {
  kind: 'rejected';
  syntax: ToolCallRepairSyntax;
  outcome: Extract<ToolCallRepairDecision, { kind: 'rejected' }>['outcome'];
}

type ParseOneResult = ParseResultComplete | ParseResultRejected;

/**
 * Parses only standalone assistant text. It never searches inside prose and only returns exact
 * request-allowlisted names with complete object arguments.
 */
export function analyzeAssistantToolCallText(
  text: string,
  allowedToolNames: Iterable<string>,
  maxPayloadBytes = DEFAULT_TOOL_CALL_REPAIR_MAX_PAYLOAD_BYTES,
): ToolCallRepairDecision {
  if (!text || !text.trim()) return { kind: 'none', syntax: 'unknown' };

  const protectedRanges = findMarkdownCodeRanges(text);
  const markerOffsets = findMarkerOffsets(text);
  if (markerOffsets.length === 0) return { kind: 'none', syntax: 'unknown' };
  if (markerOffsets.some((offset) => isProtected(offset, protectedRanges))) {
    return { kind: 'rejected', syntax: syntaxAt(text, markerOffsets[0]!), outcome: 'rejected_protected_range' };
  }

  const first = skipWhitespace(text, 0);
  if (!isPotentialCallStart(text, first)) {
    return { kind: 'rejected', syntax: syntaxAt(text, markerOffsets[0]!), outcome: 'rejected_mixed_text' };
  }

  const allowed = new Set(allowedToolNames);
  const calls: RepairedToolCall[] = [];
  let cursor = first;
  let aggregateBytes = 0;
  while (cursor < text.length) {
    const parsed = parseOne(text, cursor, maxPayloadBytes);
    if (parsed.kind === 'rejected') return parsed;
    aggregateBytes += Buffer.byteLength(text.slice(parsed.call.rawStart, parsed.call.rawEnd), 'utf8');
    if (aggregateBytes > maxPayloadBytes) {
      return { kind: 'rejected', syntax: parsed.call.syntax, outcome: 'rejected_over_cap' };
    }
    if (!allowed.has(parsed.call.name)) {
      return { kind: 'rejected', syntax: parsed.call.syntax, outcome: 'rejected_unknown_tool' };
    }
    calls.push(parsed.call);
    cursor = skipWhitespace(text, parsed.next);
    if (cursor >= text.length) break;
    if (!isPotentialCallStart(text, cursor)) {
      return {
        kind: 'rejected',
        syntax: calls.length > 1 ? 'mixed' : parsed.call.syntax,
        outcome: 'rejected_mixed_text',
      };
    }
  }

  if (calls.length === 0) return { kind: 'none', syntax: 'unknown' };
  if (!calls.every((call) => call.syntax === calls[0]!.syntax)) {
    return { kind: 'rejected', syntax: 'mixed', outcome: 'rejected_malformed' };
  }
  return { kind: 'promotable', syntax: calls[0]!.syntax, calls };
}

function parseOne(text: string, start: number, maxPayloadBytes: number): ParseOneResult {
  if (text.startsWith('<function=', start)) return parseXmlish(text, start, maxPayloadBytes);
  if (isHarmonyStart(text, start)) return parseHarmony(text, start, maxPayloadBytes);
  if (text[start] === '[') return parseBracket(text, start, maxPayloadBytes);
  return { kind: 'rejected', syntax: 'unknown', outcome: 'rejected_malformed' };
}

function parseBracket(text: string, start: number, maxPayloadBytes: number): ParseOneResult {
  const close = text.indexOf(']', start + 1);
  if (close === -1) return { kind: 'rejected', syntax: 'unknown', outcome: 'incomplete' };
  const header = text.slice(start + 1, close);
  const toolPrefix = header.startsWith('tool:');
  const name = toolPrefix ? header.slice('tool:'.length) : header;
  const syntax: RepairedToolCall['syntax'] = toolPrefix ? 'tool-bracket' : 'named-bracket';
  if (!validPlainName(name)) return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };

  let cursor = close + 1;
  if (!toolPrefix) {
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    const lineEnd = consumeLineBreak(text, cursor);
    if (lineEnd === null) {
      return cursor >= text.length
        ? { kind: 'rejected', syntax, outcome: 'incomplete' }
        : { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
    }
    cursor = lineEnd;
  }
  cursor = skipWhitespace(text, cursor);
  const json = parseJsonObject(text, cursor, maxPayloadBytes, syntax);
  if (json.kind === 'rejected') return json;
  cursor = json.next;
  const afterPayload = skipWhitespace(text, cursor);
  const closings = [`[/${name}]`, '[END_TOOL_REQUEST]'];
  const closing = closings.find((value) => text.startsWith(value, afterPayload));
  if (closing) cursor = afterPayload + closing.length;
  return {
    kind: 'complete',
    next: cursor,
    call: { name, arguments: json.arguments, syntax, rawStart: start, rawEnd: cursor },
  };
}

function parseHarmony(text: string, start: number, maxPayloadBytes: number): ParseOneResult {
  const syntax: RepairedToolCall['syntax'] = 'harmony';
  let cursor = start;
  if (text.startsWith('<|channel|>', cursor)) cursor += '<|channel|>'.length;

  const channel = HARMONY_CHANNELS.find((entry) => text.startsWith(entry, cursor));
  if (!channel) return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  cursor += channel.length;
  if (text[cursor] !== ' ' && text[cursor] !== '\t') {
    return cursor >= text.length
      ? { kind: 'rejected', syntax, outcome: 'incomplete' }
      : { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith('to=', cursor)) {
    return isLiteralPrefixAt(text, cursor, 'to=')
      ? { kind: 'rejected', syntax, outcome: 'incomplete' }
      : { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  }
  cursor += 'to='.length;
  const nameStart = cursor;
  while (/[A-Za-z0-9_-]/.test(text[cursor] ?? '')) cursor += 1;
  const name = text.slice(nameStart, cursor);
  if (!validPlainName(name)) return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  if (text[cursor] !== ' ' && text[cursor] !== '\t') {
    return cursor >= text.length
      ? { kind: 'rejected', syntax, outcome: 'incomplete' }
      : { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith('code', cursor)) {
    return isLiteralPrefixAt(text, cursor, 'code')
      ? { kind: 'rejected', syntax, outcome: 'incomplete' }
      : { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  }
  cursor = skipWhitespace(text, cursor + 'code'.length);
  if (text.startsWith('<|message|>', cursor)) {
    cursor = skipWhitespace(text, cursor + '<|message|>'.length);
  } else if (isLiteralPrefixAt(text, cursor, '<|message|>')) {
    return { kind: 'rejected', syntax, outcome: 'incomplete' };
  }

  const json = parseJsonObject(text, cursor, maxPayloadBytes, syntax);
  if (json.kind === 'rejected') return json;
  cursor = skipWhitespace(text, json.next);
  if (text.startsWith('<|call|>', cursor)) {
    cursor += '<|call|>'.length;
  } else if (cursor < text.length && isLiteralPrefixAt(text, cursor, '<|call|>')) {
    return { kind: 'rejected', syntax, outcome: 'incomplete' };
  } else {
    cursor = json.next;
  }
  return {
    kind: 'complete',
    next: cursor,
    call: { name, arguments: json.arguments, syntax, rawStart: start, rawEnd: cursor },
  };
}

function parseXmlish(text: string, start: number, maxPayloadBytes: number): ParseOneResult {
  const syntax: RepairedToolCall['syntax'] = 'xmlish';
  const nameStart = start + '<function='.length;
  const nameEnd = text.indexOf('>', nameStart);
  if (nameEnd === -1) return { kind: 'rejected', syntax, outcome: 'incomplete' };
  const name = text.slice(nameStart, nameEnd);
  if (!validXmlName(name)) return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  const functionEnd = indexOfAsciiCaseInsensitive(text, '</function>', nameEnd + 1);
  if (functionEnd === -1) {
    const bytes = Buffer.byteLength(text.slice(nameEnd + 1), 'utf8');
    return {
      kind: 'rejected',
      syntax,
      outcome: bytes > maxPayloadBytes ? 'rejected_over_cap' : 'incomplete',
    };
  }
  const body = text.slice(nameEnd + 1, functionEnd);
  if (Buffer.byteLength(body, 'utf8') > maxPayloadBytes) {
    return { kind: 'rejected', syntax, outcome: 'rejected_over_cap' };
  }
  const args: Record<string, unknown> = {};
  let cursor = 0;
  while (skipWhitespace(body, cursor) < body.length) {
    cursor = skipWhitespace(body, cursor);
    if (body.slice(cursor, cursor + '<parameter='.length).toLowerCase() !== '<parameter=') {
      return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
    }
    const parameterNameStart = cursor + '<parameter='.length;
    const parameterNameEnd = body.indexOf('>', parameterNameStart);
    if (parameterNameEnd === -1) return { kind: 'rejected', syntax, outcome: 'incomplete' };
    const parameterName = body.slice(parameterNameStart, parameterNameEnd);
    if (!validXmlName(parameterName) || Object.hasOwn(args, parameterName)) {
      return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
    }
    const parameterEnd = indexOfAsciiCaseInsensitive(body, '</parameter>', parameterNameEnd + 1);
    if (parameterEnd === -1) return { kind: 'rejected', syntax, outcome: 'incomplete' };
    args[parameterName] = normalizeXmlParameter(body.slice(parameterNameEnd + 1, parameterEnd));
    cursor = parameterEnd + '</parameter>'.length;
  }
  const end = functionEnd + '</function>'.length;
  return {
    kind: 'complete',
    next: end,
    call: { name, arguments: args, syntax, rawStart: start, rawEnd: end },
  };
}

function parseJsonObject(
  text: string,
  start: number,
  maxPayloadBytes: number,
  syntax: RepairedToolCall['syntax'],
): { kind: 'complete'; arguments: Record<string, unknown>; next: number } | ParseResultRejected {
  if (start >= text.length) return { kind: 'rejected', syntax, outcome: 'incomplete' };
  if (text[start] !== '{') return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const char = text[cursor]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = cursor + 1;
        break;
      }
    }
    // UTF-16 code units are a lower bound for UTF-8 bytes. This catches large ASCII payloads
    // incrementally without O(n²) re-encoding; the exact UTF-8 check runs once after closure.
    if (cursor - start + 1 > maxPayloadBytes) {
      return { kind: 'rejected', syntax, outcome: 'rejected_over_cap' };
    }
  }
  if (end === -1) {
    return Buffer.byteLength(text.slice(start), 'utf8') > maxPayloadBytes
      ? { kind: 'rejected', syntax, outcome: 'rejected_over_cap' }
      : { kind: 'rejected', syntax, outcome: 'incomplete' };
  }
  const raw = text.slice(start, end);
  if (Buffer.byteLength(raw, 'utf8') > maxPayloadBytes) {
    return { kind: 'rejected', syntax, outcome: 'rejected_over_cap' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
    }
    return { kind: 'complete', arguments: parsed as Record<string, unknown>, next: end };
  } catch {
    return { kind: 'rejected', syntax, outcome: 'rejected_malformed' };
  }
}

export function createRepairedModelToolCalls(
  text: string,
  calls: RepairedToolCall[],
  requestSeed = '',
): ModelToolCall[] {
  return calls.map((call, index) => {
    const argumentsText = JSON.stringify(call.arguments);
    const digest = createHash('sha256')
      .update(`${requestSeed}\0${index}\0${call.syntax}\0${call.name}\0${argumentsText}\0${text}`)
      .digest('hex')
      .slice(0, 24);
    return {
      id: `call_repair_${digest}`,
      name: call.name,
      arguments: argumentsText,
    };
  });
}

export interface ToolCallRepairFinalization {
  decision: ToolCallRepairDecision;
  visibleText: string[];
  promotedToolCalls: ModelToolCall[];
  scrubbed: boolean;
}

/**
 * Bounded stream gate. It only delays an assistant stream whose first non-whitespace bytes can
 * still form a supported marker. Ordinary text is released immediately and in original order.
 */
export class ToolCallRepairStreamGate {
  private state: 'probing' | 'candidate' | 'passthrough' | 'suppressing' = 'probing';
  private pending = '';
  private pendingBytes = 0;
  private forcedOverCap = false;

  constructor(
    private readonly mode: ToolCallRepairMode,
    private readonly maxPayloadBytes = DEFAULT_TOOL_CALL_REPAIR_MAX_PAYLOAD_BYTES,
  ) {}

  push(delta: string): string[] {
    if (!delta) return [];
    if (this.mode !== 'repair' || this.state === 'passthrough') return [delta];
    if (this.state === 'suppressing') return [];

    const deltaBytes = Buffer.byteLength(delta, 'utf8');
    if (this.pendingBytes + deltaBytes > this.maxPayloadBytes + MAX_STREAM_WRAPPER_BYTES) {
      this.forcedOverCap = true;
      this.pending = '';
      this.state = 'suppressing';
      return [];
    }
    this.pending += delta;
    this.pendingBytes += deltaBytes;

    const first = skipWhitespace(this.pending, 0);
    const probe = this.pending.slice(first);
    if (!probe) return [];
    const dsmlPrefix = classifyDsmlPrefix(probe);
    if (dsmlPrefix === 'confirmed') {
      this.pending = '';
      this.state = 'suppressing';
      return [];
    }
    if (dsmlPrefix === 'partial' || couldBePotentialCallPrefix(probe)) {
      this.state = 'candidate';
      return [];
    }

    this.state = 'passthrough';
    const visible = this.pending;
    this.pending = '';
    return [visible];
  }

  abort(): string[] {
    if (this.mode !== 'repair' || this.state === 'passthrough' || this.state === 'suppressing') return [];
    const visible = this.pending;
    this.pending = '';
    this.state = 'passthrough';
    return visible ? [visible] : [];
  }

  finish(params: {
    text: string;
    allowedToolNames: Iterable<string>;
    nativeToolCallsPresent: boolean;
    provider: string;
    model: string;
    /** Stable fingerprint of this logical model request; never logged or used as a metric label. */
    requestSeed?: string;
    /** False when the provider stream ended before its protocol terminal marker. */
    streamComplete?: boolean;
  }): ToolCallRepairFinalization {
    if (this.mode === 'off') {
      return { decision: { kind: 'none', syntax: 'unknown' }, visibleText: [], promotedToolCalls: [], scrubbed: false };
    }

    const decision = this.forcedOverCap
      ? ({ kind: 'rejected', syntax: syntaxAt(params.text, skipWhitespace(params.text, 0)), outcome: 'rejected_over_cap' } as const)
      : params.streamComplete === false && this.state !== 'passthrough'
        ? ({ kind: 'rejected', syntax: syntaxAt(params.text, skipWhitespace(params.text, 0)), outcome: 'incomplete' } as const)
        : analyzeAssistantToolCallText(params.text, params.allowedToolNames, this.maxPayloadBytes);

    if (decision.kind !== 'none') {
      recordToolCallRepairMetric({
        provider: params.provider,
        model: params.model,
        syntax: decision.syntax,
        mode: this.mode,
        outcome: 'candidate',
      });
    }

    if (this.mode === 'detect') {
      if (decision.kind === 'rejected') {
        recordToolCallRepairMetric({
          provider: params.provider,
          model: params.model,
          syntax: decision.syntax,
          mode: this.mode,
          outcome: decision.outcome,
        });
      }
      return { decision, visibleText: [], promotedToolCalls: [], scrubbed: false };
    }

    if (decision.kind === 'promotable') {
      if (params.nativeToolCallsPresent) {
        recordToolCallRepairMetric({
          provider: params.provider,
          model: params.model,
          syntax: decision.syntax,
          mode: this.mode,
          outcome: 'scrubbed',
        });
        this.pending = '';
        return { decision, visibleText: [], promotedToolCalls: [], scrubbed: true };
      }
      const promotedToolCalls = createRepairedModelToolCalls(params.text, decision.calls, params.requestSeed);
      recordToolCallRepairMetric({
        provider: params.provider,
        model: params.model,
        syntax: decision.syntax,
        mode: this.mode,
        outcome: 'promoted',
      });
      this.pending = '';
      return { decision, visibleText: [], promotedToolCalls, scrubbed: true };
    }

    if (decision.kind === 'rejected') {
      recordToolCallRepairMetric({
        provider: params.provider,
        model: params.model,
        syntax: decision.syntax,
        mode: this.mode,
        outcome: decision.outcome,
      });
      if (
        this.state !== 'passthrough'
        && (decision.outcome === 'incomplete' || decision.outcome === 'rejected_over_cap')
      ) {
        recordToolCallRepairMetric({
          provider: params.provider,
          model: params.model,
          syntax: decision.syntax,
          mode: this.mode,
          outcome: 'scrubbed',
        });
        this.pending = '';
        return { decision, visibleText: [], promotedToolCalls: [], scrubbed: true };
      }
    }

    const visible = this.state === 'passthrough' ? [] : (this.pending ? [this.pending] : []);
    this.pending = '';
    return { decision, visibleText: visible, promotedToolCalls: [], scrubbed: false };
  }
}

function classifyDsmlPrefix(value: string): 'none' | 'partial' | 'confirmed' {
  let cursor = 0;
  if (value[cursor] !== '<') return 'none';
  cursor += 1;
  cursor = skipWhitespace(value, cursor);
  if (cursor >= value.length) return 'partial';
  if (value[cursor] !== '|' && value[cursor] !== '｜') return 'none';
  cursor += 1;
  cursor = skipWhitespace(value, cursor);

  const marker = 'dsml';
  for (let index = 0; index < marker.length; index += 1) {
    if (cursor >= value.length) return 'partial';
    if (value[cursor]!.toLowerCase() !== marker[index]) return 'none';
    cursor += 1;
  }

  cursor = skipWhitespace(value, cursor);
  if (cursor >= value.length) return 'partial';
  return value[cursor] === '|' || value[cursor] === '｜' ? 'confirmed' : 'none';
}

function couldBePotentialCallPrefix(value: string): boolean {
  if (value.startsWith('[')) return couldBeBracketPrefix(value);
  if ('<function='.startsWith(value) || value.startsWith('<function=')) {
    return couldBeXmlishPrefix(value);
  }
  return couldBeHarmonyPrefix(value);
}

function couldBeBracketPrefix(value: string): boolean {
  const close = value.indexOf(']');
  const header = value.slice(1, close === -1 ? undefined : close);
  const toolPrefix = header.startsWith('tool:');
  const name = toolPrefix ? header.slice('tool:'.length) : header;
  if (header === '' || 'tool:'.startsWith(header)) return true;
  if (!/^[A-Za-z0-9_-]*$/.test(name) || name.length > TOOL_CALL_REPAIR_MAX_NAME_CHARS) return false;
  if (close === -1) return true;
  if (!validPlainName(name)) return false;

  let cursor = close + 1;
  if (!toolPrefix) {
    cursor = skipHorizontalWhitespace(value, cursor);
    if (cursor >= value.length) return true;
    const lineEnd = consumeLineBreak(value, cursor);
    if (lineEnd === null) return false;
    cursor = lineEnd;
  }
  cursor = skipWhitespace(value, cursor);
  return cursor >= value.length || value[cursor] === '{';
}

function couldBeXmlishPrefix(value: string): boolean {
  const marker = '<function=';
  if (marker.startsWith(value)) return true;
  let cursor = marker.length;
  while (cursor < value.length && /[A-Za-z0-9_.:-]/.test(value[cursor]!)) cursor += 1;
  if (cursor - marker.length > TOOL_CALL_REPAIR_MAX_NAME_CHARS) return false;
  if (cursor === value.length) return true;
  if (cursor === marker.length || value[cursor] !== '>') return false;
  cursor = skipWhitespace(value, cursor + 1);
  if (cursor === value.length) return true;
  const bodyStart = value.slice(cursor).toLowerCase();
  return '<parameter='.startsWith(bodyStart)
    || bodyStart.startsWith('<parameter=')
    || '</function>'.startsWith(bodyStart)
    || bodyStart.startsWith('</function>');
}

function couldBeHarmonyPrefix(value: string): boolean {
  let cursor = 0;
  const marker = '<|channel|>';
  if (marker.startsWith(value)) return true;
  if (value.startsWith(marker)) cursor = marker.length;

  const channel = HARMONY_CHANNELS.find((entry) => value.startsWith(entry, cursor));
  if (!channel) {
    return HARMONY_CHANNELS.some((entry) => entry.startsWith(value.slice(cursor)));
  }
  cursor += channel.length;
  if (cursor === value.length) return true;
  if (value[cursor] !== ' ' && value[cursor] !== '\t') return false;
  cursor = skipHorizontalWhitespace(value, cursor);
  if (cursor === value.length) return true;
  if (!value.startsWith('to=', cursor)) return isLiteralPrefixAt(value, cursor, 'to=');
  cursor += 'to='.length;

  const nameStart = cursor;
  while (/[A-Za-z0-9_-]/.test(value[cursor] ?? '')) cursor += 1;
  if (cursor - nameStart > TOOL_CALL_REPAIR_MAX_NAME_CHARS) return false;
  if (cursor === value.length) return true;
  if (cursor === nameStart || (value[cursor] !== ' ' && value[cursor] !== '\t')) return false;
  cursor = skipHorizontalWhitespace(value, cursor);
  if (cursor === value.length) return true;
  if (!value.startsWith('code', cursor)) return isLiteralPrefixAt(value, cursor, 'code');
  cursor = skipWhitespace(value, cursor + 'code'.length);
  if (cursor === value.length) return true;
  if (value.startsWith('<|message|>', cursor)) {
    cursor = skipWhitespace(value, cursor + '<|message|>'.length);
  } else if (isLiteralPrefixAt(value, cursor, '<|message|>')) {
    return true;
  }
  return cursor >= value.length || value[cursor] === '{';
}

function isPotentialCallStart(text: string, start: number): boolean {
  return text[start] === '['
    || text.startsWith('<function=', start)
    || isHarmonyStart(text, start);
}

function validPlainName(name: string): boolean {
  return name.length > 0
    && name.length <= TOOL_CALL_REPAIR_MAX_NAME_CHARS
    && /^[A-Za-z0-9_-]+$/.test(name);
}

function validXmlName(name: string): boolean {
  return name.length > 0
    && name.length <= TOOL_CALL_REPAIR_MAX_NAME_CHARS
    && /^[A-Za-z0-9_.:-]+$/.test(name);
}

function consumeLineBreak(text: string, start: number): number | null {
  if (text[start] === '\r') return text[start + 1] === '\n' ? start + 2 : start + 1;
  return text[start] === '\n' ? start + 1 : null;
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let cursor = start;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  return cursor;
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (/\s/.test(text[cursor] ?? '')) cursor += 1;
  return cursor;
}

function isLiteralPrefixAt(text: string, start: number, literal: string): boolean {
  const available = text.length - start;
  return available >= 0 && available < literal.length && literal.startsWith(text.slice(start));
}

function isHarmonyStart(text: string, start: number): boolean {
  let cursor = start;
  if (text.startsWith('<|channel|>', cursor)) cursor += '<|channel|>'.length;
  return HARMONY_CHANNELS.some((channel) => text.startsWith(channel, cursor));
}

function normalizeXmlParameter(value: string): string {
  const lineStart = consumeLineBreak(value, 0);
  const withoutLeading = lineStart === null ? value : value.slice(lineStart);
  return withoutLeading.replace(/(?:\r\n|[\r\n])$/, '');
}

function indexOfAsciiCaseInsensitive(text: string, marker: string, start: number): number {
  return text.toLowerCase().indexOf(marker.toLowerCase(), start);
}

interface TextRange { start: number; end: number }

function findMarkdownCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('`', cursor);
    if (start === -1) break;
    let width = 1;
    while (text[start + width] === '`') width += 1;
    const marker = '`'.repeat(width);
    const end = text.indexOf(marker, start + width);
    ranges.push({ start, end: end === -1 ? text.length : end + width });
    cursor = end === -1 ? text.length : end + width;
  }
  return ranges;
}

function isProtected(offset: number, ranges: TextRange[]): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function findMarkerOffsets(text: string): number[] {
  const offsets = [
    ...Array.from(text.matchAll(/\[(?:tool:)?[A-Za-z0-9_-]+\]|<function=|<\|channel\|>/g), (match) => match.index),
    ...Array.from(
      text.matchAll(/\b(?:analysis|commentary|final)[ \t]+to=/g),
      (match) => match.index,
    ),
  ];
  return [...new Set(offsets)].sort((a, b) => a - b);
}

function syntaxAt(text: string, offset: number): ToolCallRepairSyntax {
  if (text.startsWith('[tool:', offset)) return 'tool-bracket';
  if (text.startsWith('[', offset)) return 'named-bracket';
  if (text.startsWith('<function=', offset)) return 'xmlish';
  if (isHarmonyStart(text, offset)) return 'harmony';
  return 'unknown';
}
