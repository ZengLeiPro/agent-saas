import { execFileSync } from 'node:child_process';
import { createMigrationPlan } from './migration-plan.mjs';
const resolve = (ref) =>
  execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const [baseRef, targetRef = 'HEAD'] = process.argv.slice(2);
if (!baseRef || baseRef.startsWith('-') || targetRef.startsWith('-'))
  throw new Error(
    'usage: node scripts/release/grok-migration-evidence.mjs <baseline-ref> [target-ref]',
  );
const baseline = resolve(baseRef);
const target = resolve(targetRef);
const plan = createMigrationPlan({ baseline, target });
console.log(JSON.stringify({ baseline, target, plan }, null, 2));
if (!plan.ok) process.exitCode = 1;
