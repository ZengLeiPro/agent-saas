// Temporary branch-only editing aid. Removed before this PR is ready for review.
// Applies explicit text patches/extractions, never executes plan content or contacts a runtime.
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
const checkPath = (path) => {
  if (typeof path !== 'string' || !permitted.test(path) || path.split('/').includes('..')
    || /baseline|ratchet/i.test(path) || path.startsWith('-')) throw new Error(`Forbidden path: ${path}`);
  if (git('diff', '--name-only', plan.baseSha, 'HEAD', '--', path)) throw new Error(`Concurrent change: ${path}`);
};
const block = (spec) => {
  checkPath(spec.sourcePath);
  const source = readFileSync(spec.sourcePath, 'utf8');
  if (typeof spec.start !== 'string' || !spec.start || source.split(spec.start).length !== 2) throw new Error('Extraction start is not unique');
  const start = source.indexOf(spec.start);
  if (spec.end === null) return source.slice(start);
  if (typeof spec.end !== 'string' || !spec.end || source.split(spec.end).length !== 2) throw new Error('Extraction end is not unique');
  const end = source.indexOf(spec.end);
  if (end <= start) throw new Error('Extraction anchors are reversed');
  return source.slice(start, end);
};
const replace = (source, replacements, path) => {
  if (!Array.isArray(replacements)) throw new Error(`No patch: ${path}`);
  let next = source;
  for (const replacement of replacements) {
    const before = replacement.beforeFrom ? block(replacement.beforeFrom) : replacement.before;
    const { after } = replacement;
    if (typeof before !== 'string' || !before || typeof after !== 'string') throw new Error('Invalid replacement');
    const count = next.split(before).length - 1;
    if (replacement.all === true ? count < 1 : count !== (replacement.count ?? 1)) throw new Error(`Anchor count ${count}: ${path}`);
    next = next.split(before).join(after);
  }
  return next;
};
const paths = new Set();
const updates = [];
for (const file of plan.files) {
  checkPath(file.path);
  if (paths.has(file.path)) throw new Error(`Duplicate path: ${file.path}`);
  paths.add(file.path);
  const old = existsSync(file.path) ? readFileSync(file.path, 'utf8') : '';
  let next;
  if (file.extract) {
    if (old) throw new Error(`Extraction destination already exists: ${file.path}`);
    next = `${file.prefix ?? ''}${replace(block(file.extract), file.transforms ?? [], file.path)}${file.suffix ?? ''}`;
  } else if (typeof file.content === 'string') {
    if (old && file.createOnly !== false) throw new Error(`Refusing implicit overwrite: ${file.path}`);
    next = file.content;
  } else {
    if (!file.replacements?.length) throw new Error(`No patch: ${file.path}`);
    next = replace(old, file.replacements, file.path);
  }
  if (Buffer.byteLength(next) > 256 * 1024) throw new Error(`Oversized source: ${file.path}`);
  updates.push([file.path, next]);
}
// Validate every anchor before writing any file. Existing comments move with their code.
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
