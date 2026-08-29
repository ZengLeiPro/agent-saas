import { execFileSync, spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

const root = process.cwd();
const normalize = (path) => relative(root, resolve(path)).split(sep).join('/');
const added = new Set(
  execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=A', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean),
);
const targets = process.argv
  .slice(2)
  .map(normalize)
  .filter((path) => added.has(path));

if (targets.length > 0) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(pnpm, ['exec', 'prettier', '--write', ...targets], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
