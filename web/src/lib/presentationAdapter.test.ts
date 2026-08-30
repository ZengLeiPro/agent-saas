import { describe, expect, it } from 'vitest';
import { selectRenderModel, type BusinessStepEventItem, type TodoItem } from '@agent/shared';
import {
  adaptBusinessStepPresentationForMobile,
  adaptToolPresentationForMobile,
  adaptUnknownPresentationForMobile,
} from '../../../mobile/src/lib/presentationAdapter';
import {
  adaptBusinessStepPresentationForWeb,
  adaptToolPresentationForWeb,
  adaptUnknownPresentationForWeb,
} from './presentationAdapter';

function toolItem() {
  return selectRenderModel({
    messages: [
      {
        id: 'tool-message',
        type: 'tool_use',
        toolName: 'Shell',
        toolId: 'tool-call',
        toolInput: '{"token":"RAW_INPUT_SENTINEL","path":"/workspace/private"}',
        result: '{"secret":"RAW_RESULT_SENTINEL"}',
        resultReady: true,
        executionStatus: 'completed',
        presentation: { title: '核对发布结果', status: 'ok', detail: ['发布成功'] },
      },
    ],
  }).items[0];
}

function event(
  todo: TodoItem,
  kind: BusinessStepEventItem['kind'] = 'start',
): BusinessStepEventItem {
  return {
    type: 'business_step',
    id: `step-${todo.status}`,
    anchorMessageId: 'todo-write',
    kind,
    todo,
    stepIndex: 1,
    stepCount: 1,
  };
}

describe('M20-05 Web/Mobile shared presentation parity', () => {
  it('both thin adapters retain the identical Shared presenter/card semantics', () => {
    const item = toolItem();
    const web = adaptToolPresentationForWeb(item);
    const mobile = adaptToolPresentationForMobile(item);
    expect(web.key).toBe(mobile.key);
    expect(web.presentation).toEqual(mobile.presentation);
    expect(web.card).toEqual(mobile.card);
    expect(web.semantic).toBe(mobile.semantic);
    expect(web.accessibility.label).toBe(mobile.accessibility.label);
  });

  it.each([
    ['pending', 'muted'],
    ['in_progress', 'info'],
    ['waiting', 'warn'],
    ['blocked', 'danger'],
    ['completed', 'success'],
    ['failed', 'danger'],
  ] as const)(
    'renders BusinessStep status %s with shared tone %s on both platforms',
    (status, tone) => {
      const step = event({ kind: 'business', content: `步骤-${status}`, status });
      const web = adaptBusinessStepPresentationForWeb(step);
      const mobile = adaptBusinessStepPresentationForMobile(step);
      expect(web.presentation.tone).toBe(tone);
      expect(mobile.presentation).toEqual(web.presentation);
      expect(web.semantic).toBe(mobile.semantic);
    },
  );

  it.each([
    [
      'facts',
      [
        { label: '客户', value: '甲' },
        { label: '地区', value: '华东' },
        { label: '等级', value: 'A' },
      ],
      'grid',
    ],
    ['list', [{ label: '合同', value: 'HT-42' }], 'rows'],
    [
      'comparison',
      [{ label: '数量', baseline: '10', current: '12', delta: '+2', status: 'warn' }],
      'comparison',
    ],
    ['checklist', [{ label: '域名一致', status: 'pass' }], 'checklist'],
  ] as const)(
    'retains renderable BusinessStep display type %s on both platforms',
    (type, items, layout) => {
      const step = event(
        {
          kind: 'business',
          content: `展示-${type}`,
          status: 'completed',
          display: [{ type, title: '结果', items }] as unknown as TodoItem['display'],
        },
        'complete',
      );
      const web = adaptBusinessStepPresentationForWeb(step);
      const mobile = adaptBusinessStepPresentationForMobile(step);
      expect(web.presentation.display[0]).toMatchObject({ kind: 'records', layout });
      expect(mobile.presentation.display).toEqual(web.presentation.display);
    },
  );

  it('uses a safe generic unknown card on both platforms', () => {
    const web = adaptUnknownPresentationForWeb('future-kind', { token: 'RAW_UNKNOWN_SENTINEL' });
    const mobile = adaptUnknownPresentationForMobile('future-kind', {
      token: 'RAW_UNKNOWN_SENTINEL',
    });
    expect(web.presentation.title).toBe('内容不可用');
    expect(web.card?.kind).toBe('unknown');
    expect(mobile.card).toEqual(web.card);
    expect(JSON.stringify({ web, mobile })).not.toContain('RAW_UNKNOWN_SENTINEL');
  });
});

describe('M20-05 non-debug accessibility sensitive scan', () => {
  it('excludes raw input/result/path/secret from Web and Mobile a11y + semantic trees', () => {
    const item = toolItem();
    const surfaces = [adaptToolPresentationForWeb(item), adaptToolPresentationForMobile(item)];
    for (const surface of surfaces) {
      const scan = JSON.stringify({
        accessibility: surface.accessibility,
        semantic: surface.semantic,
        presentation: surface.presentation,
        card: surface.card,
      });
      for (const forbidden of [
        'RAW_INPUT_SENTINEL',
        'RAW_RESULT_SENTINEL',
        '/workspace/private',
        '"secret"',
      ]) {
        expect(scan).not.toContain(forbidden);
      }
    }
  });

  it('opens raw only when build, authenticated admin, and session toggle are all true', () => {
    const item = toolItem();
    const openGate = { debugBuild: true, authenticatedAdmin: true, explicitSessionToggle: true };
    const closedGate = { debugBuild: true, authenticatedAdmin: true, explicitSessionToggle: false };
    expect(JSON.stringify(adaptToolPresentationForWeb(item, closedGate))).not.toContain(
      'RAW_INPUT_SENTINEL',
    );
    expect(JSON.stringify(adaptToolPresentationForMobile(item, closedGate))).not.toContain(
      'RAW_INPUT_SENTINEL',
    );
    const webOpen = adaptToolPresentationForWeb(item, openGate);
    const mobileOpen = adaptToolPresentationForMobile(item, openGate);
    expect(webOpen.presentation.showRaw).toBe(true);
    expect(mobileOpen.presentation.showRaw).toBe(true);
    expect(webOpen.card?.detail?.text).toContain('Input');
    expect(mobileOpen.card?.detail?.text).toContain('Output');
  });
});
