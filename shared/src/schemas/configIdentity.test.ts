import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseConfigIdentitySummary } from './configIdentity.js';

interface ConfigIdentityFixtureCase {
  name: string;
  valid: { shared: boolean };
  summary: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../scripts/release/fixtures/config-identity-summary-cases.json',
    ),
    'utf8',
  ),
) as { cases: ConfigIdentityFixtureCase[] };

describe('Config Identity summary relationship fixture', () => {
  for (const fixtureCase of fixture.cases) {
    it(`${fixtureCase.valid.shared ? 'accepts' : 'rejects'} ${fixtureCase.name}`, () => {
      const parsed = parseConfigIdentitySummary(fixtureCase.summary);
      if (fixtureCase.valid.shared) expect(parsed).toEqual(fixtureCase.summary);
      else expect(parsed).toBeNull();
    });
  }
});
