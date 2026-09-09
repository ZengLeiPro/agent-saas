import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RenderItem } from '@agent/shared';
import { partitionBusinessStepItems } from './businessStepDetails';

// The partition only reads discriminants/IDs; rendering still receives the original authoritative objects.
const item = (id: string, type: string, extra = {}): RenderItem => ({ id, type, ...extra } as RenderItem);

describe('mobile business-step detail partition', () => {
  it('matches Web deliverables/process while retaining interactions and external-system writes in chat', () => {
    const text = item('text', 'text');
    const report = item('report', 'file_download', { artifactId: 'artifact-1' });
    const legacyFile = item('legacy', 'file_download');
    const permission = item('permission', 'permission_request');
    const question = item('question', 'ask_user');
    const write = item('write', 'tool_use');
    const source = Object.freeze([text, report, legacyFile, permission, question, write, text]);
    const result = partitionBusinessStepItems(source, ['write']);
    expect(result.deliverables).toEqual([report]);
    expect(result.process).toEqual([text, legacyFile, write]);
    expect(result.inline).toEqual([permission, question, write]);
    expect(result.process[0]).toBe(text);
    expect(source).toHaveLength(7);
  });
  it('does not invent missing process or deliverables', () => {
    expect(partitionBusinessStepItems([])).toEqual({ deliverables: [], process: [], inline: [] });
  });
  it('keeps the original record when duplicate IDs arrive during replay', () => {
    const first = item('same', 'text', { content: 'first' });
    const replay = item('same', 'text', { content: 'replayed' });
    expect(partitionBusinessStepItems([first, replay]).process).toEqual([first]);
  });
});

describe('mobile business-detail UI wiring', () => {
  const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
  it('opens a full bottom sheet from both a step section and the plan overview', () => {
    expect(source('./BusinessStepDetailSheet.tsx')).toContain('snap="full"');
    expect(source('./BusinessStepBlock.tsx')).toContain('<BusinessStepDetailSheet');
    expect(source('./BusinessStepFlow.tsx')).toContain('<BusinessStepDetailSheet');
    expect(source('./BusinessStepFlow.tsx')).toContain('onSelectTodo=');
    expect(source('./BusinessStepBlock.tsx')).toContain('Keyboard.dismiss()');
  });
  it('does not inline full result tables in the conversation, or add a raw renderer', () => {
    expect(source('./BusinessStepBlock.tsx')).not.toContain('<BusinessStepResultContent');
    expect(source('./BusinessStepBlock.tsx')).toContain('selectBusinessStepPresentation(event, gate)');
    expect(source('./BusinessStepDetailSheet.tsx')).toContain('{renderItem(item)}');
    expect(source('./BusinessStepDetailSheet.tsx')).toContain('<RecordsBlockView');
    expect(source('./BusinessStepDetailSheet.tsx')).toContain('<EvidenceRefs');
  });
  it('provides a close control, fixed-height scrolling, safe-area sizing, and modal accessibility', () => {
    const sheet = source('../../ui/BottomSheet.tsx');
    expect(sheet).toContain('bottomSheetLayout(screenHeight, insets.top, insets.bottom, snap)');
    expect(sheet).toContain('`${testID}-close`');
    expect(sheet).toContain('accessibilityViewIsModal');
    expect(sheet).toContain('onAccessibilityEscape={onClose}');
    expect(sheet).toContain('layout.fixedHeight && styles.fixedBody');
    expect(sheet).toContain('animationGeneration.current');
    expect(sheet).not.toContain('screenHeight * 0.9');
  });
});
