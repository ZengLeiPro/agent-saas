import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const serverSrc = join(process.cwd(), 'src');

async function materializationFiles(): Promise<string[]> {
  const root = join(serverSrc, 'workspace', 'materialization');
  return (await readdir(root))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(root, name));
}

describe('技能物化阻塞 I/O 静态门禁', () => {
  it('请求、运行前置、Cron 与物化 worker 不得重新引入同步重型文件操作', async () => {
    const files = [
      join(serverSrc, 'routes', 'skills.ts'),
      join(serverSrc, 'runtime', 'rawRuntimeRunDispatch.ts'),
      join(serverSrc, 'cron', 'executor.ts'),
      ...await materializationFiles(),
    ];
    const banned = /\b(?:execFileSync|spawnSync|cpSync|rmSync|renameSync|mkdirSync|readdirSync|readFileSync|writeFileSync|statSync|lstatSync|chmodSync|chownSync)\b/;

    for (const path of files) {
      const source = await readFile(path, 'utf-8');
      expect(source, path).not.toMatch(banned);
    }
  });

  it('生产调度入口不得重新调用旧 syncSkills', async () => {
    const files = [
      join(serverSrc, 'app', 'runtime.ts'),
      join(serverSrc, 'engine', 'dispatch.ts'),
      join(serverSrc, 'runtime', 'rawRuntimeRunDispatch.ts'),
      join(serverSrc, 'cron', 'executor.ts'),
      join(serverSrc, 'routes', 'skills.ts'),
    ];
    for (const path of files) {
      const source = await readFile(path, 'utf-8');
      expect(source, path).not.toMatch(/\bsyncSkills\s*\(/);
    }
  });

  it('workspace 热路径不得恢复递归复制、物理删除、同步子进程或深度权限遍历', async () => {
    const path = join(serverSrc, 'workspace', 'resolver.ts');
    const source = await readFile(path, 'utf-8');
    expect(source, path).not.toMatch(
      /\b(?:cpSync|rmSync|execSync|repairWorkspaceTree)\b/,
    );
  });
});
