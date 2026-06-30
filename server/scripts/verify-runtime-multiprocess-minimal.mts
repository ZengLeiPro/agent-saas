#!/usr/bin/env tsx
import { runScenario } from './verify-runtime-multiprocess-e2e.mts';

void runScenario('minimal').catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
