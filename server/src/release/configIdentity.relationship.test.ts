import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { evaluateConfigIdentityStatus, type ExpectedConfigIdentity } from './configIdentity.js';

describe('共同 fixture 与 Runtime evaluator 的权威关系', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../../scripts/release/fixtures/config-identity-summary-cases.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    cases: Array<{
      name: string;
      expectedEvaluation: ReturnType<typeof evaluateConfigIdentityStatus>;
      summary: {
        expected?: ExpectedConfigIdentity;
        observed?: Parameters<typeof evaluateConfigIdentityStatus>[1];
      };
    }>;
  };

  for (const fixtureCase of fixture.cases) {
    it(`evaluates ${fixtureCase.name}`, () => {
      expect(
        evaluateConfigIdentityStatus(fixtureCase.summary.expected, fixtureCase.summary.observed),
      ).toEqual(fixtureCase.expectedEvaluation);
    });
  }
});
