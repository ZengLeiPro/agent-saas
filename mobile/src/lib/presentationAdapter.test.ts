import { describe, expect, it } from 'vitest';
import { selectRenderModel, type BusinessStepEventItem } from '@agent/shared';
import {
  adaptBusinessStepPresentationForMobile,
  adaptToolPresentationForMobile,
  adaptUnknownPresentationForMobile,
} from './presentationAdapter';

describe('M40-04 / TASK-375 Mobile shared presentation adapter', () => {
  it('consumes RenderModel + card contracts without exposing raw data to non-debug semantics', () => {
    const item = selectRenderModel({
      messages: [
        {
          id: 'tool',
          type: 'tool_use',
          toolId: 'call',
          toolName: 'Read',
          toolInput: '{"token":"MOBILE_RAW_INPUT"}',
          result: '{"secret":"MOBILE_RAW_RESULT"}',
          resultReady: true,
          executionStatus: 'completed',
          presentation: { title: '读取完成' },
        },
      ],
    }).items[0];
    const surface = adaptToolPresentationForMobile(item);
    expect(surface.card?.kind).toBe('tool');
    expect(surface.accessibility).toMatchObject({ role: 'summary' });
    expect(surface.accessibility.label).toContain('读取完成');
    expect(surface.accessibility.label).toContain('已完成');
    expect(JSON.stringify(surface)).not.toContain('MOBILE_RAW_INPUT');
    expect(JSON.stringify(surface)).not.toContain('MOBILE_RAW_RESULT');
  });

  it('keeps standalone tool_result raw data behind the effective session debug gate', () => {
    const item = selectRenderModel({
      messages: [{
        id: 'orphan-result',
        type: 'tool_result',
        toolId: 'missing-call',
        toolName: 'Read',
        result: 'MOBILE_STANDALONE_RAW_RESULT',
      }],
    }).items[0];

    const closed = adaptToolPresentationForMobile(item);
    expect(closed.presentation.showRaw).toBe(false);
    expect(JSON.stringify(closed)).not.toContain('MOBILE_STANDALONE_RAW_RESULT');

    const opened = adaptToolPresentationForMobile(item, { explicitSessionToggle: true });
    expect(opened.presentation.showRaw).toBe(true);
  });

  it('retains a BusinessStep checklist projection from the shared presenter', () => {
    const step: BusinessStepEventItem = {
      type: 'business_step',
      id: 'step',
      anchorMessageId: 'todo',
      kind: 'complete',
      todo: {
        kind: 'business',
        content: '完成核验',
        status: 'completed',
        display: [
          {
            kind: 'records',
            layout: 'checklist',
            title: '检查',
            items: [{ label: '健康检查', value: '通过' }],
          },
        ],
      },
    };
    const surface = adaptBusinessStepPresentationForMobile(step);
    expect(surface.presentation.tone).toBe('success');
    expect(surface.presentation.display[0]).toMatchObject({ kind: 'records', layout: 'checklist' });
  });

  it('uses the generic unknown card for future kinds', () => {
    const surface = adaptUnknownPresentationForMobile('future', { raw: 'MOBILE_UNKNOWN_RAW' });
    expect(surface.card?.kind).toBe('unknown');
    expect(surface.presentation.showRaw).toBe(false);
    expect(JSON.stringify(surface)).not.toContain('MOBILE_UNKNOWN_RAW');
  });
});
