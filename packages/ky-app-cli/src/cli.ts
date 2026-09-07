/**
 * `ky-app` 命令分发。只用 `node:util.parseArgs`，不引 CLI 框架。
 *
 * - `doctor`：§9.3 十六章一致性测试（内置 mock 壳、PG 容器与双进程 harness）
 * - `mock-shell`：只起 mock 壳，供本地开发时在浏览器里看 iframe 里的项目
 * - `register` / `onboard --resume` / `rotate-credential`：调用平台 WP5 交付端点
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
import { parseOnboardMembersCsv } from './onboard/csv.js';
import { platformRequest } from './onboard/platformClient.js';
import { installManifestSkills } from './onboard/skills.js';

export const USAGE = [
  'ky-app <命令> [选项]',
  '',
  '命令：',
  '  doctor              跑 §9.3 一致性测试（16 章）与 mock 壳',
  '  mock-shell          只起 mock 壳，本地开发时在浏览器里预览 iframe 内的项目',
  '  register            上传仓库 manifest 登记系统版本',
  '  onboard             可恢复开箱：组织、积分、安装、成员与交付清单',
  '  rotate-credential   签发新的服务凭据领取票据',
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
  '',
  '平台命令环境变量：',
  '  KY_PLATFORM_URL       平台地址（也可用 --platform-url）',
  '  KY_PLATFORM_TOKEN     平台管理员令牌；禁止放进命令行参数',
  '',
  'onboard 关键选项：',
  '  --tenant/--tenant-name       组织 ID / 名称',
  '  --admin-name/--admin-phone   首个组织管理员',
  '  --tech-contact-phone         一次性领取凭据的技术联系人',
  '  --installation/--base-url    安装实例 ID / 客户系统地址',
  '  --members <csv>               姓名、手机号、部门路径、可选工号',
  '  --grant-credits <n>           赠送积分（默认 2000）',
  '  --resume                      按同一参数恢复既有交付执行',
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
      'platform-url': { type: 'string' },
      'tenant-name': { type: 'string' },
      'admin-name': { type: 'string' },
      'admin-phone': { type: 'string' },
      'tech-contact-phone': { type: 'string' },
      members: { type: 'string' },
      resume: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const projectDir = resolve(optionString(values, 'project') ?? process.cwd());
  const required: Record<string, string[]> = {
    register: [],
    onboard: [
      'tenant',
      'tenant-name',
      'admin-name',
      'admin-phone',
      'tech-contact-phone',
      'system',
      'installation',
      'base-url',
      'members',
    ],
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

  const platformUrl = optionString(values, 'platform-url') ?? process.env.KY_PLATFORM_URL;
  const platformToken = process.env.KY_PLATFORM_TOKEN;
  if (!platformUrl || !platformToken) {
    console.error('平台命令需要 KY_PLATFORM_URL（或 --platform-url）与 KY_PLATFORM_TOKEN');
    return NOT_IMPLEMENTED_EXIT;
  }

  try {
    if (command === 'rotate-credential') {
      const installationId = optionString(values, 'installation')!;
      const response = await platformRequest<{
        credential: {
          credentialId: string;
          ticket: string;
          ticketExpiresAt: string;
          ackDeadlineAt: string;
          expiresAt: string;
        };
      }>({
        baseUrl: platformUrl,
        token: platformToken,
        path: `/api/app-contract/v1/installations/${encodeURIComponent(installationId)}/credentials`,
        method: 'POST',
        body: {},
      });
      console.log(
        `已签发凭据 ${response.credential.credentialId}；确认截止 ${response.credential.ackDeadlineAt}`,
      );
      console.log(
        `一次性领取地址：/api/app-contract/v1/installations/${installationId}/credentials/claim/${response.credential.ticket}`,
      );
      return 0;
    }

    const { manifest, conformance, digest } = await loadProjectFiles(projectDir);
    console.log(`manifest 校验通过：${manifest.name}（${manifest.systemId}），digest ${digest}`);
    if (command === 'register') {
      await platformRequest({
        baseUrl: platformUrl,
        token: platformToken,
        path: `/api/app-contract/v1/systems/${encodeURIComponent(manifest.systemId)}/versions`,
        method: 'POST',
        body: { name: manifest.name, manifest },
      });
      console.log(`系统版本已登记：${manifest.systemId}@${digest}`);
      return 0;
    }

    const memberPath = resolve(optionString(values, 'members')!);
    const members = parseOnboardMembersCsv(await readFile(memberPath, 'utf8'));
    const readOnly = manifest.capabilities.find((item) => item.riskLevel === 'read_only');
    const readOnlyInput = readOnly
      ? conformance.capabilities[readOnly.id]?.validInputs[0]?.input
      : undefined;
    if (!readOnly || !readOnlyInput) {
      console.error('onboard 需要至少一个 read_only 能力及其第一组 validInputs，用于真实交付诊断');
      return NOT_IMPLEMENTED_EXIT;
    }
    const baseUrlValue = optionString(values, 'base-url')!;
    let response = await platformRequest<{
      execution: {
        executionId: string;
        status: string;
        currentStep: string;
        lastErrorCode?: string | null;
      };
      claim?: {
        path: string;
        credentialId: string;
        ticketExpiresAt: string;
        ackDeadlineAt: string;
      };
    }>({
      baseUrl: platformUrl,
      token: platformToken,
      path: '/api/app-contract/v1/onboard',
      method: 'POST',
      body: {
        tenantId: optionString(values, 'tenant'),
        tenantName: optionString(values, 'tenant-name'),
        adminName: optionString(values, 'admin-name'),
        adminPhone: optionString(values, 'admin-phone'),
        techContactPhone: optionString(values, 'tech-contact-phone'),
        systemId: optionString(values, 'system'),
        installationId: optionString(values, 'installation'),
        baseUrl: baseUrlValue,
        origin: new URL(baseUrlValue).origin,
        grantCredits: Number.parseInt(credits ?? '2000', 10),
        manifest,
        members,
        diagnostic: { readOnlyCapabilityId: readOnly.id, readOnlyInput },
      },
    });
    const skills = await installManifestSkills({
      baseUrl: platformUrl,
      token: platformToken,
      tenantId: optionString(values, 'tenant')!,
      projectDir,
      manifest,
    });
    if (skills.installed.length > 0 || skills.existing.length > 0) {
      console.log(
        `租户技能：新装 ${skills.installed.length} 个，已有 ${skills.existing.length} 个`,
      );
      response = await platformRequest({
        baseUrl: platformUrl,
        token: platformToken,
        path: '/api/app-contract/v1/onboard',
        method: 'POST',
        body: {
          tenantId: optionString(values, 'tenant'),
          tenantName: optionString(values, 'tenant-name'),
          adminName: optionString(values, 'admin-name'),
          adminPhone: optionString(values, 'admin-phone'),
          techContactPhone: optionString(values, 'tech-contact-phone'),
          systemId: optionString(values, 'system'),
          installationId: optionString(values, 'installation'),
          baseUrl: baseUrlValue,
          origin: new URL(baseUrlValue).origin,
          grantCredits: Number.parseInt(credits ?? '2000', 10),
          manifest,
          members,
          diagnostic: { readOnlyCapabilityId: readOnly.id, readOnlyInput },
        },
      });
    }
    console.log(
      `${values.resume === true ? '恢复' : '启动'}交付执行 ${response.execution.executionId}：${response.execution.status} / ${response.execution.currentStep}`,
    );
    if (response.claim) {
      console.log(
        `凭据 ${response.claim.credentialId} 等待技术联系人领取并确认（截止 ${response.claim.ackDeadlineAt}）`,
      );
      console.log(`一次性领取地址：${response.claim.path}`);
    } else if (response.execution.status !== 'completed') {
      console.log(
        `当前等待：${response.execution.lastErrorCode ?? response.execution.currentStep}；外部条件完成后用同一参数加 --resume`,
      );
    }
    return response.execution.status === 'failed' ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
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
