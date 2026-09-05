import { execFileSync } from 'node:child_process';
import { createMigrationPlan } from './migration-plan.mjs';
import { MIGRATION_REVIEWS_PATH } from './migration-reviews.mjs';

// CI 使用提交里的真实两端对象，不读取未提交文件，也不接触生产数据库。
const target = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const document = JSON.parse(
  execFileSync('git', ['show', `${target}:${MIGRATION_REVIEWS_PATH}`], { encoding: 'utf8' }),
);
if (document.schemaVersion !== 1 || !Array.isArray(document.reviews))
  throw new Error('Invalid migration review inventory');
for (const review of document.reviews) {
  const changedPaths = execFileSync('git', ['diff', '--name-only', review.baselineSha, target], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const result = createMigrationPlan({ baseline: review.baselineSha, target, changedPaths });
  process.stdout.write(`${JSON.stringify({ baseline: review.baselineSha, target, ...result })}\n`);
  if (!result.ok) process.exitCode = 1;
}
