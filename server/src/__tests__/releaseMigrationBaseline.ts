import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const RELEASE_MIGRATION_BASELINE = '9f8531e697e68f39d07e846872586dad841125ca';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);

// 直接编译真实生产 SHA 的源码和相对依赖，避免用手写的“旧版 SQL”冒充升级验证。
export async function loadReleaseMigrationBaseline<T>(entry: string): Promise<T> {
  const files = new Set(
    execFileSync('git', ['ls-tree', '-r', '--name-only', RELEASE_MIGRATION_BASELINE], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n'),
  );
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'release-migration-baseline',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === '@agent/shared')
              return { path: 'shared/src/index.ts', namespace: 'baseline' };
            if (args.path.startsWith('@agent/shared/'))
              return {
                path: `shared/src/${args.path.slice('@agent/shared/'.length)}.ts`,
                namespace: 'baseline',
              };
            if (args.kind !== 'entry-point' && !args.path.startsWith('.')) {
              return { path: args.path, external: true };
            }
            const requested =
              args.kind === 'entry-point'
                ? args.path
                : posix.normalize(posix.join(posix.dirname(args.importer), args.path));
            const path = [
              requested,
              requested.replace(/\.js$/u, '.ts'),
              `${requested}.ts`,
              `${requested}/index.ts`,
            ].find((candidate) => files.has(candidate));
            if (!path) throw new Error(`生产基线缺少依赖：${requested}`);
            return { path, namespace: 'baseline' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'baseline' }, (args) => ({
            contents: execFileSync('git', ['show', `${RELEASE_MIGRATION_BASELINE}:${args.path}`], {
              cwd: root,
              encoding: 'utf8',
            }),
            loader: args.path.endsWith('.json') ? 'json' : 'ts',
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    require,
    module,
    module.exports,
  );
  return module.exports as T;
}
