import { describe, expect, it } from 'vitest';
import type { RenderTimelineStatus } from './renderModel';
import { selectRenderModel } from './renderModel';
import {
  SHARED_PRESENTATION_PRESENTERS,
  canShowRawPresentation,
  listSharedPresentationKinds,
  presentationSemanticSignature,
  selectBusinessStepPresentation,
  selectErrorPresentation,
  selectPresentationCardViewModel,
  selectSharedPresentation,
  selectToolPresentation,
} from './presentationPresenter';

function toolItem(
  status: RenderTimelineStatus = 'completed',
  presentation: unknown = { title: '核对客户资料', status: 'ok' },
  input = '{"token":"raw-token","path":"/workspace/private"}',
  result = '{"secret":"raw-secret","result":"ok"}',
) {
  return selectRenderModel({
    messages: [
      {
        id: 'tool-message',
        type: 'tool_use',
        toolName: 'Read',
        toolInput: input,
        toolId: 'tool-1',
        executionStatus: status,
        result,
        presentation,
      },
    ],
  }).items[0];
}

describe('shared presentation registry', () => {
  it('is frozen and exhaustively lists Tool and BusinessStep presenters', () => {
    expect(Object.isFrozen(SHARED_PRESENTATION_PRESENTERS)).toBe(true);
    expect(listSharedPresentationKinds().sort()).toEqual(['business_step', 'error', 'tool']);
  });

  it('unknown and malformed inputs degrade without throwing or exposing raw data', () => {
    expect(selectSharedPresentation({ kind: 'future', source: { token: 'secret' } })).toEqual({
      title: '内容不可用',
      status: 'unknown',
      statusLabel: '内容不可用',
      tone: 'neutral',
      detail: [],
      display: [],
      evidence: [],
      busy: false,
      showRaw: false,
    });
    expect(() => selectSharedPresentation(null)).not.toThrow();
    expect(selectToolPresentation({ nope: true }).title).toBe('工具');
  });
});

describe('Tool presenter', () => {
  it('reuses RenderModel/ToolPresentation and projects title, tone, receipt and detail', () => {
    const model = selectToolPresentation(
      toolItem('completed', {
        title: '写入审批',
        status: 'warn',
        receipt: { id: 'APPROVAL-42', system: '钉钉审批', readBack: true },
        detail: [{ verdict: 'warn', text: '一项需复核' }],
      }),
    );
    expect(model).toMatchObject({
      title: '写入审批',
      tone: 'warn',
      receipt: { id: 'APPROVAL-42', system: '钉钉审批', readBack: true },
      detail: [{ verdict: 'warn', text: '一项需复核' }],
      display: [],
      evidence: [],
      showRaw: false,
    });
  });

  it.each([
    ['running', 'running', 'info', true],
    ['completed', 'succeeded', 'success', false],
    ['failed', 'failed', 'danger', false],
    ['cancelled', 'cancelled', 'muted', false],
  ] as const)('keeps authoritative execution status %s', (status, canonicalStatus, tone, busy) => {
    expect(selectToolPresentation(toolItem(status, { title: '执行动作', status: 'ok' }))).toMatchObject({
      status: canonicalStatus,
      tone,
      busy,
    });
  });

  it('drops malformed receipts and unsafe semantic strings', () => {
    const model = selectToolPresentation(
      toolItem('completed', {
        title: '<img src=x onerror=alert(1)>',
        receipt: { id: 'javascript:alert(1)', system: '恶意系统' },
        detail: [
          '{"token":"abc"}',
          { k: 'Authorization', v: 'Bearer: abc' },
          { k: 'clientToken', v: 'plain-secret-value' },
          { k: '业务字段', v: 'VALUE_SECRET_SENTINEL' },
          { fields: [{ k: 'path', v: 'secrets/customer.txt' }] },
          { quote: 'https://evil.example/x' },
          { original: '/workspace/customer/private.txt' },
          '安全业务结论',
        ],
      }),
    );
    expect(model.title).toBe('Read');
    expect(model.receipt).toBeUndefined();
    expect(model.detail).toEqual(['安全业务结论']);
  });

  it('never copies raw input/result or secrets into non-debug schema, card or semantics', () => {
    const input = '{"token":"INPUT_SENTINEL","path":"/workspace/private/customer.json"}';
    const result = '{"secret":"RESULT_SENTINEL","accessToken":"TOKEN_SENTINEL"}';
    const item = toolItem(
      'completed',
      { title: '安全摘要', detail: ['只显示业务结果'] },
      input,
      result,
    );
    const model = selectToolPresentation(item);
    const card = selectPresentationCardViewModel(item, model);
    const semantic = presentationSemanticSignature(model);
    const serialized = JSON.stringify({ model, card, semantic });
    for (const forbidden of [
      'INPUT_SENTINEL',
      'RESULT_SENTINEL',
      'TOKEN_SENTINEL',
      '/workspace/private',
      '"secret"',
    ]) {
      expect(serialized).not.toContain(forbidden);
      expect(semantic).not.toContain(forbidden);
    }
  });

  it('keeps raw card detail behind the resolved session debug permission', () => {
    const item = toolItem(
      'completed',
      { title: '调试摘要' },
      'RAW_INPUT_SENTINEL',
      'RAW_RESULT_SENTINEL',
    );
    const closed = selectToolPresentation(item);
    const open = selectToolPresentation(item, { explicitSessionToggle: true });
    expect(JSON.stringify(selectPresentationCardViewModel(item, closed))).not.toContain(
      'RAW_INPUT_SENTINEL',
    );
    expect(JSON.stringify(selectPresentationCardViewModel(item, open))).toContain(
      'RAW_INPUT_SENTINEL',
    );
  });
});

describe('Error presenter', () => {
  it('safe-falls back before classification and exposes at most one recovery action', () => {
    const item = selectRenderModel({
      runtime: [{
        id: 'runtime-error',
        type: 'error',
        status: 'failed',
        content: 'token=RUNTIME_SECRET /workspace/private/error.log',
        domain: 'transport',
        retryability: 'retryable',
      }],
    }).items[0];
    const model = selectErrorPresentation(item);
    expect(model).toMatchObject({
      title: '运行出现问题',
      status: 'failed',
      statusLabel: '执行失败',
      busy: false,
      recoveryAction: { kind: 'retry', label: '重试' },
    });
    expect(JSON.stringify(model)).not.toContain('RUNTIME_SECRET');
    expect(JSON.stringify(model)).not.toContain('/workspace');
  });

  it('treats cancellation as a terminal non-busy state without recovery', () => {
    const model = selectErrorPresentation({ status: 'cancelled', content: [] });
    expect(model).toMatchObject({ status: 'cancelled', statusLabel: '已取消', busy: false });
    expect(model.recoveryAction).toBeUndefined();
  });
});

describe('BusinessStep presenter', () => {
  it.each([
    ['pending', 'muted'],
    ['in_progress', 'info'],
    ['waiting', 'warn'],
    ['blocked', 'danger'],
    ['completed', 'success'],
    ['failed', 'danger'],
  ] as const)('covers authoritative status %s', (status, tone) => {
    expect(selectBusinessStepPresentation({ content: '核对合同', status })).toMatchObject({
      status,
      tone,
      busy: status === 'in_progress',
    });
  });

  it.each([
    ['warn', 'warn'],
    ['fail', 'danger'],
  ] as const)('outcome %s overrides a completed clean tone', (outcomeTone, expected) => {
    const model = selectBusinessStepPresentation({
      content: '核对合同',
      status: 'completed',
      outcome: { text: '17/18 通过', tone: outcomeTone },
    });
    expect(model.tone).toBe(expected);
    expect(model.detail[0]).toEqual({ insight: '17/18 通过' });
  });

  it('projects evidence and drops path, URL, HTML, JSON and secret-bearing references', () => {
    const model = selectBusinessStepPresentation({
      content: '形成核验结论',
      status: 'completed',
      evidenceRefs: [
        'APPROVAL-42',
        '/workspace/private.txt',
        'secrets/customer.txt',
        'https://evil.example/x',
        '<b>伪造</b>',
        '{"token":"secret"}',
        'password=secret',
      ],
    });
    expect(model.evidence).toEqual(['APPROVAL-42']);
  });

  it.each([
    ['facts', 'grid'],
    ['list', 'rows'],
    ['comparison', 'comparison'],
    ['checklist', 'checklist'],
  ] as const)(
    'normalizes semantic display type %s through the shared display registry',
    (type, layout) => {
      const items =
        type === 'facts'
          ? [
              { label: '客户', value: '甲' },
              { label: '地区', value: '华东' },
              { label: '等级', value: 'A' },
            ]
          : type === 'comparison'
            ? [{ label: '数量', baseline: '10', current: '12', delta: '+2', status: 'warn' }]
            : type === 'checklist'
              ? [{ label: '域名一致', status: 'pass' }]
              : [{ label: '命中合同', value: 'HT-42' }];
      const model = selectBusinessStepPresentation({
        content: '业务步骤',
        status: 'completed',
        display: [{ type, title: '结果', items }],
      });
      expect(model.display).toHaveLength(1);
      expect(model.display[0]).toMatchObject({ kind: 'records', layout });
    },
  );
});

describe('raw disclosure policy and hostile structures', () => {
  it.each([
    [{ explicitSessionToggle: true }, true],
    [{ sessionRawEnabled: true }, true],
    [{ explicitSessionToggle: false }, false],
    [undefined, false],
  ] as const)('只按已解析的会话调试权限决定 raw disclosure：%j', (gate, expected) => {
    expect(canShowRawPresentation(gate)).toBe(expected);
    expect(selectToolPresentation(toolItem(), gate).showRaw).toBe(expected);
    expect(
      selectBusinessStepPresentation({ content: '步骤', status: 'pending' }, gate).showRaw,
    ).toBe(expected);
  });

  it('does not invoke getters/toJSON and survives cycles/depth/oversized arrays', () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    const hostile: Record<string, unknown> = { kind: 'tool' };
    Object.defineProperty(hostile, 'source', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      },
    });
    hostile.loop = hostile;
    hostile.toJSON = () => {
      toJsonCalls += 1;
      return { token: 'TO_JSON_SECRET' };
    };
    hostile.deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'too deep' } } } } } } } } };
    hostile.items = Array.from({ length: 10_000 }, (_, index) => index);
    expect(() => selectSharedPresentation(hostile)).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
  });
});
