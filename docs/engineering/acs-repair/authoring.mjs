// Temporary branch-only editing aid. Removed before this PR is ready for review.
// It applies explicit text patches, never executes plan content or contacts a runtime.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const branch = 'acs-hang-rootfix-20260909';
const repo = 'ZengLeiPro/agent-saas';
if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_HEAD_REF !== branch) {
  throw new Error('Authoring is restricted to the explicitly authorized repair branch');
}
const planPath = 'docs/engineering/acs-repair/authoring-plan.json';
const markerPath = 'docs/engineering/acs-repair/authoring-applied.json';
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
if (!/^[a-f0-9]{40}$/.test(plan.baseSha) || !/^[a-z0-9-]{1,80}$/.test(plan.id)) throw new Error('Invalid plan identity');
const previous = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null;
if (previous?.id === plan.id) process.exit(0);
if (!Array.isArray(plan.files) || plan.files.length > 100) throw new Error('Invalid file set');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
git('merge-base', '--is-ancestor', plan.baseSha, 'HEAD');
const permitted = /^(acs-orchestrator\/|server\/|shared\/|scripts\/release\/|docs\/engineering\/acs-repair\/|Dockerfile$|package\.json$|scripts\/ci-plan\.mjs$)/;
const paths = new Set();
const updates = [];
for (const file of plan.files) {
  if (typeof file.path !== 'string' || !permitted.test(file.path) || file.path.split('/').includes('..')
    || /baseline|ratchet/i.test(file.path) || paths.has(file.path) || file.path.startsWith('-')) {
    throw new Error(`Forbidden/duplicate path: ${file.path}`);
  }
  paths.add(file.path);
  const old = existsSync(file.path) ? readFileSync(file.path, 'utf8') : '';
  if (git('diff', '--name-only', plan.baseSha, 'HEAD', '--', file.path)) throw new Error(`Concurrent change: ${file.path}`);
  let next = old;
  if (typeof file.content === 'string') {
    if (old && file.createOnly !== false) throw new Error(`Refusing implicit overwrite: ${file.path}`);
    next = file.content;
  } else {
    if (!Array.isArray(file.replacements) || file.replacements.length === 0) throw new Error(`No patch: ${file.path}`);
    for (const replacement of file.replacements) {
      const { before, after } = replacement;
      if (typeof before !== 'string' || before.length === 0 || typeof after !== 'string') throw new Error('Invalid replacement');
      const count = next.split(before).length - 1;
      if (count !== (replacement.count ?? 1)) throw new Error(`Anchor count ${count}: ${file.path}`);
      next = next.split(before).join(after);
    }
  }
  if (Buffer.byteLength(next) > 256 * 1024) throw new Error(`Oversized source: ${file.path}`);
  updates.push([file.path, next]);
}
for (const [path, content] of updates) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
writeFileSync(markerPath, `${JSON.stringify({ id: plan.id, baseSha: plan.baseSha, files: [...paths] }, null, 2)}\n`);
git('add', '--', ...paths, markerPath);
if (git('diff', '--cached', '--name-only')) {
  git('-c', 'user.name=ACS Repair Agent', '-c', 'user.email=noreply@openai.com', '-c', 'core.hooksPath=/dev/null',
    'commit', '-m', `fix(acs): apply reviewed repair batch ${plan.id}`);
}
console.log(`Authored exact source ${git('rev-parse', 'HEAD')}`);
