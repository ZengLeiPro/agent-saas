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
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EXIT_RECEIPT_FAILED,
  EXIT_REJECTED,
  LAUNCH_NONCE_ENV,
  RECEIPT_DIR_ENV,
  isInsideDirectory,
  parseLauncherArgv,
  realpathOfNearestExisting,
  resolveConfigPath,
  runAdminLauncher,
  type LauncherDeps,
  type SpawnOptions,
  type SpawnedProcess,
} from './launcher.js';
import type { CommandGovernance } from './manifest.js';
import type { AdminRunnerReceipt } from './receipt.js';

const SHA = 'f'.repeat(40);
const CONTRACT_DIGEST = `sha256:${'1'.repeat(64)}`;
const DEPENDENCY_DIGEST = `sha256:${'2'.repeat(64)}`;
const CONFIG_DIGEST = `sha256:${'3'.repeat(64)}`;
const OTHER_CONFIG_DIGEST = `sha256:${'4'.repeat(64)}`;
const SERVER_DIGEST = `sha256:${'5'.repeat(64)}`;

const demoGovernance: CommandGovernance = {
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

const refGovernance: CommandGovernance = {
  ...demoGovernance,
  riskLevel: 'critical',
  defaultMode: 'read_only',
  writeIntents: [{ flag: '--execute-retention', riskLevel: 'critical', description: 'delete' }],
  escalationFlags: [],
  acceptsAuthorizationRef: true,
};

const stagingOnlyGovernance: CommandGovernance = {
  ...demoGovernance,
  escalationFlags: [],
  supportedEnvironments: ['staging'],
};

const outputGovernance: CommandGovernance = {
  ...demoGovernance,
  escalationFlags: [],
  writeIntents: [{ flag: '--apply', riskLevel: 'high', description: 'apply' }],
  requiredFlags: ['--output'],
};

function digestOf(body: string) {
  return {
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    size: Buffer.byteLength(body),
  };
}

class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = 4242;
  killedWith?: NodeJS.Signals;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith = signal;
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

interface SpawnCall {
  file: string;
  args: string[];
  options: SpawnOptions;
  markerExisted: boolean;
}

interface Harness {
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

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  childExitCode?: number | null;
  hang?: boolean;
  cli?: { code: number; stdout: string; stderr?: string } | Error;
  /** 让 CLI 观察挂起直到调用方 resolve，用于预检期取消测试。 */
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

function productionEnv(receiptDir: string): Record<string, string> {
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

function observedStdout(digest = CONFIG_DIGEST): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    digest,
    credentialVersionDigest: null,
    secretRefCount: 0,
    versionResolution: 'resolved',
  })}\n`;
}

let cliRelease: (() => void) | undefined;

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'admin-launcher-')));
  temps.push(root);
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

async function onlyReceipt(
  receiptDir: string,
  environment = 'production',
): Promise<AdminRunnerReceipt> {
  const dir = join(receiptDir, environment, '20260905');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as AdminRunnerReceipt;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('parseLauncherArgv', () => {
  it('separates launcher options from script arguments', () => {
    expect(
      parseLauncherArgv([
        'demo',
        '--authorization-ref',
        'CHG-1',
        '--runtime-data-dir',
        '/data',
        '--',
        '--execute',
        '--x=1',
      ]),
    ).toEqual({
      command: 'demo',
      authorizationRef: 'CHG-1',
      runtimeDataDir: '/data',
      scriptArgs: ['--execute', '--x=1'],
    });
    expect(parseLauncherArgv(['demo', '--authorization-ref=CHG-2'])).toEqual({
      command: 'demo',
      authorizationRef: 'CHG-2',
      scriptArgs: [],
    });
    expect(parseLauncherArgv(['demo'])).toEqual({ command: 'demo', scriptArgs: [] });
  });

  it('rejects malformed input with fixed messages that never echo the input', () => {
    const cases: Array<[string[], RegExp]> = [
      [[], /usage/u],
      [['--execute'], /usage/u],
      [['/etc/private/customer'], /invalid shape/u],
      [['demo', '--tenant-customer-123'], /unknown launcher option/u],
      [['demo', '--authorization-ref'], /missing its value/u],
      [['demo', '--authorization-ref', '--'], /missing its value/u],
      [['demo', '--authorization-ref', 'a', '--authorization-ref', 'b'], /given twice/u],
    ];
    for (const [argv, pattern] of cases) {
      let message = '';
      try {
        parseLauncherArgv(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, argv.join(' ')).toMatch(pattern);
      expect(message).not.toContain('customer');
      expect(message).not.toContain('/etc/');
    }
  });
});

describe('path helpers', () => {
  it('isInsideDirectory treats the directory itself and descendants as inside', () => {
    expect(isInsideDirectory('/opt/rel/server', '/opt/rel/server')).toBe(true);
    expect(isInsideDirectory('/opt/rel/server', '/opt/rel/server/receipts')).toBe(true);
    expect(isInsideDirectory('/opt/rel/server', '/opt/rel/server-receipts')).toBe(false);
    expect(isInsideDirectory('/opt/rel/server', '/opt/rel')).toBe(false);
    expect(isInsideDirectory('/opt/rel/server', '/var/lib/receipts')).toBe(false);
  });

  it('resolveConfigPath mirrors getAppConfigPath without trimming', () => {
    expect(
      resolveConfigPath({ AGENT_SAAS_CONFIG_PATH: '/etc/a.json' }, '/rel/server', '/cwd'),
    ).toBe('/etc/a.json');
    expect(resolveConfigPath({ AGENT_SAAS_CONFIG_PATH: './a.json' }, '/rel/server', '/cwd')).toBe(
      '/cwd/a.json',
    );
    expect(resolveConfigPath({ CONFIG_JSON_PATH: 'b.json' }, '/rel/server', '/cwd')).toBe(
      '/cwd/b.json',
    );
    expect(
      resolveConfigPath(
        { AGENT_SAAS_CONFIG_PATH: ' ', CONFIG_JSON_PATH: 'b.json' },
        '/rel/server',
        '/cwd',
      ),
    ).toBe('/cwd/ ');
    expect(resolveConfigPath({}, '/rel/server', '/cwd')).toBe('/rel/config.json');
  });

  it('realpathOfNearestExisting resolves through the nearest existing ancestor', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'admin-realpath-')));
    temps.push(root);
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'));
    expect(await realpathOfNearestExisting(join(root, 'link', 'a', 'b'), realpath)).toBe(
      join(root, 'real', 'a', 'b'),
    );
    expect(await realpathOfNearestExisting(join(root, 'real'), realpath)).toBe(join(root, 'real'));
  });
});

describe('runAdminLauncher', () => {
  it('refuses without a receipt directory and writes nothing', async () => {
    const h = await harness({ env: { [RECEIPT_DIR_ENV]: undefined } });
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.spawnCalls).toEqual([]);
    expect(h.stderr[0]).toMatch(/receipt_dir_unavailable/u);
  });

  it('refuses a receipt directory inside the sealed release tree, including via symlink', async () => {
    const h = await harness();
    h.deps.env[RECEIPT_DIR_ENV] = join(h.releaseRoot, 'receipts');
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.stderr[0]).toMatch(/must not be inside the sealed release directory/u);
    await expect(stat(join(h.releaseRoot, 'receipts'))).rejects.toThrow();
    // 相对路径同样按 launcher cwd 解析后判定。
    h.stderr.length = 0;
    h.deps.cwd = h.releaseRoot;
    h.deps.env[RECEIPT_DIR_ENV] = 'dist/receipts';
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.stderr[0]).toMatch(/must not be inside/u);
    // 外部路径是指向 release 内目录的符号链接：按 realpath 拒绝。
    h.stderr.length = 0;
    h.deps.cwd = h.root;
    const link = join(h.root, 'receipts-link');
    await symlink(join(h.releaseRoot, 'dist'), link);
    h.deps.env[RECEIPT_DIR_ENV] = join(link, 'nested', 'deeper');
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.stderr[0]).toMatch(/must not be inside/u);
    await expect(stat(join(h.releaseRoot, 'dist', 'nested'))).rejects.toThrow();
  });

  it('refuses when a receipt subdirectory symlink points back into the release tree', async () => {
    const h = await harness();
    await symlink(join(h.releaseRoot, 'dist'), join(h.receiptDir, 'production'));
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_RECEIPT_FAILED);
    expect(h.stderr.at(-1)).toMatch(/receipt write failed .*sealed release directory/u);
    expect(h.spawnCalls).toEqual([]);
    await expect(stat(join(h.releaseRoot, 'dist', '20260905'))).rejects.toThrow();
  });

  it('resolves a relative receipt directory against cwd and forwards the absolute path', async () => {
    const h = await harness();
    h.deps.env[RECEIPT_DIR_ENV] = relative(h.root, h.receiptDir);
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(0);
    expect(h.spawnCalls[0]!.options.env[RECEIPT_DIR_ENV]).toBe(h.receiptDir);
    expect(h.spawnCalls[0]!.markerExisted).toBe(true);
    expect((await onlyReceipt(h.receiptDir)).result).toBe('succeeded');
  });

  it('rejects unknown and malformed commands without copying them into the receipt', async () => {
    const h = await harness();
    expect(await runAdminLauncher(['nope'], h.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(h.receiptDir, 'unidentified')).toMatchObject({
      result: 'rejected',
      errorCategory: 'unknown_command',
      command: 'nope',
    });
    expect(h.spawnCalls).toEqual([]);
    const malformed = await harness();
    expect(await runAdminLauncher(['/etc/private/customer', '--x'], malformed.deps)).toBe(
      EXIT_REJECTED,
    );
    const receipt = await onlyReceipt(malformed.receiptDir, 'unidentified');
    expect(receipt).toMatchObject({ errorCategory: 'invalid_arguments', command: '(invalid)' });
    expect(JSON.stringify(receipt)).not.toContain('customer');
    const unknownOption = await harness();
    expect(await runAdminLauncher(['demo', '--tenant-customer-123'], unknownOption.deps)).toBe(
      EXIT_REJECTED,
    );
    expect(
      JSON.stringify(await onlyReceipt(unknownOption.receiptDir, 'unidentified')),
    ).not.toContain('customer');
  });

  it('rejects tampered entries before touching identities', async () => {
    const h = await harness({ tamperEntry: true });
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(h.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'entry_tampered',
    });
    expect(h.cliCalls).toEqual([]);
  });

  it('runs a dry-run through the entry with nonce, marker and the same absolute config path', async () => {
    const h = await harness();
    expect(
      await runAdminLauncher(
        ['demo', '--runtime-data-dir', '/mnt/data', '--', '--limit', '5'],
        h.deps,
      ),
    ).toBe(0);
    expect(h.spawnCalls).toHaveLength(1);
    const call = h.spawnCalls[0]!;
    expect(call.file).toBe('/fake/node');
    expect(call.args).toEqual([join(h.adminDir, 'demo.mjs'), '--limit', '5']);
    expect(call.options.cwd).toBe(h.releaseRoot);
    expect(call.options.env[LAUNCH_NONCE_ENV]).toBe('a'.repeat(32));
    expect(call.options.env.AGENT_SAAS_CONFIG_PATH).toBe('/etc/agent-saas/config.json');
    expect(call.markerExisted).toBe(true);
    await expect(stat(join(h.receiptDir, '.launch', `${'a'.repeat(32)}.json`))).rejects.toThrow();
    expect(h.cliCalls[0]).toEqual(
      expect.arrayContaining([
        '--config',
        '/etc/agent-saas/config.json',
        '--environment',
        'production',
        '--process-cwd',
        h.releaseRoot,
        '--runtime-data-dir',
        '/mnt/data',
      ]),
    );
    const receipt = await onlyReceipt(h.receiptDir);
    expect(receipt).toMatchObject({
      result: 'succeeded',
      exitCode: 0,
      mode: 'dry_run',
      defaultMode: 'dry_run',
      riskLevel: 'high',
      environment: 'production',
      writeIntents: [],
      targetOverrides: [],
      authorizationForwarded: false,
      release: {
        status: 'bound',
        releaseId: 'rel-20260905',
        releaseSha: SHA,
        serverDigest: SERVER_DIGEST,
      },
      configIdentity: {
        status: 'consistent',
        gate: 'passed',
        expectedDigest: CONFIG_DIGEST,
        observedDigest: CONFIG_DIGEST,
      },
      actor: { source: 'process_env', user: 'ops', trusted: false },
      argsSummary: {
        declaredFlags: [],
        otherFlagCount: 1,
        positionalCount: 1,
        inlineValueCount: 0,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('a'.repeat(32));
    expect(JSON.stringify(receipt)).not.toContain('/mnt/data');
    expect(h.signalListeners.size).toBe(0);
  });

  it('resolves a relative config path against the launcher cwd for both preflight and child', async () => {
    const h = await harness({ env: { AGENT_SAAS_CONFIG_PATH: './cfg/config.json' } });
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(0);
    const expected = join(h.root, 'cfg', 'config.json');
    expect(h.cliCalls[0]).toEqual(expect.arrayContaining(['--config', expected]));
    expect(h.spawnCalls[0]!.options.env.AGENT_SAAS_CONFIG_PATH).toBe(expected);
    const fallback = await harness({ env: { AGENT_SAAS_CONFIG_PATH: undefined } });
    expect(await runAdminLauncher(['demo'], fallback.deps)).toBe(0);
    expect(fallback.cliCalls[0]).toEqual(
      expect.arrayContaining(['--config', join(fallback.releaseRoot, '..', 'config.json')]),
    );
  });

  it('records target override signals by name and never their values', async () => {
    const h = await harness({ env: { DATABASE_URL: 'postgres://u:pw@other/db' } });
    expect(
      await runAdminLauncher(['demo', '--', '--connection-string', 'postgres://u:pw@x/y'], h.deps),
    ).toBe(0);
    const receipt = await onlyReceipt(h.receiptDir);
    expect(receipt.targetOverrides).toEqual(['--connection-string', 'env:DATABASE_URL']);
    expect(JSON.stringify(receipt)).not.toContain('postgres://');
  });

  it('refuses write intents without an authorization ref and never spawns', async () => {
    const h = await harness();
    expect(await runAdminLauncher(['demo', '--', '--execute'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.spawnCalls).toEqual([]);
    expect(await onlyReceipt(h.receiptDir, 'unidentified')).toMatchObject({
      result: 'rejected',
      errorCategory: 'write_flag_without_authorization',
      mode: 'write',
      writeIntents: ['--execute'],
    });
  });

  it('does not treat --execute=value as a write intent, matching the scripts', async () => {
    const h = await harness();
    expect(await runAdminLauncher(['demo', '--', '--execute=false'], h.deps)).toBe(0);
    expect(await onlyReceipt(h.receiptDir)).toMatchObject({
      mode: 'dry_run',
      writeIntents: [],
      argsSummary: {
        declaredFlags: [],
        otherFlagCount: 1,
        positionalCount: 0,
        inlineValueCount: 1,
      },
    });
  });

  it('enforces required flags before any identity work', async () => {
    const missing = await harness();
    expect(await runAdminLauncher(['needs-output'], missing.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(missing.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'invalid_arguments',
      errorDetail: 'required flag missing: --output',
    });
    expect(missing.cliCalls).toEqual([]);
    const provided = await harness();
    expect(await runAdminLauncher(['needs-output', '--', '--output=/tmp/out'], provided.deps)).toBe(
      0,
    );
    const receipt = await onlyReceipt(provided.receiptDir);
    expect(receipt.result).toBe('succeeded');
    expect(JSON.stringify(receipt)).not.toContain('/tmp/out');
  });

  it('holds the authorization ref for scripts that do not accept it and forwards it to those that do', async () => {
    const held = await harness();
    expect(
      await runAdminLauncher(
        ['demo', '--authorization-ref', 'CHG-7', '--', '--execute', '--force'],
        held.deps,
      ),
    ).toBe(0);
    expect(held.spawnCalls[0]!.args).toEqual([
      join(held.adminDir, 'demo.mjs'),
      '--execute',
      '--force',
    ]);
    expect(await onlyReceipt(held.receiptDir)).toMatchObject({
      mode: 'write',
      writeIntents: ['--execute'],
      escalationFlags: ['--force'],
      authorizationRef: 'CHG-7',
      authorizationForwarded: false,
      argsSummary: {
        declaredFlags: ['--execute', '--force'],
        otherFlagCount: 0,
        positionalCount: 0,
        inlineValueCount: 0,
      },
    });
    const forwarded = await harness();
    expect(
      await runAdminLauncher(
        ['ref-cmd', '--authorization-ref', 'CHG-8', '--', '--execute-retention'],
        forwarded.deps,
      ),
    ).toBe(0);
    expect(forwarded.spawnCalls[0]!.args).toEqual([
      join(forwarded.adminDir, 'ref-cmd.mjs'),
      '--execute-retention',
      '--authorization-ref',
      'CHG-8',
    ]);
    expect(await onlyReceipt(forwarded.receiptDir)).toMatchObject({
      authorizationForwarded: true,
      mode: 'write',
    });
  });

  it('rejects escalation flags without their write intent, misplaced, malformed and token-shaped refs', async () => {
    const escalation = await harness();
    expect(
      await runAdminLauncher(
        ['demo', '--authorization-ref', 'CHG-1', '--', '--force'],
        escalation.deps,
      ),
    ).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(escalation.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'escalation_without_write',
    });
    const misplaced = await harness();
    expect(
      await runAdminLauncher(
        ['demo', '--', '--execute', '--authorization-ref', 'CHG-1'],
        misplaced.deps,
      ),
    ).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(misplaced.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'authorization_ref_misplaced',
    });
    for (const bad of ['postgres://db/app', 'ghp_abcdefghijklmnopqrstuvwxyz', 'CHG/home/1']) {
      const malformed = await harness();
      expect(
        await runAdminLauncher(
          ['demo', '--authorization-ref', bad, '--', '--execute'],
          malformed.deps,
        ),
        bad,
      ).toBe(EXIT_REJECTED);
      const receipt = await onlyReceipt(malformed.receiptDir, 'unidentified');
      expect(receipt.errorCategory).toBe('authorization_ref_invalid');
      expect(JSON.stringify(receipt)).not.toContain(bad);
    }
  });

  it('rejects unidentified and unsupported environments', async () => {
    const unidentified = await harness({ env: { AGENT_SAAS_ENVIRONMENT: undefined } });
    expect(await runAdminLauncher(['demo'], unidentified.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(unidentified.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'environment_unidentified',
    });
    const unsupported = await harness();
    expect(await runAdminLauncher(['staging-only'], unsupported.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(unsupported.receiptDir)).toMatchObject({
      errorCategory: 'environment_unsupported',
      environment: 'production',
    });
  });

  it('rejects release identity that is missing or mismatched in production', async () => {
    const missing = await harness({ omitRuntimeDependencies: true });
    expect(await runAdminLauncher(['demo'], missing.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(missing.receiptDir)).toMatchObject({
      errorCategory: 'release_identity_mismatch',
      release: { status: 'mismatch', reason: 'runtime_dependencies_missing' },
    });
    const mismatch = await harness({ runtimeSha: '0'.repeat(40) });
    expect(await runAdminLauncher(['demo'], mismatch.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(mismatch.receiptDir)).toMatchObject({
      release: { reason: 'release_sha_mismatch' },
    });
    const notBound = await harness({ env: { AGENT_SAAS_RELEASE_SHA: undefined } });
    expect(await runAdminLauncher(['demo'], notBound.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(notBound.receiptDir)).toMatchObject({
      errorCategory: 'release_identity_missing',
      release: { status: 'not_bound' },
    });
    expect(missing.cliCalls).toEqual([]);
  });

  it('applies the config identity matrix in production', async () => {
    const drifted = await harness({
      cli: { code: 0, stdout: observedStdout(OTHER_CONFIG_DIGEST) },
    });
    expect(await runAdminLauncher(['demo'], drifted.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(drifted.receiptDir)).toMatchObject({
      errorCategory: 'config_identity_drifted',
      configIdentity: { status: 'drifted', gate: 'rejected' },
    });
    expect(drifted.spawnCalls).toEqual([]);

    const unboundEnv = {
      AGENT_SAAS_CONFIG_IDENTITY_DIGEST: undefined,
      AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: undefined,
    };
    const unboundDryRun = await harness({ env: unboundEnv });
    expect(await runAdminLauncher(['demo'], unboundDryRun.deps)).toBe(0);
    expect(await onlyReceipt(unboundDryRun.receiptDir)).toMatchObject({
      result: 'succeeded',
      configIdentity: { status: 'unverifiable', reason: 'expected_not_bound', gate: 'annotated' },
    });
    const unboundWrite = await harness({ env: unboundEnv });
    expect(
      await runAdminLauncher(
        ['demo', '--authorization-ref', 'CHG-1', '--', '--execute'],
        unboundWrite.deps,
      ),
    ).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(unboundWrite.receiptDir)).toMatchObject({
      errorCategory: 'config_identity_unverifiable',
    });
    expect(unboundWrite.spawnCalls).toEqual([]);

    const cliFailed = await harness({
      cli: { code: 1, stdout: '', stderr: 'config-identity-cli failed: vault unreachable' },
    });
    expect(await runAdminLauncher(['demo'], cliFailed.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(cliFailed.receiptDir)).toMatchObject({
      errorCategory: 'config_identity_unverifiable',
      configIdentity: { reason: 'observation_failed' },
    });
    expect(
      cliFailed.stderr.some((line) =>
        line.includes('[config-identity-cli] config-identity-cli failed'),
      ),
    ).toBe(true);
    expect(JSON.stringify(await onlyReceipt(cliFailed.receiptDir))).not.toContain(
      'vault unreachable',
    );
    const cliThrew = await harness({ cli: new Error('spawn ENOENT') });
    expect(await runAdminLauncher(['demo'], cliThrew.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(cliThrew.receiptDir)).toMatchObject({
      configIdentity: { reason: 'observation_failed' },
    });
  });

  it('lets development run with annotations while still rejecting mismatches', async () => {
    const devEnv = {
      AGENT_SAAS_ENVIRONMENT: undefined,
      NODE_ENV: 'development',
      AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT: '1',
      AGENT_SAAS_RELEASE_SHA: undefined,
      AGENT_SAAS_CONFIG_IDENTITY_DIGEST: undefined,
      AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: undefined,
    };
    const dev = await harness({
      env: devEnv,
      cli: { code: 0, stdout: observedStdout(OTHER_CONFIG_DIGEST) },
    });
    expect(
      await runAdminLauncher(['demo', '--authorization-ref', 'DEV-1', '--', '--execute'], dev.deps),
    ).toBe(0);
    expect(await onlyReceipt(dev.receiptDir, 'development')).toMatchObject({
      result: 'succeeded',
      environment: 'development',
      release: { status: 'not_bound' },
      configIdentity: { status: 'unverifiable', reason: 'expected_not_bound', gate: 'annotated' },
    });
    const devMismatch = await harness({ env: devEnv });
    await writeFile(
      join(devMismatch.releaseRoot, 'runtime-dependencies.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'agent-saas-runtime-dependency-identity',
        sourceSha: SHA,
        contractDigest: `sha256:${'8'.repeat(64)}`,
        dependencyDigest: DEPENDENCY_DIGEST,
      }),
    );
    expect(await runAdminLauncher(['demo'], devMismatch.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(devMismatch.receiptDir, 'development')).toMatchObject({
      errorCategory: 'release_identity_mismatch',
    });
  });

  it('records script failures with their exit code without pretending success', async () => {
    const h = await harness({ childExitCode: 2 });
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(2);
    expect(await onlyReceipt(h.receiptDir)).toMatchObject({
      result: 'failed',
      exitCode: 2,
      errorCategory: 'script_exit_nonzero',
    });
    const spawnFailed = await harness({ spawnThrows: true });
    expect(await runAdminLauncher(['demo'], spawnFailed.deps)).toBe(1);
    expect(await onlyReceipt(spawnFailed.receiptDir)).toMatchObject({
      result: 'failed',
      errorCategory: 'script_spawn_failed',
    });
    await expect(
      stat(join(spawnFailed.receiptDir, '.launch', `${'a'.repeat(32)}.json`)),
    ).rejects.toThrow();
  });

  it('forwards SIGINT to the child, keeps handlers until the receipt is written, then releases them', async () => {
    const h = await harness({ hang: true });
    const pending = runAdminLauncher(['demo'], h.deps);
    await tick();
    expect(h.signalListeners.has('SIGINT')).toBe(true);
    h.signalListeners.get('SIGINT')!();
    expect(await pending).toBe(130);
    expect(h.child.killedWith).toBe('SIGINT');
    expect(await onlyReceipt(h.receiptDir)).toMatchObject({
      result: 'cancelled',
      signal: 'SIGINT',
      errorCategory: 'script_signal',
    });
    expect(h.signalListeners.size).toBe(0);
  });

  it('cancels during preflight with a terminal receipt, even when the pending gate would reject', async () => {
    const cleanCancel = await harness({ cliHang: true });
    const pending = runAdminLauncher(['demo'], cleanCancel.deps);
    await tick();
    expect(cleanCancel.cliCalls).toHaveLength(1);
    cleanCancel.signalListeners.get('SIGTERM')!();
    cliRelease!();
    expect(await pending).toBe(143);
    expect(cleanCancel.spawnCalls).toEqual([]);
    expect(await onlyReceipt(cleanCancel.receiptDir)).toMatchObject({
      result: 'cancelled',
      signal: 'SIGTERM',
      errorCategory: 'script_signal',
    });
    await expect(
      stat(join(cleanCancel.receiptDir, '.launch', `${'a'.repeat(32)}.json`)),
    ).rejects.toThrow();

    // 取消优先于拒绝：观察期间收到信号，随后 CLI 返回 drifted，仍记 cancelled/143。
    const wouldReject = await harness({
      cliHang: true,
      cli: { code: 0, stdout: observedStdout(OTHER_CONFIG_DIGEST) },
    });
    const pendingReject = runAdminLauncher(['demo'], wouldReject.deps);
    await tick();
    wouldReject.signalListeners.get('SIGTERM')!();
    cliRelease!();
    expect(await pendingReject).toBe(143);
    expect(await onlyReceipt(wouldReject.receiptDir)).toMatchObject({
      result: 'cancelled',
      signal: 'SIGTERM',
      errorCategory: 'script_signal',
    });
  });

  it('writes a started receipt before execution and never leaks values or paths', async () => {
    const h = await harness({ hang: true });
    const pending = runAdminLauncher(
      [
        'demo',
        '--authorization-ref',
        'CHG-9',
        '--runtime-data-dir',
        '/mnt/agent-saas/server-data',
        '--',
        '--execute',
        '--connection-string',
        'postgres://user:pw@db/app',
        '--root=/etc/agent-saas/secret',
        '--tenant-customer-123',
      ],
      h.deps,
    );
    await tick();
    const started = await onlyReceipt(h.receiptDir);
    expect(started.result).toBe('started');
    h.child.emit('exit', 0, null);
    expect(await pending).toBe(0);
    const final = await onlyReceipt(h.receiptDir);
    const json = JSON.stringify(final);
    expect(final.result).toBe('succeeded');
    expect(final.invocationId).toBe(started.invocationId);
    for (const leak of [
      'postgres://',
      'user:pw',
      '/etc/agent-saas',
      '/mnt/agent-saas',
      'customer-123',
      h.root,
    ]) {
      expect(json).not.toContain(leak);
    }
    expect(final.argsSummary).toEqual({
      declaredFlags: ['--execute'],
      otherFlagCount: 3,
      positionalCount: 1,
      inlineValueCount: 1,
    });
    expect(final.targetOverrides).toEqual(['--connection-string', '--root']);
  });

  it('exits 4 when the receipt cannot be written', async () => {
    const h = await harness();
    await rm(h.receiptDir, { recursive: true, force: true });
    await writeFile(h.receiptDir, 'not a directory');
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_RECEIPT_FAILED);
    expect(h.spawnCalls).toEqual([]);
    expect(h.stderr.at(-1)).toMatch(/receipt write failed/u);
    expect(h.signalListeners.size).toBe(0);
  });

  it('still writes a terminal receipt when the launch marker cannot be created', async () => {
    const h = await harness();
    await writeFile(join(h.receiptDir, '.launch'), 'not a directory');
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    const receipt = await onlyReceipt(h.receiptDir);
    expect(receipt).toMatchObject({ result: 'rejected', errorCategory: 'receipt_dir_unavailable' });
    expect(JSON.stringify(receipt)).not.toContain(h.root);
    expect(h.spawnCalls).toEqual([]);
  });
});
