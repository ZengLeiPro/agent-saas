import { describe, expect, it } from 'vitest';

import { commandNeedsNodeDependencies } from './snapshotDependencyCache.js';

describe('snapshot dependency command classification', () => {
  it.each([
    'rg -n snapshotCwd server acs-orchestrator',
    'git status --short',
    'find . -maxdepth 2 -type f',
    'ssh host uname -a',
    'du -sh .',
    'pnpm install --frozen-lockfile',
    'npm ci',
  ])('does not prepare node_modules for %s', (command) => {
    expect(commandNeedsNodeDependencies(command)).toBe(false);
  });

  it.each([
    'pnpm test',
    'pnpm -C server typecheck',
    'pnpm --filter web build',
    'pnpm exec vitest run',
    'npm run lint',
    'npm test',
    'npx eslint .',
    'vitest run',
    'NODE_ENV=test vitest run',
    'tsx scripts/check.ts',
  ])('prepares node_modules for %s', (command) => {
    expect(commandNeedsNodeDependencies(command)).toBe(true);
  });
});
