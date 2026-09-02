import { describe, expect, it } from 'vitest';
import type { SessionRuntimeSelectorInput } from '@agent/shared';
import { adaptWebSessionRuntime } from './sessionRuntimeAdapter';
import { adaptMobileSessionRuntime } from '../../../mobile/src/lib/sessionRuntimeAdapter';

const cases: SessionRuntimeSelectorInput[] = [
  { sessionId: 's', activeSessionId: 's', sessionStatus: 'running', activeStream: { active: true }, appVisibility: 'foreground' },
  { sessionId: 's', activeSessionId: 'other', sessionStatus: 'running', activeStream: { active: true }, appVisibility: 'background' },
  { sessionId: 's', activeSessionId: 's', sessionStatus: 'orphaned', activeStream: { active: false }, appVisibility: 'foreground' },
  { sessionId: 's', activeSessionId: 's', sessionStatus: 'completed', activeStream: { active: true }, appVisibility: 'foreground' },
];

describe('Web/Mobile runtime parity', () => {
  it.each(cases)('shares canonical selection for $sessionStatus/$appVisibility', (input) => {
    expect(adaptWebSessionRuntime(input)).toEqual(adaptMobileSessionRuntime(input));
  });
});
