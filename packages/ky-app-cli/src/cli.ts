/**
 * `ky-app` 命令分发。只用 `node:util.parseArgs`，不引 CLI 框架。
 *
 * - `doctor`：§9.3 十六章一致性测试（内置 mock 壳、PG 容器与双进程 harness）
 * - `mock-shell`：只起 mock 壳，供本地开发时在浏览器里看 iframe 里的项目
 * - `register` / `onboard` / `rotate-credential`：依赖 WP2a 平台端点，本期只校验参数
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ISSUER_BY_ENV } from '@kaiyan/ky-app-contract';

import { createMockShell } from './mockShell/server.js';
import { freePort } from './harness/ports.js';
import { defaultPgMode, loadProjectFiles, runDoctor } from './doctor/run.js';
import type { BrowserMode, PgMode } from './types.js';

export const USAGE = [
  'ky-app <命令> [选项]',
  '',
  '命令：',
  '  doctor              跑 §9.3 一致性测试（16 章）与 mock 壳',
  '  mock-shell          只起 mock 壳，本地开发时在浏览器里预览 iframe 内的项目',
  '  register            上传仓库 manifest 登记系统版本（依赖 WP2a 平台端点）',
  '  onboard             开箱：建组织、赠积分、注册安装、导入成员（依赖 WP2a 平台端点）',
  '  rotate-credential   轮换服务凭据（依赖 WP2a 平台端点）',
  '',
  'doctor 选项：',
  '  --project <dir>       定制项目目录（默认当前目录）',
  '  --database-url <url>  测试数据库（也可用环境变量 TEST_DATABASE_URL）',
  '  --pg docker|url|skip  数据库来源；默认：给了 URL 用 url，否则有 docker 用 docker',
  '  --browser auto|on|off 浏览器 harness；auto = 找得到 chromium 就跑（默认）',
  '  --report <path>       把结果写成 JSON',
  '  --shell-only          只起 mock 壳与被测项目，不跑测试',
  '',
  'mock-shell 选项：',
  '  --project <dir>       定制项目目录（读 manifest 与 .env，默认当前目录）',
  '  --app-url <url>       已在运行的项目地址（默认 http://127.0.0.1:8787）',
  '  --port <n>            mock 壳端口（默认随机高位端口）',
].join('\n');

const NOT_IMPLEMENTED_EXIT = 2;

function optionString(values: Record<string, unknown>, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

function parsePgMode(raw: string | undefined): PgMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'docker' || raw === 'url' || raw === 'skip') return raw;
  throw new Error(`--pg 只接受 docker|url|skip，收到 ${raw}`);
}

function parseBrowserMode(raw: string | undefined): BrowserMode {
  if (raw === undefined) return 'auto';
  if (raw === 'auto' || raw === 'on' || raw === 'off') return raw;
  throw new Error(`--browser 只接受 auto|on|off，收到 ${raw}`);
}

/** 极简 `.env` 解析：只取 `KEY=value`，不做变量展开。 */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function runDoctorCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      'database-url': { type: 'string' },
      pg: { type: 'string' },
      browser: { type: 'string' },
      report: { type: 'string' },
      'shell-only': { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const databaseUrl = optionString(values, 'database-url');
  const pg =
    parsePgMode(optionString(values, 'pg')) ??
    defaultPgMode({ ...(databaseUrl === undefined ? {} : { databaseUrl }) });
  const result = await runDoctor({
    projectDir: optionString(values, 'project') ?? process.cwd(),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    pg,
    browser: parseBrowserMode(optionString(values, 'browser')),
    ...(optionString(values, 'report') === undefined
      ? {}
      : { reportPath: optionString(values, 'report') as string }),
    ...(values['shell-only'] === true ? { shellOnly: true } : {}),
  });
  return result.allGreen ? 0 : 1;
}

async function runMockShellCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      'app-url': { type: 'string' },
      port: { type: 'string' },
    },
    allowPositionals: false,
  });

  const projectDir = resolve(optionString(values, 'project') ?? process.cwd());
  const { manifest, conformance, digest } = await loadProjectFiles(projectDir);
  const appUrl = optionString(values, 'app-url') ?? 'http://127.0.0.1:8787';
  const port = Number.parseInt(optionString(values, 'port') ?? '', 10);

  const dotenv = await readFile(resolve(projectDir, '.env'), 'utf8')
    .then(parseDotEnv)
    .catch(() => ({}) as Record<string, string>);
  const installationKeyHex = dotenv.KY_INSTALLATION_KEY ?? randomBytes(32).toString('hex');
  const serviceCredential =
    dotenv.KY_SERVICE_CREDENTIAL ?? `svc_${randomBytes(16).toString('hex')}`;
  const tenantId = dotenv.KY_TENANT_ID ?? 't_dev';
  const installationId = dotenv.KY_INSTALLATION_ID ?? 'tsi_dev';

  const shell = await createMockShell({
    port: Number.isInteger(port) ? port : await freePort(),
    appOrigin: new URL(appUrl).origin,
    systemName: manifest.name,
    app: {
      issuer: ISSUER_BY_ENV.test,
      systemId: manifest.systemId,
      tenantId,
      installationId,
      manifestDigest: digest,
      pathPrefixes: manifest.pathPrefixes,
    },
    installationKeyHex,
    installationKeyVersion: dotenv.KY_INSTALLATION_KEY_VERSION ?? 'v1',
    serviceCredential,
    externalLinkHosts: [...(manifest.externalLinkHosts ?? [])],
    user: { id: conformance.users.admin.sub, displayName: '本地管理员', isTenantAdmin: true },
  });

  console.log('mock 壳已启动。请让定制项目用下面这组配置运行（.env 或环境变量）：');
  console.log('');
  console.log(`KY_ENV=test`);
  console.log(`KY_SYSTEM_ID=${manifest.systemId}`);
  console.log(`KY_TENANT_ID=${tenantId}`);
  console.log(`KY_INSTALLATION_ID=${installationId}`);
  console.log(`KY_ORIGIN=${new URL(appUrl).origin}`);
  console.log(`KY_SERVICE_CREDENTIAL=${serviceCredential}`);
  console.log(`KY_INSTALLATION_KEY=${installationKeyHex}`);
  console.log(`KY_INSTALLATION_KEY_VERSION=${dotenv.KY_INSTALLATION_KEY_VERSION ?? 'v1'}`);
  console.log(`KY_JWKS_URL=${shell.jwksUrl}`);
  console.log(`KY_DIRECTORY_URL=${shell.directoryBaseUrl}`);
  console.log(`KY_SHELL_ORIGIN=${shell.origin}`);
  console.log('');
  console.log(`浏览器打开：${shell.shellUrl()}`);
  console.log('按 Ctrl+C 退出。');

  await new Promise<void>((done) => {
    process.once('SIGINT', () => {
      done();
    });
    process.once('SIGTERM', () => {
      done();
    });
  });
  await shell.close();
  return 0;
}

/** WP2a 才有平台端点，这里只做参数与 manifest 校验。 */
async function runPlatformCommand(command: string, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      tenant: { type: 'string' },
      system: { type: 'string' },
      'base-url': { type: 'string' },
      'grant-credits': { type: 'string' },
      installation: { type: 'string' },
    },
    allowPositionals: false,
  });

  const projectDir = resolve(optionString(values, 'project') ?? process.cwd());
  const required: Record<string, string[]> = {
    register: [],
    onboard: ['tenant', 'system', 'base-url'],
    'rotate-credential': ['installation'],
  };
  const missing = (required[command] ?? []).filter(
    (name) => optionString(values, name) === undefined,
  );
  if (missing.length > 0) {
    console.error(`${command} 缺少必填参数：${missing.map((name) => `--${name}`).join('、')}`);
    return NOT_IMPLEMENTED_EXIT;
  }

  const credits = optionString(values, 'grant-credits');
  if (credits !== undefined && !/^\d+$/u.test(credits)) {
    console.error('--grant-credits 必须是非负整数');
    return NOT_IMPLEMENTED_EXIT;
  }

  const baseUrl = optionString(values, 'base-url');
  if (baseUrl !== undefined) {
    try {
      const parsed = new URL(baseUrl);
      if (
        parsed.protocol !== 'https:' &&
        parsed.hostname !== '127.0.0.1' &&
        parsed.hostname !== 'localhost'
      ) {
        console.error('--base-url 必须是 https（本地调试可用 127.0.0.1 / localhost）');
        return NOT_IMPLEMENTED_EXIT;
      }
    } catch {
      console.error('--base-url 不是合法 URL');
      return NOT_IMPLEMENTED_EXIT;
    }
  }

  const { manifest, digest } = await loadProjectFiles(projectDir);
  console.log(`manifest 校验通过：${manifest.name}（${manifest.systemId}），digest ${digest}`);
  console.error(`ky-app ${command}：依赖 WP2a 平台端点，尚未实现。`);
  return NOT_IMPLEMENTED_EXIT;
}

/** 命令入口。返回进程退出码。 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      console.log(USAGE);
      return command === undefined ? NOT_IMPLEMENTED_EXIT : 0;
    case 'doctor':
      return runDoctorCommand(rest);
    case 'mock-shell':
      return runMockShellCommand(rest);
    case 'register':
    case 'onboard':
    case 'rotate-credential':
      return runPlatformCommand(command, rest);
    default:
      console.error(`未知命令：${command}`);
      console.log(USAGE);
      return NOT_IMPLEMENTED_EXIT;
  }
}
