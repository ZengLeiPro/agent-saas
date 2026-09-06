/** CLI 分发、`.env` 解析、平台命令参数与真实平台请求。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXAMPLE_MANIFEST } from '@kaiyan/ky-app-contract';

import { USAGE, main, parseDotEnv } from './cli.js';
import { loadProjectFiles } from './doctor/run.js';
import { resolveStartCommand } from './harness/appProcess.js';

const CONFORMANCE = {
  contractVersion: 1,
  users: {
    admin: { sub: 'test-admin', tadm: true },
    member: { sub: 'test-member', roles: ['sales'] },
    norole: { sub: 'test-norole' },
  },
  capabilities: {},
  endpoints: ['/'],
};

let dir = '';
let logs: string[] = [];
let errors: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ky-app-cli-'));
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function writeProject(): Promise<void> {
  await writeFile(join(dir, 'ky-app.manifest.json'), JSON.stringify(EXAMPLE_MANIFEST), 'utf8');
  await writeFile(join(dir, 'ky-app.conformance.json'), JSON.stringify(CONFORMANCE), 'utf8');
  await writeFile(
    join(dir, 'members.csv'),
    '姓名,手机号,部门路径\n测试员工,13800138000,总部',
    'utf8',
  );
}

function onboardArgs(baseUrl = 'https://demo.apps.kaiyancn.com'): string[] {
  return [
    'onboard',
    '--project',
    dir,
    '--tenant',
    't1',
    '--tenant-name',
    '测试组织',
    '--admin-name',
    '管理员',
    '--admin-phone',
    '13900139000',
    '--tech-contact-phone',
    '13900139000',
    '--system',
    'demo-erp',
    '--installation',
    'demo-erp-t1',
    '--base-url',
    baseUrl,
    '--members',
    join(dir, 'members.csv'),
  ];
}

describe('parseDotEnv', () => {
  it('忽略空行与注释，去掉引号', () => {
    expect(
      parseDotEnv(['# 注释', '', 'A=1', 'B="two"', "C='three'", 'D=has=equals', 'bad'].join('\n')),
    ).toEqual({ A: '1', B: 'two', C: 'three', D: 'has=equals' });
  });
});

describe('main', () => {
  it('无参数打印用法并返回 2', async () => {
    expect(await main([])).toBe(2);
    expect(logs.join('\n')).toContain('ky-app <命令>');
  });

  it('--help 返回 0', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(USAGE).toContain('doctor');
    expect(USAGE).toContain('mock-shell');
  });

  it('未知命令返回 2', async () => {
    expect(await main(['nope'])).toBe(2);
    expect(errors.join('\n')).toContain('未知命令');
  });

  it('register：manifest 校验后调用平台版本登记端点', async () => {
    await writeProject();
    vi.stubEnv('KY_PLATFORM_URL', 'https://agent.example.com');
    vi.stubEnv('KY_PLATFORM_TOKEN', 'test-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await main(['register', '--project', dir])).toBe(0);
    expect(logs.join('\n')).toContain('manifest 校验通过');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/api/app-contract/v1/systems/demo-erp/versions',
    );
  });

  it('onboard：缺必填参数直接报错', async () => {
    await writeProject();
    expect(await main(['onboard', '--project', dir, '--tenant', 't1'])).toBe(2);
    expect(errors.join('\n')).toContain('--system');
    expect(errors.join('\n')).toContain('--base-url');
  });

  it('onboard：参数齐全时校验 base-url 与 grant-credits', async () => {
    await writeProject();
    expect(await main(onboardArgs('ftp://x'))).toBe(2);
    expect(errors.join('\n')).toContain('--base-url 必须是 https');

    errors.length = 0;
    expect(await main([...onboardArgs(), '--grant-credits', 'many'])).toBe(2);
    expect(errors.join('\n')).toContain('--grant-credits 必须是非负整数');
  });

  it('rotate-credential：缺 --installation 直接报错', async () => {
    await writeProject();
    expect(await main(['rotate-credential', '--project', dir])).toBe(2);
    expect(errors.join('\n')).toContain('--installation');
  });
});

describe('loadProjectFiles', () => {
  it('读取并校验 manifest 与附录 J 夹具', async () => {
    await writeProject();
    const loaded = await loadProjectFiles(dir);
    expect(loaded.manifest.systemId).toBe('demo-erp');
    expect(loaded.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.conformance.users.admin.sub).toBe('test-admin');
  });

  it('manifest 不合附录 A 时给出清晰错误', async () => {
    await writeFile(
      join(dir, 'ky-app.manifest.json'),
      JSON.stringify({ contractVersion: 1 }),
      'utf8',
    );
    await writeFile(join(dir, 'ky-app.conformance.json'), JSON.stringify(CONFORMANCE), 'utf8');
    await expect(loadProjectFiles(dir)).rejects.toThrow('不合附录 A');
  });

  it('夹具不合附录 J 时给出清晰错误', async () => {
    await writeFile(join(dir, 'ky-app.manifest.json'), JSON.stringify(EXAMPLE_MANIFEST), 'utf8');
    await writeFile(
      join(dir, 'ky-app.conformance.json'),
      JSON.stringify({ contractVersion: 1 }),
      'utf8',
    );
    await expect(loadProjectFiles(dir)).rejects.toThrow('不合附录 J');
  });
});

describe('resolveStartCommand', () => {
  it('默认约定 pnpm start --port <port>', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
    expect(await resolveStartCommand(dir, 4321)).toEqual({
      command: 'pnpm',
      args: ['start', '--port', '4321'],
    });
  });

  it('package.json 的 ky.start 可覆盖，{{port}} 会被替换', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', ky: { start: ['node', 'server.js', '--port={{port}}'] } }),
      'utf8',
    );
    expect(await resolveStartCommand(dir, 5000)).toEqual({
      command: 'node',
      args: ['server.js', '--port=5000'],
    });
  });
});
