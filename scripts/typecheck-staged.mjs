import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // 走临时 tsconfig 而不是命令行开关：server 的 tsconfig 里有 paths（@agent/shared、
  // @kaiyan/ky-app-*），这些工作区包只在源码里存在（dist 不入库），命令行形态解析不到。
  // 覆盖 include 为空，保证仍然只编译本次暂存的文件。
  const stagedConfigPath = join(packageRoot, 'tsconfig.staged.json');
  try {
    for (let index = 0; index < relativeFiles.length; index += chunkSize) {
      const chunk = relativeFiles.slice(index, index + chunkSize);
      console.log(
        `[typecheck:staged] server: ${index + 1}-${index + chunk.length}/${relativeFiles.length}`,
      );
      writeFileSync(
        stagedConfigPath,
        `${JSON.stringify(
          {
            extends: './tsconfig.json',
            compilerOptions: { noEmit: true, incremental: false, tsBuildInfoFile: null },
            include: [],
            files: [...declarationFiles, ...serverGlobalTypeFiles, ...chunk],
          },
          null,
          2,
        )}\n`,
      );
      run(['-F', 'server', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.staged.json']);
    }
  } finally {
    rmSync(stagedConfigPath, { force: true });
  }
}
