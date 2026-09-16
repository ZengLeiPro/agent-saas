import { describe, expect, it } from 'vitest';

import { applyExternalApiReasoningOverride } from '../runtime/rawRuntimeRunDispatch.js';

describe('external Agent reasoning override', () => {
  it('applies only a value present in the authoritative model capability catalog', () => {
    expect(
      applyExternalApiReasoningOverride(
        {
          protocol: 'responses',
          reasoningEffort: 'medium',
          reasoningEffortCapability: {
            support: 'supported',
            values: ['low', 'medium', 'high'],
            source: 'configured',
          },
        },
        { externalApiReasoning: { enabled: true, effort: 'high' } },
      ),
    ).toMatchObject({ reasoningEffort: 'high', protocol: 'responses' });
  });

  it('fails closed when capability evidence is missing or the value is not allowed', () => {
    expect(() =>
      applyExternalApiReasoningOverride(undefined, {
        externalApiReasoning: { enabled: true, effort: 'high' },
      }),
    ).toThrow('当前模型不接受 reasoning effort=high');
    expect(() =>
      applyExternalApiReasoningOverride(
        {
          reasoningEffortCapability: {
            support: 'supported',
            values: ['low'],
            source: 'configured',
          },
        },
        { externalApiReasoning: { enabled: true, effort: 'high' } },
      ),
    ).toThrow('当前模型不接受 reasoning effort=high');
  });
});
