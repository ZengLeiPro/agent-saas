/** 生成器：占位替换、`_` 前缀改名、`--link` 三种写法、参数校验。 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateConformance, validateManifest } from '@kaiyan/ky-app-contract';

import {
  DEFAULT_KY_VERSION,
  KY_DEV_PACKAGES,
  KY_PACKAGES,
  createProject,
  renameTemplatePath,
  resolveLink,
  specifierFor,
  toIdentifier,
} from './generate.js';

let workDir = '';

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'create-ky-app-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function generate(link?: string): Promise<string> {
  const target = join(workDir, 'demo');
  await createProject({
    targetDir: target,
    systemId: 'demo-erp',
    name: '演示 ERP',
    ...(link === undefined ? {} : { link }),
  });
  return target;
}

describe('renameTemplatePath', () => {
  it('把 `_` 前缀的名字改回点号前缀', () => {
    expect(renameTemplatePath('_gitignore')).toBe('.gitignore');
    expect(renameTemplatePath('_npmrc')).toBe('.npmrc');
    expect(renameTemplatePath('_env.example')).toBe('.env.example');
    expect(renameTemplatePath('_github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    expect(renameTemplatePath('_husky/pre-commit')).toBe('.husky/pre-commit');
    expect(renameTemplatePath('server/app.ts')).toBe('server/app.ts');
  });
});

describe('toIdentifier', () => {
  it('短横线归一成下划线（与工具名规范化一致）', () => {
    expect(toIdentifier('demo-erp')).toBe('demo_erp');
  });
});

describe('createProject', () => {
  it('生成到临时目录，关键文件齐全', async () => {
    const target = await generate();
    const files = await Promise.all(
      [
        'package.json',
        '.gitignore',
        '.npmrc',
        '.env.example',
        '.github/workflows/ci.yml',
        '.husky/pre-commit',
        'CLAUDE.md',
        'README.md',
        'ky-app.manifest.json',
        'ky-app.conformance.json',
        'scripts/secret-scan.mjs',
        'skills/order-review/SKILL.md',
        'server/app.ts',
        'server/permissions.ts',
        'server/services/orders.service.ts',
        'server/migrations/002_demo.sql',
        'web/src/main.ts',
        'web/src/App.vue',
      ].map(async (file) => readFile(join(target, file), 'utf8')),
    );
    expect(files.every((text) => text.length > 0)).toBe(true);
  });

  it('占位符全部被替换，生成物里不留 `__XXX__`', async () => {
    const target = await generate();
    for (const file of ['README.md', 'server/index.ts', 'ky-app.manifest.json', 'web/index.html']) {
      const text = await readFile(join(target, file), 'utf8');
      expect(text).not.toMatch(/__[A-Z_]+__/u);
    }
    expect(await readFile(join(target, 'web/index.html'), 'utf8')).toContain('演示 ERP');
    const skill = await readFile(join(target, 'skills/order-review/SKILL.md'), 'utf8');
    expect(skill).toContain('app__demo_erp__order_search');
  });

  it('生成的 manifest 与夹具分别过附录 A / 附录 J', async () => {
    const target = await generate();
    const manifest: unknown = JSON.parse(
      await readFile(join(target, 'ky-app.manifest.json'), 'utf8'),
    );
    const conformance: unknown = JSON.parse(
      await readFile(join(target, 'ky-app.conformance.json'), 'utf8'),
    );
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
    expect(validateConformance(conformance).ok).toBe(true);
    expect((manifest as { systemId: string }).systemId).toBe('demo-erp');
  });

  it('CLAUDE.md 由 contract 生成，含 §9.2 范式', async () => {
    const target = await generate();
    const text = await readFile(join(target, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('# 演示 ERP（demo-erp）');
    expect(text).toContain('声明式权限表');
    expect(text).toContain('settings.roles');
  });

  it('不传 --link 时写默认版本号', async () => {
    const target = await generate();
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('demo-erp');
    for (const name of KY_PACKAGES) expect(pkg.dependencies[name]).toBe(DEFAULT_KY_VERSION);
    for (const name of KY_DEV_PACKAGES) expect(pkg.devDependencies[name]).toBe(DEFAULT_KY_VERSION);
  });

  it('--link 指向 tarball 目录时写 file:', async () => {
    const tarballs = join(workDir, 'tarballs');
    await mkdir(tarballs, { recursive: true });
    for (const name of [...KY_PACKAGES, ...KY_DEV_PACKAGES]) {
      await writeFile(join(tarballs, `${name.replace('@kaiyan/', 'kaiyan-')}-0.1.0.tgz`), 'x');
    }
    const target = await generate(tarballs);
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@kaiyan/ky-app-contract']).toBe(
      `file:${join(tarballs, 'kaiyan-ky-app-contract-0.1.0.tgz')}`,
    );
    expect(pkg.devDependencies['@kaiyan/ky-app-cli']).toContain('file:');
  });

  it('--link 指向 workspace 根时写 link:', async () => {
    const workspace = join(workDir, 'agent-saas');
    await mkdir(join(workspace, 'packages', 'ky-app-contract'), { recursive: true });
    await writeFile(join(workspace, 'packages', 'ky-app-contract', 'package.json'), '{}');
    const target = await generate(workspace);
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@kaiyan/ky-app-server']).toBe(
      `link:${join(workspace, 'packages', 'ky-app-server')}`,
    );
  });

  it('--link 目录既没有 tarball 也不是 workspace → 报错', async () => {
    const empty = join(workDir, 'empty');
    await mkdir(empty, { recursive: true });
    await expect(resolveLink(empty)).rejects.toThrow('既没有 *.tgz');
    await expect(resolveLink(join(workDir, 'not-there'))).rejects.toThrow('不存在');
  });

  it('tarball 目录缺某个包的 tarball → 报错', async () => {
    const partial = join(workDir, 'partial');
    await mkdir(partial, { recursive: true });
    await writeFile(join(partial, 'kaiyan-ky-app-contract-0.1.0.tgz'), 'x');
    await expect(resolveLink(partial)).rejects.toThrow('@kaiyan/ky-app-server');
  });

  it('specifierFor 覆盖三种写法', () => {
    expect(specifierFor({ kind: 'version', version: '^0.2.0' }, '@kaiyan/ky-app-contract')).toBe(
      '^0.2.0',
    );
    expect(
      specifierFor(
        { kind: 'tarball', dir: '/t', files: { '@kaiyan/ky-app-contract': '/t/a.tgz' } },
        '@kaiyan/ky-app-contract',
      ),
    ).toBe('file:/t/a.tgz');
    expect(specifierFor({ kind: 'workspace', root: '/w' }, '@kaiyan/ky-app-browser')).toBe(
      'link:/w/packages/ky-app-browser',
    );
  });

  it('systemId / name 非法时拒绝生成', async () => {
    await expect(
      createProject({ targetDir: join(workDir, 'x'), systemId: 'Bad_Id', name: 'x' }),
    ).rejects.toThrow('--system-id');
    await expect(
      createProject({ targetDir: join(workDir, 'y'), systemId: 'demo-erp', name: '  ' }),
    ).rejects.toThrow('--name');
  });
});
