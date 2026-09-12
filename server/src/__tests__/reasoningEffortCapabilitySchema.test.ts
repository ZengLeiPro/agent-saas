import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { reasoningEffortProviderOptionShape } from '../app/reasoningEffortCapabilitySchema.js';

const schema = z.object(reasoningEffortProviderOptionShape).strict();

describe('reasoning effort capability config', () => {
  it('只接受带可信值目录的 supported 能力', () => {
    expect(
      schema.parse({
        reasoning_effort_capability: {
          support: 'supported',
          values: ['none', 'high'],
          default_value: 'high',
          source: 'verified_provider',
        },
      }),
    ).toMatchObject({ reasoning_effort_capability: { values: ['none', 'high'] } });
    expect(() =>
      schema.parse({
        reasoning_effort_capability: { support: 'supported' },
      }),
    ).toThrow(/必须声明/);
  });

  it('unknown/unsupported 不得伪装成有可选值目录', () => {
    for (const support of ['unknown', 'unsupported'] as const) {
      expect(() =>
        schema.parse({
          reasoning_effort_capability: { support, values: ['high'] },
        }),
      ).toThrow(/不能声明/);
    }
  });

  it('默认值必须在去重后的 values 中', () => {
    expect(() =>
      schema.parse({
        reasoning_effort_capability: {
          support: 'supported',
          values: ['low', 'low'],
          default_value: 'low',
        },
      }),
    ).toThrow(/不能重复/);
    expect(() =>
      schema.parse({
        reasoning_effort_capability: {
          support: 'supported',
          values: ['low'],
          default_value: 'high',
        },
      }),
    ).toThrow(/必须包含/);
  });
});
