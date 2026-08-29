import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const staged = execFileSync(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
  { cwd: root },
)
  .toString('utf8')
  .split('\0')
  .filter((path) => /\.[cm]?tsx?$/.test(path));

const packageFiles = new Map();
for (const path of staged) {
  const packageDir = path.split('/')[0];
  const packageJsonPath = join(root, packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) continue;
  const files = packageFiles.get(packageDir) ?? [];
  files.push(path);
  packageFiles.set(packageDir, files);
}

function run(args) {
  const result = spawnSync(pnpm, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const [packageDir, files] of [...packageFiles].sort(([a], [b]) => a.localeCompare(b))) {
  const packageJson = JSON.parse(readFileSync(join(root, packageDir, 'package.json'), 'utf8'));
  if (!packageJson.scripts?.typecheck) continue;

  if (packageDir !== 'server') {
    console.log(`[typecheck:staged] ${packageJson.name}: full package`);
    run(['-F', packageJson.name, 'run', 'typecheck']);
    continue;
  }

  const packageRoot = join(root, packageDir);
  const relativeFiles = files.map((path) =>
    relative(packageRoot, join(root, path)).split(sep).join('/'),
  );
  const declarationFiles = execFileSync('git', ['ls-files', '-z', `${packageDir}/src`], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter((path) => path.endsWith('.d.ts'))
    .map((path) => relative(packageRoot, join(root, path)).split(sep).join('/'));
  const serverGlobalTypeFiles = ['src/auth/types.ts'];
  const chunkSize = 4;
  for (let index = 0; index < relativeFiles.length; index += chunkSize) {
    const chunk = relativeFiles.slice(index, index + chunkSize);
    console.log(
      `[typecheck:staged] server: ${index + 1}-${index + chunk.length}/${relativeFiles.length}`,
    );
    run([
      '-F',
      'server',
      'exec',
      'tsc',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      '--esModuleInterop',
      '--strict',
      '--skipLibCheck',
      ...declarationFiles,
      ...serverGlobalTypeFiles,
      ...chunk,
    ]);
  }
}
