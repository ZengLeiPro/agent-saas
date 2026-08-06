import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio,
  });
}

export function normalizeRepoPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function isTestPath(value) {
  const file = normalizeRepoPath(value);
  return /(?:^|\/)(?:__tests__|tests?|test-fixtures|fixtures|__mocks__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/u.test(file);
}

export function listRepoFiles(root, roots, { staged = false } = {}) {
  const args = ['ls-files', '-z', '--cached'];
  if (!staged) args.push('--others', '--exclude-standard');
  args.push('--', ...roots);
  return git(root, args)
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter((file) => staged || fs.existsSync(path.join(root, file)));
}

export function readRepoFile(root, file, { staged = false } = {}) {
  if (staged) return git(root, ['show', `:${normalizeRepoPath(file)}`]);
  return fs.readFileSync(path.join(root, file), 'utf8');
}

export function resolveBase(root, requested) {
  const explicit = requested !== undefined;
  const ref = requested ?? 'origin/main';
  try {
    git(root, ['rev-parse', '--verify', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    return { ref, sha: git(root, ['merge-base', 'HEAD', ref]).trim() };
  } catch (error) {
    if (explicit) throw new Error(`Cannot resolve --base ${ref}`);
    return { ref: 'HEAD', sha: git(root, ['rev-parse', 'HEAD']).trim() };
  }
}

export function readFileAtCommit(root, commit, file) {
  try {
    git(root, ['cat-file', '-e', `${commit}:${file}`], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    return null;
  }
  return git(root, ['show', `${commit}:${file}`]);
}

export function findRenames(root, baseSha, roots, { staged = false } = {}) {
  const args = ['diff'];
  if (staged) args.push('--cached');
  args.push('--find-renames=50%', '--name-status', baseSha, '--', ...roots);
  const result = new Map();
  const output = git(root, args).trim();
  if (!output) return result;
  for (const line of output.split('\n')) {
    const [status, oldPath, newPath] = line.split('\t');
    if (status?.startsWith('R') && oldPath && newPath) {
      result.set(normalizeRepoPath(newPath), normalizeRepoPath(oldPath));
    }
  }
  return result;
}

export function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
