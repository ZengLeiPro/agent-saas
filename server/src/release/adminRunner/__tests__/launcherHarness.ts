/**
 * launcher.*.test.ts 共用的假 release 布局与注入依赖。
 * 只在测试中使用（__tests__ 目录不进覆盖率与生产行数棘轮）。
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect } from 'vitest';

import {
  LAUNCH_NONCE_ENV,
  RECEIPT_DIR_ENV,
  type LauncherDeps,
  type SpawnOptions,
  type SpawnedProcess,
} from '../launcher.js';
import type { CommandGovernance } from '../manifest.js';
import type { AdminRunnerReceipt } from '../receipt.js';

export const SHA = 'f'.repeat(40);
export const CONTRACT_DIGEST = `sha256:${'1'.repeat(64)}`;
export const DEPENDENCY_DIGEST = `sha256:${'2'.repeat(64)}`;
export const CONFIG_DIGEST = `sha256:${'3'.repeat(64)}`;
export const OTHER_CONFIG_DIGEST = `sha256:${'4'.repeat(64)}`;
export const SERVER_DIGEST = `sha256:${'5'.repeat(64)}`;

export const demoGovernance: CommandGovernance = {
  riskLevel: 'high',
  defaultMode: 'dry_run',
  writeIntents: [{ flag: '--execute', riskLevel: 'high', description: 'write' }],
  escalationFlags: [
    { flag: '--force', requiresWriteIntent: '--execute', riskLevel: 'critical', description: 'x' },
  ],
  acceptsAuthorizationRef: false,
  idempotency: 'resumable',
  configRequirements: ['pg_connection'],
  supportedEnvironments: ['production', 'staging', 'development', 'test'],
  requiredFlags: [],
};

export const refGovernance: CommandGovernance = {
  ...demoGovernance,
  riskLevel: 'critical',
  defaultMode: 'read_only',
  writeIntents: [{ flag: '--execute-retention', riskLevel: 'critical', description: 'delete' }],
  escalationFlags: [],
  acceptsAuthorizationRef: true,
};

export const stagingOnlyGovernance: CommandGovernance = {
  ...demoGovernance,
  escalationFlags: [],
  supportedEnvironments: ['staging'],
};

export const outputGovernance: CommandGovernance = {
  ...demoGovernance,
  escalationFlags: [],
  writeIntents: [{ flag: '--apply', riskLevel: 'high', description: 'apply' }],
  requiredFlags: ['--output'],
};

export function digestOf(body: string) {
  return {
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    size: Buffer.byteLength(body),
  };
}

export class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = 4242;
  killedWith?: NodeJS.Signals;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith = signal;
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

export interface SpawnCall {
  file: string;
  args: string[];
  options: SpawnOptions;
  markerExisted: boolean;
}

export interface Harness {
  root: string;
  releaseRoot: string;
  adminDir: string;
  receiptDir: string;
  deps: LauncherDeps;
  spawnCalls: SpawnCall[];
  cliCalls: string[][];
  stderr: string[];
  signalListeners: Map<NodeJS.Signals, () => void>;
  child: FakeChild;
}

export interface HarnessOptions {
  env?: Record<string, string | undefined>;
  childExitCode?: number | null;
  hang?: boolean;
  cli?: { code: number; stdout: string; stderr?: string } | Error;
  /** 让 CLI 观察挂起直到调用方 releaseCli()，用于预检期取消测试。 */
  cliHang?: boolean;
  tamperEntry?: boolean;
  omitRuntimeDependencies?: boolean;
  runtimeSha?: string;
  receiptDirMissing?: boolean;
  spawnThrows?: boolean;
  cwd?: string;
}

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export function trackTemp(dir: string): string {
  temps.push(dir);
  return dir;
}

export function productionEnv(receiptDir: string): Record<string, string> {
  return {
    NODE_ENV: 'production',
    AGENT_SAAS_ENVIRONMENT: 'production',
    AGENT_SAAS_RELEASE_ID: 'rel-20260905',
    AGENT_SAAS_RELEASE_SHA: SHA,
    AGENT_SAAS_SERVER_DIGEST: SERVER_DIGEST,
    AGENT_SAAS_CONFIG_IDENTITY_DIGEST: CONFIG_DIGEST,
    AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: '1',
    AGENT_SAAS_CONFIG_PATH: '/etc/agent-saas/config.json',
    [RECEIPT_DIR_ENV]: receiptDir,
    USER: 'ops',
  };
}

export function observedStdout(digest = CONFIG_DIGEST): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    digest,
    credentialVersionDigest: null,
    secretRefCount: 0,
    versionResolution: 'resolved',
  })}\n`;
}

let cliRelease: (() => void) | undefined;
/** 释放 cliHang 挂起的 config-identity-cli 观察。 */
export function releaseCli(): void {
  cliRelease?.();
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = trackTemp(await realpath(await mkdtemp(join(tmpdir(), 'admin-launcher-'))));
  const releaseRoot = join(root, 'release', 'server');
  const adminDir = join(releaseRoot, 'dist', 'admin');
  const receiptDir = join(root, 'receipts');
  await mkdir(adminDir, { recursive: true });
  if (!options.receiptDirMissing) await mkdir(receiptDir, { recursive: true });

  const guardBody = '// guard\n';
  const bootstrapBody = '// bootstrap\n';
  const launcherBody = '// launcher\n';
  const banner =
    "import '../runtime-dependency-admin-guard.mjs';import '../admin-governance-bootstrap.mjs';";
  const bodies: Record<string, string> = {
    demo: `${banner}\n/* demo */\n`,
    'ref-cmd': `${banner}\n/* ref */\n`,
    'staging-only': `${banner}\n/* staging */\n`,
    'needs-output': `${banner}\n/* output */\n`,
  };
  await writeFile(join(releaseRoot, 'dist', 'runtime-dependency-admin-guard.mjs'), guardBody);
  await writeFile(join(releaseRoot, 'dist', 'admin-governance-bootstrap.mjs'), bootstrapBody);
  await writeFile(join(adminDir, 'launcher.mjs'), launcherBody);
  for (const [name, body] of Object.entries(bodies)) {
    await writeFile(
      join(adminDir, `${name}.mjs`),
      name === 'demo' && options.tamperEntry ? `${body}// tampered\n` : body,
    );
  }
  const command = (name: string, governance: CommandGovernance) => ({
    command: name,
    entry: `${name}.mjs`,
    source: `scripts/${name}.mts`,
    description: name,
    governance,
    ...digestOf(bodies[name]!),
  });
  const manifest = {
    schemaVersion: 2,
    kind: 'agent-saas-admin-runner',
    dependencyContractDigest: CONTRACT_DIGEST,
    runtimeDependencyGuard: {
      entry: '../runtime-dependency-admin-guard.mjs',
      ...digestOf(guardBody),
    },
    governanceBootstrap: { entry: '../admin-governance-bootstrap.mjs', ...digestOf(bootstrapBody) },
    launcher: {
      entry: 'launcher.mjs',
      source: 'src/release/adminRunner/launcherCli.ts',
      ...digestOf(launcherBody),
    },
    commands: [
      command('demo', demoGovernance),
      command('ref-cmd', refGovernance),
      command('staging-only', stagingOnlyGovernance),
      command('needs-output', outputGovernance),
    ],
  };
  await writeFile(join(adminDir, 'manifest.json'), JSON.stringify(manifest));
  if (!options.omitRuntimeDependencies) {
    await writeFile(
      join(releaseRoot, 'runtime-dependencies.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'agent-saas-runtime-dependency-identity',
        sourceSha: options.runtimeSha ?? SHA,
        contractDigest: CONTRACT_DIGEST,
        dependencyDigest: DEPENDENCY_DIGEST,
        node: {},
        baseImages: [],
        tools: [],
        identityDigest: `sha256:${'9'.repeat(64)}`,
      }),
    );
  }

  const spawnCalls: SpawnCall[] = [];
  const cliCalls: string[][] = [];
  const stderr: string[] = [];
  const signalListeners = new Map<NodeJS.Signals, () => void>();
  const child = new FakeChild();
  const env = { ...productionEnv(receiptDir), ...(options.env ?? {}) };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const deps: LauncherDeps = {
    env,
    launcherUrl: pathToFileURL(join(adminDir, 'launcher.mjs')).href,
    cwd: options.cwd ?? root,
    nodePath: '/fake/node',
    readFile: (path) => readFile(path),
    receiptFs: { mkdir, writeFile, rename, unlink, realpath: (path) => realpath(path) },
    spawn: (file, args, spawnOptions) => {
      if (options.spawnThrows) throw new Error('spawn failed');
      const nonce = spawnOptions.env[LAUNCH_NONCE_ENV];
      const markerDir = spawnOptions.env[RECEIPT_DIR_ENV];
      let markerExisted = false;
      try {
        markerExisted =
          Boolean(nonce && markerDir) &&
          statSync(join(markerDir!, '.launch', `${nonce}.json`)).isFile();
      } catch {
        markerExisted = false;
      }
      spawnCalls.push({ file, args, options: spawnOptions, markerExisted });
      if (!options.hang) {
        setImmediate(() =>
          child.emit('exit', options.childExitCode === undefined ? 0 : options.childExitCode, null),
        );
      }
      return child;
    },
    runConfigIdentityCli: async (_file, args) => {
      cliCalls.push(args);
      if (options.cliHang) await new Promise<void>((resolve) => (cliRelease = resolve));
      if (options.cli instanceof Error) throw options.cli;
      return options.cli ?? { code: 0, stdout: observedStdout() };
    },
    now: () => new Date('2026-09-05T07:00:00.000Z'),
    nonce: () => 'a'.repeat(32),
    stderr: (line) => stderr.push(line),
    signals: {
      on: (signal, listener) => signalListeners.set(signal, listener),
      off: (signal) => signalListeners.delete(signal),
    },
  };
  return {
    root,
    releaseRoot,
    adminDir,
    receiptDir,
    deps,
    spawnCalls,
    cliCalls,
    stderr,
    signalListeners,
    child,
  };
}

export async function onlyReceipt(
  receiptDir: string,
  environment = 'production',
): Promise<AdminRunnerReceipt> {
  const dir = join(receiptDir, environment, '20260905');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as AdminRunnerReceipt;
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
