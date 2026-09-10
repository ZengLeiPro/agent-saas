import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createMigrationAnalysisContext, createMigrationPlan } from './migration-plan.mjs';
import { MIGRATION_REVIEWS_PATH } from './migration-reviews.mjs';

const GIT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

// CI 使用提交里的真实两端对象，不读取未提交文件，也不接触生产数据库。
const target = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const document = JSON.parse(
  execFileSync('git', ['show', `${target}:${MIGRATION_REVIEWS_PATH}`], {
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  }),
);
if (document.schemaVersion !== 1 || !Array.isArray(document.reviews))
  throw new Error('Invalid migration review inventory');
const analysisContext = createMigrationAnalysisContext();
const started = performance.now();
for (const review of document.reviews) {
  const changedPaths = execFileSync('git', ['diff', '--name-only', review.baselineSha, target], {
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const baselineStarted = performance.now();
  const result = createMigrationPlan({
    baseline: review.baselineSha,
    target,
    changedPaths,
    analysisContext,
  });
  // This inventory spans historical baselines, not the selected deployment baseline.
  // Keep source/DDL review errors blocking; lack of checks still leaves result.ok=false
  // and is mandatory at actual RC construction and again before any deployment.
  const classificationFailures = result.blockingReasons.filter(
    (reason) => !result.postconditionBlockingReasons?.includes(reason),
  );
  process.stdout.write(
    `${JSON.stringify({ mode: 'historical-source-classification', baseline: review.baselineSha, target, ...result })}\n`,
  );
  if (classificationFailures.length) process.exitCode = 1;
  process.stderr.write(
    `migration review ${review.baselineSha}: ${Math.round(performance.now() - baselineStarted)}ms\n`,
  );
}
const statistics = {
  baselines: document.reviews.length,
  elapsedMs: Math.round(performance.now() - started),
  ...analysisContext.statistics(),
};
process.stderr.write(`migration analysis: ${JSON.stringify(statistics)}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### Historical migration analysis\n\n\`\`\`json\n${JSON.stringify(statistics, null, 2)}\n\`\`\`\n`,
  );
