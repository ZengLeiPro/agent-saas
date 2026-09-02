import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = join(HERE, '..', '..');
const REPOSITORY_ROOT = join(MOBILE_ROOT, '..');

const P0_CONTRACTS = [
  {
    milestone: 'M20',
    sharedFixture: 'shared/src/lib/chatSubmission.test.ts',
    mobileAdapter: 'mobile/src/lib/chatSubmissionAdapter.test.ts',
  },
  {
    milestone: 'M30',
    sharedFixture: 'shared/src/lib/oauthCallbackBridge.test.ts',
    mobileAdapter: 'mobile/src/services/nativeOAuthHandoff.test.ts',
  },
  {
    milestone: 'M40',
    sharedFixture: 'shared/src/lib/chatClientState.test.ts',
    mobileAdapter: 'mobile/src/lib/chatMessageProjectionAdapter.test.ts',
  },
  {
    milestone: 'M50',
    sharedFixture: 'shared/src/lib/incomingShare.test.ts',
    mobileAdapter: 'mobile/src/platform/incomingShareCoordinator.test.ts',
  },
] as const;

function readJson(path: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('M60-01 P0 Shared/Mobile contract manifest', () => {
  it.each(P0_CONTRACTS)(
    '$milestone fixture and adapter remain discoverable',
    ({ sharedFixture, mobileAdapter }) => {
      for (const relativePath of [sharedFixture, mobileAdapter]) {
        expect(relativePath).toMatch(/\/src\/.*\.test\.tsx?$/u);
        expect(statSync(join(REPOSITORY_ROOT, relativePath)).isFile()).toBe(true);
      }
    },
  );

  it('full suite scripts and Vitest includes cannot narrow away manifest entries', () => {
    const rootPackage = readJson(join(REPOSITORY_ROOT, 'package.json'));
    const sharedPackage = readJson(join(REPOSITORY_ROOT, 'shared/package.json'));
    const mobilePackage = readJson(join(REPOSITORY_ROOT, 'mobile/package.json'));
    const sharedConfig = readFileSync(join(REPOSITORY_ROOT, 'shared/vitest.config.ts'), 'utf8');
    const mobileConfig = readFileSync(join(REPOSITORY_ROOT, 'mobile/vitest.config.ts'), 'utf8');

    expect(rootPackage.scripts?.test).toContain('--filter=mobile');
    expect(sharedPackage.scripts?.test).toBe('vitest run --passWithNoTests');
    expect(mobilePackage.scripts?.test).toMatch(/^vitest run && node --test /u);
    expect(sharedConfig).toContain("include: ['src/**/*.{test,spec}.ts']");
    expect(mobileConfig).toContain("include: ['src/**/*.{test,spec}.{ts,tsx}']");
    expect(rootPackage.scripts?.['mobile-contract']).toBe(
      'pnpm -F @agent/shared typecheck && pnpm -F @agent/shared test && pnpm -F mobile typecheck && pnpm -F mobile test && EXPO_OFFLINE=1 pnpm -F mobile exec expo install --check',
    );
  });
});
