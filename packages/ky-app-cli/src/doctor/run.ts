/**
 * `ky-app doctor` 的编排：准备（manifest / 夹具 / PG / mock 壳 / 双进程）→ 跑 §9.3 十六章 → 汇总。
 *
 * 执行顺序与报告顺序不同：`installation.deleted` 是吸收终态，所以第 13 章排在最后跑。
 */
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  ISSUER_BY_ENV,
  manifestDigest,
  validateConformance,
  validateManifest,
  type ConformanceFixture,
  type Manifest,
} from '@kaiyan/ky-app-contract';

import { startApp, type AppInstance } from '../harness/appProcess.js';
import { dockerAvailable, startDockerPostgres, usePgUrl, type PgHandle } from '../harness/pg.js';
import { freePorts } from '../harness/ports.js';
import { Reporter } from '../harness/report.js';
import { createMockShell, type MockShell } from '../mockShell/server.js';
import { CHAPTERS, type DoctorOptions, type DoctorReport } from '../types.js';
import { DoctorContext, type DoctorEnv } from './context.js';
import { chapter01 } from './ch01Manifest.js';
import { chapter02 } from './ch02Sat.js';
import { chapter03 } from './ch03Endpoints.js';
import { chapter04 } from './ch04Jti.js';
import { chapter05 } from './ch05ReadOnly.js';
import { chapter06 } from './ch06ExternalWrite.js';
import { chapter07 } from './ch07Equivalence.js';
import { chapter08 } from './ch08Permissions.js';
import { chapter09 } from './ch09Headers.js';
import { chapter11 } from './ch11BreakGlass.js';
import { chapter12 } from './ch12Directory.js';
import { chapter13 } from './ch13Events.js';
import { chapter14 } from './ch14SecretScan.js';
import { runBrowserChapters } from './browser.js';
import { fixtureUsers } from './fixtures.js';

export const MANIFEST_FILE = 'ky-app.manifest.json';
export const CONFORMANCE_FILE = 'ky-app.conformance.json';

export interface DoctorRunResult {
  report: DoctorReport;
  allGreen: boolean;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** 读取并校验 manifest 与附录 J 夹具。 */
export async function loadProjectFiles(projectDir: string): Promise<{
  manifest: Manifest;
  conformance: ConformanceFixture;
  digest: string;
}> {
  const manifest = (await readJson(resolve(projectDir, MANIFEST_FILE))) as Manifest;
  const manifestCheck = validateManifest(manifest);
  if (!manifestCheck.ok) {
    throw new Error(`${MANIFEST_FILE} 不合附录 A：${manifestCheck.errors.join('；')}`);
  }
  const conformance = (await readJson(resolve(projectDir, CONFORMANCE_FILE))) as ConformanceFixture;
  const conformanceCheck = validateConformance(conformance);
  if (!conformanceCheck.ok) {
    throw new Error(`${CONFORMANCE_FILE} 不合附录 J：${conformanceCheck.errors.join('；')}`);
  }
  return { manifest, conformance, digest: manifestDigest(manifest) };
}

/** 按 `--pg` 与环境变量决定数据库来源。 */
export async function resolveDatabase(
  options: DoctorOptions,
  log: (line: string) => void,
): Promise<{ pg: PgHandle | null; source: string }> {
  const explicit = options.databaseUrl ?? process.env.TEST_DATABASE_URL;
  if (options.pg === 'skip') return { pg: null, source: 'skip' };
  if (options.pg === 'url') {
    if (explicit === undefined || explicit === '') {
      throw new Error('--pg url 需要 --database-url 或环境变量 TEST_DATABASE_URL');
    }
    return { pg: usePgUrl(explicit, { log }), source: '外部提供的 DATABASE_URL' };
  }
  return {
    pg: await startDockerPostgres({ log }),
    source: 'docker（postgres:16-alpine，随机高位端口）',
  };
}

/** 决定默认的 PG 模式：给了 URL 就用 URL，否则有 docker 就 docker。 */
export function defaultPgMode(options: { databaseUrl?: string }): 'docker' | 'url' | 'skip' {
  if ((options.databaseUrl ?? process.env.TEST_DATABASE_URL ?? '') !== '') return 'url';
  return dockerAvailable() ? 'docker' : 'skip';
}

function buildEnv(input: {
  shell: MockShell;
  systemId: string;
  tenantId: string;
  installationId: string;
  installationKeyHex: string;
  serviceCredential: string;
  databaseUrl: string;
  port: number;
}): DoctorEnv {
  return {
    KY_ENV: 'test',
    KY_SYSTEM_ID: input.systemId,
    KY_TENANT_ID: input.tenantId,
    KY_INSTALLATION_ID: input.installationId,
    KY_ORIGIN: `http://127.0.0.1:${String(input.port)}`,
    KY_SERVICE_CREDENTIAL: input.serviceCredential,
    KY_INSTALLATION_KEY: input.installationKeyHex,
    KY_INSTALLATION_KEY_VERSION: 'v1',
    KY_JWKS_URL: input.shell.jwksUrl,
    KY_LOCAL_LOGIN_ENABLED: 'true',
    KY_SHELL_ORIGIN: input.shell.origin,
    KY_DIRECTORY_URL: input.shell.directoryBaseUrl,
    DATABASE_URL: input.databaseUrl,
    PORT: String(input.port),
  };
}

/** `--pg skip` 时把 16 章全部记成 SKIP。 */
function reportAllSkipped(reporter: Reporter, reason: string): void {
  for (const chapter of CHAPTERS) {
    reporter.section(chapter.no);
    reporter.record(chapter.title, 'skip', reason);
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorRunResult> {
  const log = (line: string): void => {
    console.log(line);
  };
  const reporter = new Reporter();
  const projectDir = resolve(options.projectDir);
  const { manifest, conformance, digest } = await loadProjectFiles(projectDir);

  log(`项目：${projectDir}`);
  log(`系统：${manifest.name}（${manifest.systemId}）  manifest digest：${digest}`);

  const { pg, source } = await resolveDatabase(options, log);
  if (pg === null) {
    reportAllSkipped(reporter, 'PostgreSQL 不可用（--pg skip 或本机没有 docker）');
    const allGreen = reporter.printSummary();
    return {
      report: buildReport({ projectDir, manifest, digest, options, source, reporter, allGreen }),
      allGreen,
    };
  }

  const [shellPort, appPort, secondPort] = await freePorts(3);
  const installationKeyHex = randomBytes(32).toString('hex');
  const serviceCredential = `svc_${randomBytes(16).toString('hex')}`;
  const tenantId = 't_doctor';
  const installationId = 'tsi_doctor';
  const users = { admin: conformance.users.admin };

  const shell = await createMockShell({
    port: shellPort,
    appOrigin: `http://127.0.0.1:${String(appPort)}`,
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
    installationKeyVersion: 'v1',
    serviceCredential,
    externalLinkHosts: [...(manifest.externalLinkHosts ?? [])],
    user: { id: users.admin.sub, displayName: '演示管理员', isTenantAdmin: true },
  });
  log(`mock 壳：${shell.origin}（壳页面 ${shell.shellUrl()}）`);

  const env = buildEnv({
    shell,
    systemId: manifest.systemId,
    tenantId,
    installationId,
    installationKeyHex,
    serviceCredential,
    databaseUrl: pg.url,
    port: appPort,
  });

  let app: AppInstance | null = null;
  let secondApp: AppInstance | null = null;
  try {
    // C-fix-01：两个 worker 都等同一个数据库就绪信号（`pg.ready()` 记忆化，只真正探测一次），
    // 不各自猜，也不靠容器内的 pg_isready。
    await pg.ready();
    app = await startApp({ projectDir, port: appPort, env, log });
    await pg.ready();
    secondApp = await startApp({
      projectDir,
      port: secondPort,
      env: {
        ...env,
        KY_ORIGIN: `http://127.0.0.1:${String(secondPort)}`,
        PORT: String(secondPort),
      },
      log,
    });

    if (options.shellOnly === true) {
      log('');
      log(`mock 壳已就绪：${shell.shellUrl()}`);
      log('按 Ctrl+C 退出。');
      await new Promise<void>((resolve_) => {
        process.once('SIGINT', () => {
          resolve_();
        });
        process.once('SIGTERM', () => {
          resolve_();
        });
      });
      const allGreen = false;
      return {
        report: buildReport({ projectDir, manifest, digest, options, source, reporter, allGreen }),
        allGreen,
      };
    }

    const ctx = new DoctorContext({
      projectDir,
      manifest,
      manifestDigest: digest,
      conformance,
      shell,
      app,
      secondApp,
      pg,
      reporter,
      browserMode: options.browser,
      env,
      appPort,
      log,
    });

    // 目录先同步一轮，让后续章节的陈旧度门禁不至于一上来就 fail-closed。
    await seedDirectory(ctx);

    await chapter01(ctx);
    await chapter02(ctx);
    await chapter03(ctx);
    await chapter04(ctx);
    await chapter05(ctx);
    await chapter06(ctx);
    await chapter07(ctx);
    await chapter08(ctx);
    await chapter09(ctx);
    await chapter11(ctx);
    await chapter12(ctx);
    await chapter14(ctx);
    await runBrowserChapters(ctx);
    // 第 13 章最后跑：installation.deleted 之后实例不再接受业务请求。
    await chapter13(ctx);

    app = ctx.app;
  } finally {
    await secondApp?.stop();
    await app?.stop();
    await shell.close();
    await pg.stop();
  }

  const allGreen = reporter.printSummary();
  const report = buildReport({ projectDir, manifest, digest, options, source, reporter, allGreen });
  if (options.reportPath !== undefined) {
    const target = resolve(options.reportPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`报告已写入 ${target}`);
  }
  return { report, allGreen };
}

/** 目录初始种子：把夹具里的三个测试用户投进 mock 目录并同步一次。 */
async function seedDirectory(ctx: DoctorContext): Promise<void> {
  const users = fixtureUsers(ctx);
  ctx.shell.directory.setSnapshot({
    snapshotSeq: 1,
    groups: [{ groupId: 'g-root', displayName: '总部', parentGroupId: null, status: 'active' }],
    users: [users.admin, users.member, users.norole].map((user) => ({
      userId: user.sub,
      displayName: user.sub,
      status: 'active' as const,
      isTenantAdmin: user.tadm,
      groupIds: ['g-root'],
    })),
  });
  await ctx.testHook('directory', { action: 'sync' });
  await ctx.testHook('directory', { action: 'ack' });
}

function buildReport(input: {
  projectDir: string;
  manifest: Manifest;
  digest: string;
  options: DoctorOptions;
  source: string;
  reporter: Reporter;
  allGreen: boolean;
}): DoctorReport {
  return {
    contractVersion: 1,
    at: new Date().toISOString(),
    projectDir: input.projectDir,
    systemId: input.manifest.systemId,
    manifestDigest: input.digest,
    options: {
      pg: input.options.pg,
      browser: input.options.browser,
      databaseUrlSource: input.source,
    },
    allGreen: input.allGreen,
    totals: input.reporter.totals(),
    chapters: input.reporter.summarize(),
    checks: input.reporter.checks,
    warnings: input.reporter.warnings,
  };
}
