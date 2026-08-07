import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TOOL_CALL_REPAIR_MAX_PAYLOAD_BYTES,
  TOOL_CALL_REPAIR_MAX_NAME_CHARS,
  ToolCallRepairStreamGate,
  analyzeAssistantToolCallText,
  createRepairedModelToolCalls,
  getToolCallRepairMetricSnapshot,
  resetToolCallRepairMetricSnapshotForTests,
} from '../runtime/toolCallRepair.js';

const ALLOWED = ['Read', 'Write'];

function promotable(text: string, allowed = ALLOWED) {
  const decision = analyzeAssistantToolCallText(text, allowed);
  expect(decision.kind).toBe('promotable');
  if (decision.kind !== 'promotable') throw new Error(`expected promotable, got ${decision.kind}`);
  return decision;
}

function rejected(text: string, outcome: string, allowed = ALLOWED, maxBytes?: number) {
  const decision = analyzeAssistantToolCallText(text, allowed, maxBytes);
  expect(decision).toMatchObject({ kind: 'rejected', outcome });
  return decision;
}

describe('tool-call-repair parser', () => {
  it('parses named bracket with CRLF, escaped strings, and nested objects', () => {
    const decision = promotable('[Read]\r\n{"path":"a\\\"b","options":{"depth":2}}');
    expect(decision).toMatchObject({
      syntax: 'named-bracket',
      calls: [{ name: 'Read', arguments: { path: 'a"b', options: { depth: 2 } } }],
    });
  });

  it('parses tool bracket and empty object arguments', () => {
    const decision = promotable('[tool:Read] {}');
    expect(decision).toMatchObject({
      syntax: 'tool-bracket',
      calls: [{ name: 'Read', arguments: {} }],
    });
  });

  it.each([
    '<|channel|>analysis to=Read code<|message|>{"path":"a"}<|call|>',
    'commentary to=Read code {"path":"a"}',
  ])('parses complete Harmony syntax: %s', (text) => {
    expect(promotable(text)).toMatchObject({
      syntax: 'harmony',
      calls: [{ name: 'Read', arguments: { path: 'a' } }],
    });
  });

  it('parses unambiguous XML-ish parameters into an arguments object', () => {
    const decision = promotable(
      '<function=Write><parameter=path>notes.txt</parameter>'
      + '<parameter=content>hello & goodbye</parameter></function>',
    );
    expect(decision).toMatchObject({
      syntax: 'xmlish',
      calls: [{ name: 'Write', arguments: { path: 'notes.txt', content: 'hello & goodbye' } }],
    });
  });

  it('parses multiple consecutive calls of the same syntax in order', () => {
    const decision = promotable(
      '[tool:Read] {"path":"a"}\n[tool:Write] {"path":"b","content":"c"}',
    );
    expect(decision.calls.map((call) => call.name)).toEqual(['Read', 'Write']);
    expect(decision.calls.map((call) => call.arguments)).toEqual([
      { path: 'a' },
      { path: 'b', content: 'c' },
    ]);
  });

  it('rejects mixed syntaxes instead of combining them into one executable batch', () => {
    rejected('[tool:Read] {}\n[Write]\n{}', 'rejected_malformed');
  });

  it('enforces exact request allowlist names, including prefix collisions and case ambiguity', () => {
    rejected('[tool:Re] {}', 'rejected_unknown_tool', ['Read', 'ReadFile']);
    rejected('[tool:READ] {}', 'rejected_unknown_tool', ['Read', 'read']);
    expect(promotable('[tool:Read] {}', ['Read', 'ReadFile']).calls[0]?.name).toBe('Read');
  });

  it('rejects explanatory text before or after a candidate', () => {
    rejected('I will call it:\n[tool:Read] {}', 'rejected_mixed_text');
    rejected('[tool:Read] {}\nDone.', 'rejected_mixed_text');
  });

  it.each([
    '```json\n[tool:Read] {"path":"secret"}\n```',
    'Example: `[tool:Read] {"path":"secret"}`',
  ])('rejects Markdown protected ranges: %s', (text) => {
    rejected(text, 'rejected_protected_range');
  });

  it.each([
    '[tool:Read] {"path":}',
    '[tool:Read] []',
    '[tool:Read] "x"',
  ])('rejects malformed, array, and scalar payloads: %s', (text) => {
    rejected(text, 'rejected_malformed');
  });

  it('classifies an incomplete JSON object separately', () => {
    rejected('[tool:Read] {"path":"a"', 'incomplete');
  });

  it('measures the payload cap in UTF-8 bytes', () => {
    const text = '[tool:Read] {"path":"汉汉汉"}';
    rejected(text, 'rejected_over_cap', ALLOWED, Buffer.byteLength('{"path":"汉汉"}', 'utf8'));
  });

  it('rejects payloads over the default 256KB cap', () => {
    const text = `[tool:Read] {"path":"${'x'.repeat(DEFAULT_TOOL_CALL_REPAIR_MAX_PAYLOAD_BYTES)}"}`;
    rejected(text, 'rejected_over_cap');
  });

  it('accepts 120-character names and rejects longer names', () => {
    const maxName = 'x'.repeat(TOOL_CALL_REPAIR_MAX_NAME_CHARS);
    expect(promotable(`[tool:${maxName}] {}`, [maxName]).calls[0]?.name).toBe(maxName);
    const overlong = `${maxName}x`;
    rejected(`[tool:${overlong}] {}`, 'rejected_malformed', [overlong]);
  });

  it('does not treat the real DSML marker as an implemented syntax', () => {
    expect(analyzeAssistantToolCallText(
      '<｜DSML｜tool_calls><｜DSML｜invoke name="Read"></｜DSML｜invoke></｜DSML｜tool_calls>',
      ALLOWED,
    )).toEqual({ kind: 'none', syntax: 'unknown' });
  });

  it('creates stable unique ids for repeated calls without changing argument JSON', () => {
    const text = '[tool:Read] {}\n[tool:Read] {}';
    const calls = promotable(text).calls;
    const first = createRepairedModelToolCalls(text, calls, 'request-1');
    const second = createRepairedModelToolCalls(text, calls, 'request-1');
    const nextRequest = createRepairedModelToolCalls(text, calls, 'request-2');
    expect(second).toEqual(first);
    expect(nextRequest.map((call) => call.id)).not.toEqual(first.map((call) => call.id));
    expect(new Set(first.map((call) => call.id)).size).toBe(2);
    expect(first).toEqual([
      expect.objectContaining({ name: 'Read', arguments: '{}' }),
      expect.objectContaining({ name: 'Read', arguments: '{}' }),
    ]);
  });
});

describe('ToolCallRepairStreamGate', () => {
  beforeEach(() => resetToolCallRepairMetricSnapshotForTests());

  const finish = (gate: ToolCallRepairStreamGate, text: string, nativeToolCallsPresent = false) => gate.finish({
    text,
    allowedToolNames: ALLOWED,
    nativeToolCallsPresent,
    provider: 'test-provider',
    model: 'test-model',
  });

  it.each(['off', 'detect'] as const)('%s mode never blocks normal deltas', (mode) => {
    const gate = new ToolCallRepairStreamGate(mode);
    expect(gate.push('[tool:')).toEqual(['[tool:']);
    expect(gate.push('Read] {}')).toEqual(['Read] {}']);
    const result = finish(gate, '[tool:Read] {}');
    expect(result.promotedToolCalls).toEqual([]);
    expect(result.scrubbed).toBe(false);
  });

  it('repair mode preserves ordinary delta order and never permanently buffers prose', () => {
    const gate = new ToolCallRepairStreamGate('repair');
    expect(gate.push('A')).toEqual(['A']);
    expect(gate.push('B')).toEqual(['B']);
    expect(finish(gate, 'AB').visibleText).toEqual([]);
  });

  it.each([
    ['[Heading] ordinary text', '[Heading] ordinary text'],
    ['<function=Read>ordinary text', '<function=Read>ordinary text'],
    ['commentary to=Read code not-json', 'commentary to=Read code not-json'],
  ])('releases a disproven marker prefix without waiting for EOF: %s', (delta, expected) => {
    const gate = new ToolCallRepairStreamGate('repair');
    expect(gate.push(delta)).toEqual([expected]);
    expect(finish(gate, delta)).toMatchObject({ visibleText: [], scrubbed: false });
  });

  it('buffers a marker split across chunks, hides protocol text, and promotes at EOF', () => {
    const gate = new ToolCallRepairStreamGate('repair');
    const text = '[tool:Read] {"path":"a"}';
    expect(gate.push('[')).toEqual([]);
    expect(gate.push('tool:Re')).toEqual([]);
    expect(gate.push('ad] {"path"')).toEqual([]);
    expect(gate.push(':"a"}')).toEqual([]);
    const result = finish(gate, text);
    expect(result.visibleText).toEqual([]);
    expect(result.scrubbed).toBe(true);
    expect(result.promotedToolCalls).toEqual([
      expect.objectContaining({ name: 'Read', arguments: '{"path":"a"}' }),
    ]);
  });

  it('scrubs an incomplete candidate at EOF and records incomplete/scrubbed outcomes', () => {
    const gate = new ToolCallRepairStreamGate('repair');
    const text = '[tool:Read] {"path":"a"';
    expect(gate.push(text)).toEqual([]);
    const result = finish(gate, text);
    expect(result).toMatchObject({ scrubbed: true, promotedToolCalls: [] });
    expect(getToolCallRepairMetricSnapshot().map((metric) => metric.outcome)).toEqual([
      'candidate',
      'incomplete',
      'scrubbed',
    ]);
  });

  it('uses bounded buffering and scrubs an over-cap candidate', () => {
    const gate = new ToolCallRepairStreamGate('repair', 16);
    const text = `[tool:Read] {"path":"${'x'.repeat(9_000)}"}`;
    expect(gate.push(text)).toEqual([]);
    expect(finish(gate, text)).toMatchObject({ scrubbed: true, promotedToolCalls: [] });
  });

  it('never promotes a complete payload when the provider stream lacks a terminal marker', () => {
    const gate = new ToolCallRepairStreamGate('repair');
    const text = '[tool:Read] {"path":"a"}';
    expect(gate.push(text)).toEqual([]);
    const result = gate.finish({
      text,
      allowedToolNames: ALLOWED,
      nativeToolCallsPresent: false,
      provider: 'test-provider',
      model: 'test-model',
      streamComplete: false,
    });
    expect(result).toMatchObject({
      decision: { kind: 'rejected', outcome: 'incomplete' },
      scrubbed: true,
      promotedToolCalls: [],
    });
  });

  it('scrubs a confirmed DSML prefix instead of leaking it on a later stream error', () => {
    const gate = new ToolCallRepairStreamGate('repair');
    expect(gate.push('< ｜')).toEqual([]);
    expect(gate.push('DSML ｜ tool_calls>secret')).toEqual([]);
    expect(gate.abort()).toEqual([]);
  });

  it('releases a partial candidate on abort/error without changing text', () => {
    const gate = new ToolCallRepairStreamGate('repair');
    const partial = '[tool:Re';
    expect(gate.push(partial)).toEqual([]);
    expect(gate.abort()).toEqual([partial]);
  });

  it('keeps native structured calls authoritative and never emits a duplicate repair', () => {
    const gate = new ToolCallRepairStreamGate('repair');
    const text = '[tool:Read] {}';
    expect(gate.push(text)).toEqual([]);
    expect(finish(gate, text, true)).toMatchObject({
      scrubbed: true,
      promotedToolCalls: [],
    });
  });
});
