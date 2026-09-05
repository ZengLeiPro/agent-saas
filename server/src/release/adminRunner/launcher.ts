/**
 * Admin Runner 治理 launcher：受支持 one-off 命令的唯一执行入口。
 *
 *   node dist/admin/launcher.mjs <command> [--authorization-ref <ref>]
 *        [--runtime-data-dir <dir>] [--env-file <file>] -- [脚本原生参数]
 *
 * 预检顺序（任一失败 → rejected 回执，exit 3）：
 *   1. 回执目录可用（AGENT_SAAS_ADMIN_RECEIPT_DIR，绝对化 + realpath 后必须在 release 树之外）；
 *   2. manifest 合法、launcher/guard/bootstrap/入口字节摘要与 manifest 一致；
 *   3. 命令在 manifest 中，必填 flag / 写意图 / 升级 flag / authorization ref 规则成立；
 *   4. 环境由 readRuntimeIdentity 判定且在命令的 supportedEnvironments 内；
 *   5. Release identity（runtime-dependencies.json ↔ release env）；
 *   6. Config Identity 四态 × 环境 × 意图矩阵（observed 与子进程读取同一绝对配置路径）。
 * 然后以子进程执行入口（保留脚本自身的退出码与门禁），并写终态回执。
 * 任何阶段收到 SIGINT/SIGTERM：预检期 → 下一检查点写 cancelled（优先于普通拒绝）；
 * 运行期 → 转发子进程；收尾期 → 忽略直到回执落盘。
 *
 * 退出码：0 成功；子进程非零码透传；3 launcher 拒绝；4 回执写入失败；128+signal 取消。
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRuntimeIdentity, type RuntimeIdentity } from '../runtimeIdentity.js';
import {
  decideConfigIdentityGate,
  evaluateConfigIdentity,
  parseObservedConfigIdentity,
  type ConfigIdentityCheck,
} from './configIdentityCheck.js';
import {
  AUTHORIZATION_REF_FLAG,
  classifyInvocation,
  detectTargetOverrides,
  missingRequiredFlags,
  normalizeAuthorizationRef,
  summarizeArgs,
} from './intent.js';
import {
  findManifestCommand,
  parseAdminRunnerManifest,
  type AdminRunnerManifest,
  type ManifestCommand,
} from './manifest.js';
import {
  actorFromEnv,
  isInsideDirectory,
  newInvocationId,
  realpathOfNearestExisting,
  writeReceiptAtomically,
  type AdminRunnerReceipt,
  type ReceiptErrorCategory,
  type ReceiptFs,
} from './receipt.js';
import { checkReleaseIdentity, releaseIdentityAllowed } from './releaseIdentity.js';

export { isInsideDirectory, realpathOfNearestExisting } from './receipt.js';

export const EXIT_REJECTED = 3;
export const EXIT_RECEIPT_FAILED = 4;
export const RECEIPT_DIR_ENV = 'AGENT_SAAS_ADMIN_RECEIPT_DIR';
export const LAUNCH_NONCE_ENV = 'AGENT_SAAS_ADMIN_LAUNCH_NONCE';
const CONFIG_PATH_ENV = 'AGENT_SAAS_CONFIG_PATH';
const REDACTED_DETAIL = 'detail withheld: failed redaction check';
const COMMAND_NAME_PATTERN = /^[a-z0-9-]{1,64}$/u;

export interface SpawnedProcess {
  pid?: number;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: 'inherit';
}

export interface ConfigIdentityCliResult {
  code: number | null;
  stdout: string;
  /** 只回放到操作者 stderr 供诊断，绝不进入回执。 */
  stderr?: string;
}

export interface LauncherDeps {
  env: NodeJS.ProcessEnv;
  /** dist/admin/launcher.mjs 的 import.meta.url。 */
  launcherUrl: string;
  /** 解析相对路径（回执目录、配置路径）的基准，默认 process.cwd()。 */
  cwd: string;
  nodePath: string;
  readFile: (path: string) => Promise<Buffer>;
  receiptFs: ReceiptFs & { unlink: typeof unlink };
  spawn: (file: string, args: string[], options: SpawnOptions) => SpawnedProcess;
  runConfigIdentityCli: (
    file: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<ConfigIdentityCliResult>;
  now: () => Date;
  nonce: () => string;
  stderr: (line: string) => void;
  signals: {
    on(signal: NodeJS.Signals, listener: () => void): void;
    off(signal: NodeJS.Signals, listener: () => void): void;
  };
}

export interface LauncherInvocation {
  command: string;
  authorizationRef?: string;
  runtimeDataDir?: string;
  envFile?: string;
  scriptArgs: string[];
}

const LAUNCHER_OPTIONS = new Set(['--authorization-ref', '--runtime-data-dir', '--env-file']);
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

class LauncherRejection extends Error {
  constructor(
    readonly category: ReceiptErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = 'LauncherRejection';
  }
}

// 拒绝文案是固定句式：不回显操作者输入的任何原文（未知选项名、命令名等都可能是任意字符串）。
export function parseLauncherArgv(argv: readonly string[]): LauncherInvocation {
  const [command, ...rest] = argv;
  if (!command || command.startsWith('-')) {
    throw new LauncherRejection(
      'invalid_arguments',
      'usage: launcher <command> [options] -- [args]',
    );
  }
  if (!COMMAND_NAME_PATTERN.test(command)) {
    throw new LauncherRejection('invalid_arguments', 'command name has an invalid shape');
  }
  const options: Record<string, string> = {};
  let index = 0;
  let scriptArgs: string[] = [];
  while (index < rest.length) {
    const argument = rest[index]!;
    if (argument === '--') {
      scriptArgs = rest.slice(index + 1);
      break;
    }
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (!LAUNCHER_OPTIONS.has(name)) {
      throw new LauncherRejection(
        'invalid_arguments',
        'unknown launcher option; script arguments must follow an explicit --',
      );
    }
    if (name in options) {
      throw new LauncherRejection('invalid_arguments', 'a launcher option was given twice');
    }
    if (separator !== -1) {
      options[name] = argument.slice(separator + 1);
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value === '--' || value.startsWith('--')) {
      throw new LauncherRejection('invalid_arguments', 'a launcher option is missing its value');
    }
    options[name] = value;
    index += 2;
  }
  return {
    command,
    ...(options['--authorization-ref'] !== undefined
      ? { authorizationRef: options['--authorization-ref'] }
      : {}),
    ...(options['--runtime-data-dir'] ? { runtimeDataDir: options['--runtime-data-dir'] } : {}),
    ...(options['--env-file'] ? { envFile: options['--env-file'] } : {}),
    scriptArgs,
  };
}

/**
 * 与 `loadAppConfig`/`getAppConfigPath` 同一语义（`AGENT_SAAS_CONFIG_PATH || CONFIG_JSON_PATH`，
 * 否则 `<processCwd>/../config.json`），但按注入的 env 与 cwd 解析并绝对化：预检 CLI 与子进程
 * 必须拿到同一个绝对路径，不能各自按自己的 cwd 解析相对值。
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv,
  releaseRoot: string,
  cwd: string,
): string {
  const explicit = env[CONFIG_PATH_ENV] || env.CONFIG_JSON_PATH;
  if (explicit) return resolve(cwd, explicit);
  return resolve(releaseRoot, '..', 'config.json');
}

function digestOf(body: Buffer): { digest: string; size: number } {
  return { digest: `sha256:${createHash('sha256').update(body).digest('hex')}`, size: body.length };
}

async function verifyFile(
  deps: LauncherDeps,
  path: string,
  expected: { digest: string; size: number },
  label: string,
): Promise<void> {
  let body: Buffer;
  try {
    body = await deps.readFile(path);
  } catch {
    throw new LauncherRejection('entry_tampered', `${label} is missing from this release`);
  }
  const actual = digestOf(body);
  if (actual.digest !== expected.digest || actual.size !== expected.size) {
    throw new LauncherRejection('entry_tampered', `${label} does not match the manifest digest`);
  }
}

async function loadManifest(deps: LauncherDeps, adminDir: string): Promise<AdminRunnerManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse((await deps.readFile(join(adminDir, 'manifest.json'))).toString('utf8'));
  } catch {
    throw new LauncherRejection(
      'manifest_invalid',
      'dist/admin/manifest.json is missing or not JSON',
    );
  }
  try {
    return parseAdminRunnerManifest(raw);
  } catch (error) {
    throw new LauncherRejection(
      'manifest_invalid',
      error instanceof Error ? error.message : 'manifest rejected',
    );
  }
}

function resolveRuntimeIdentity(env: NodeJS.ProcessEnv): RuntimeIdentity {
  try {
    return readRuntimeIdentity(env);
  } catch (error) {
    throw new LauncherRejection(
      'environment_unidentified',
      error instanceof Error ? error.message : 'environment could not be identified',
    );
  }
}

async function observeConfigIdentity(
  deps: LauncherDeps,
  releaseRoot: string,
  configPath: string,
  environment: string,
  invocation: LauncherInvocation,
  runtimeIdentity: RuntimeIdentity,
): Promise<ConfigIdentityCheck> {
  const cliArgs = [
    join(releaseRoot, 'dist', 'config-identity-cli.js'),
    '--config',
    configPath,
    '--environment',
    environment,
    '--process-cwd',
    releaseRoot,
    ...(invocation.runtimeDataDir ? ['--runtime-data-dir', invocation.runtimeDataDir] : []),
    ...(invocation.envFile ? ['--env-file', invocation.envFile] : []),
  ];
  let observed: Parameters<typeof evaluateConfigIdentity>[0]['observed'];
  try {
    const result = await deps.runConfigIdentityCli(deps.nodePath, cliArgs, {
      cwd: releaseRoot,
      env: deps.env,
    });
    if (result.code !== 0 && result.stderr?.trim()) {
      for (const line of result.stderr.trim().split(/\r?\n/u)) {
        deps.stderr(`[config-identity-cli] ${line}`);
      }
    }
    observed =
      result.code === 0
        ? parseObservedConfigIdentity(result.stdout)
        : { error: `config-identity-cli exited with ${result.code ?? 'signal'}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'config-identity-cli failed';
    deps.stderr(`[config-identity-cli] observation failed: ${message}`);
    observed = { error: message };
  }
  return evaluateConfigIdentity({ expected: runtimeIdentity.expectedConfigIdentity, observed });
}

function summarize(deps: LauncherDeps, receipt: AdminRunnerReceipt, receiptPath: string): void {
  const detail = receipt.errorCategory ? ` ${receipt.errorCategory}` : '';
  deps.stderr(
    `[admin-launcher] ${receipt.result}${detail} command=${receipt.command} mode=${receipt.mode ?? '-'} receipt=${receiptPath}`,
  );
}

function signalNumber(signal: string | undefined): number {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    case 'SIGKILL':
      return 9;
    case 'SIGHUP':
      return 1;
    default:
      return 15;
  }
}

type Phase = 'preflight' | 'running' | 'finishing';

export async function runAdminLauncher(
  argv: readonly string[],
  deps: LauncherDeps,
): Promise<number> {
  const startedAt = deps.now().toISOString();
  const rawCommand = argv[0];
  const receipt: AdminRunnerReceipt = {
    schemaVersion: 1,
    kind: 'agent-saas-admin-runner-receipt',
    invocationId: newInvocationId(),
    command: rawCommand && COMMAND_NAME_PATTERN.test(rawCommand) ? rawCommand : '(invalid)',
    environment: 'unidentified',
    writeIntents: [],
    escalationFlags: [],
    argsSummary: summarizeArgs([]),
    targetOverrides: [],
    authorizationForwarded: false,
    actor: actorFromEnv(deps.env),
    startedAt,
    result: 'started',
  };

  let launcherPath: string;
  try {
    launcherPath = fileURLToPath(deps.launcherUrl);
  } catch {
    deps.stderr(
      '[admin-launcher] rejected launcher_internal: launcher location could not be resolved',
    );
    return EXIT_REJECTED;
  }
  const adminDir = dirname(launcherPath);
  const releaseRoot = resolve(adminDir, '..', '..');
  let releaseRealRoot: string;
  try {
    releaseRealRoot = await deps.receiptFs.realpath(releaseRoot);
  } catch {
    deps.stderr(
      '[admin-launcher] rejected launcher_internal: release directory could not be resolved',
    );
    return EXIT_REJECTED;
  }

  // 1. 回执目录：绝对化 + realpath（最近现存祖先），且必须在密封 release 树之外。
  const rawReceiptDir = deps.env[RECEIPT_DIR_ENV]?.trim();
  if (!rawReceiptDir) {
    deps.stderr(
      `[admin-launcher] rejected receipt_dir_unavailable: ${RECEIPT_DIR_ENV} must point to a writable directory outside the release tree`,
    );
    return EXIT_REJECTED;
  }
  const receiptDir = resolve(deps.cwd, rawReceiptDir);
  const receiptRealDir = await realpathOfNearestExisting(receiptDir, deps.receiptFs.realpath);
  if (
    isInsideDirectory(releaseRoot, receiptDir) ||
    isInsideDirectory(releaseRealRoot, receiptRealDir)
  ) {
    deps.stderr(
      `[admin-launcher] rejected receipt_dir_unavailable: ${RECEIPT_DIR_ENV} must not be inside the sealed release directory`,
    );
    return EXIT_REJECTED;
  }
  const writeOptions = { forbiddenRealRoot: releaseRealRoot };

  let phase: Phase = 'preflight';
  let interruptedBy: NodeJS.Signals | undefined;
  let child: SpawnedProcess | undefined;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => {
      if (phase === 'finishing') return;
      interruptedBy ??= signal;
      if (phase === 'running') child?.kill(signal);
    };
    listeners.set(signal, listener);
    deps.signals.on(signal, listener);
  }
  const releaseSignals = () => {
    for (const [signal, listener] of listeners) deps.signals.off(signal, listener);
    listeners.clear();
  };

  const finish = async (
    patch: Partial<AdminRunnerReceipt> & Pick<AdminRunnerReceipt, 'result'>,
  ): Promise<number> => {
    phase = 'finishing';
    // 预检期收到的取消优先于普通拒绝：操作者要的是“停”，不是某个门禁的结论。
    const effective =
      interruptedBy && patch.result === 'rejected'
        ? {
            result: 'cancelled' as const,
            signal: interruptedBy,
            errorCategory: 'script_signal' as const,
            errorDetail: undefined,
          }
        : patch;
    Object.assign(receipt, effective, { finishedAt: deps.now().toISOString() });
    // 脱敏双保险拒写时逐级撤掉自由文本字段再试；仍失败才放弃。
    const scrubs: Array<() => void> = [
      () => {
        receipt.errorDetail = REDACTED_DETAIL;
      },
      () => {
        delete receipt.authorizationRef;
        receipt.command = '(withheld)';
      },
    ];
    let receiptPath: string | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= scrubs.length && receiptPath === undefined; attempt += 1) {
      try {
        receiptPath = await writeReceiptAtomically(
          receiptDir,
          receipt,
          deps.receiptFs,
          writeOptions,
        );
      } catch (error) {
        lastError = error;
        if (attempt < scrubs.length) scrubs[attempt]!();
      }
    }
    releaseSignals();
    if (receiptPath === undefined) {
      deps.stderr(
        `[admin-launcher] receipt write failed (${lastError instanceof Error ? lastError.message : String(lastError)}); result was ${receipt.result}${receipt.errorCategory ? ` ${receipt.errorCategory}` : ''}`,
      );
      return EXIT_RECEIPT_FAILED;
    }
    summarize(deps, receipt, receiptPath);
    if (receipt.result === 'rejected') return EXIT_REJECTED;
    if (receipt.result === 'cancelled') return 128 + signalNumber(receipt.signal);
    if (receipt.result === 'succeeded') return 0;
    return receipt.exitCode && receipt.exitCode > 0 ? receipt.exitCode : 1;
  };
  const reject = (category: ReceiptErrorCategory, detail: string): Promise<number> =>
    finish({ result: 'rejected', errorCategory: category, errorDetail: detail });
  const cancelledDuringPreflight = (): Promise<number> | undefined =>
    interruptedBy
      ? finish({ result: 'cancelled', signal: interruptedBy, errorCategory: 'script_signal' })
      : undefined;

  let invocation: LauncherInvocation;
  let manifest: AdminRunnerManifest;
  let command: ManifestCommand;
  try {
    invocation = parseLauncherArgv(argv);
    manifest = await loadManifest(deps, adminDir);
    await verifyFile(deps, launcherPath, manifest.launcher, 'launcher');
    receipt.launcherDigest = manifest.launcher.digest;
    await verifyFile(
      deps,
      resolve(adminDir, manifest.runtimeDependencyGuard.entry),
      manifest.runtimeDependencyGuard,
      'runtime dependency guard',
    );
    await verifyFile(
      deps,
      resolve(adminDir, manifest.governanceBootstrap.entry),
      manifest.governanceBootstrap,
      'governance bootstrap',
    );
    const found = findManifestCommand(manifest, invocation.command);
    if (!found) throw new LauncherRejection('unknown_command', 'command is not in the manifest');
    command = found;
    receipt.entry = command.entry;
    receipt.riskLevel = command.governance.riskLevel;
    receipt.defaultMode = command.governance.defaultMode;
    await verifyFile(deps, join(adminDir, command.entry), command, `entry ${command.entry}`);
    receipt.entryDigest = command.digest;
  } catch (error) {
    if (error instanceof LauncherRejection) return reject(error.category, error.message);
    return reject('launcher_internal', 'preflight failed unexpectedly');
  }

  const classification = classifyInvocation(command.governance, invocation.scriptArgs);
  receipt.mode = classification.mode;
  receipt.writeIntents = classification.writeIntents;
  receipt.escalationFlags = classification.escalationFlags;
  receipt.argsSummary = classification.argsSummary;
  receipt.targetOverrides = detectTargetOverrides(deps.env, invocation.scriptArgs);
  const missing = missingRequiredFlags(command.governance, invocation.scriptArgs);
  if (missing.length > 0) {
    return reject('invalid_arguments', `required flag missing: ${missing.join(', ')}`);
  }
  for (const problem of classification.problems) {
    if (problem.category === 'escalation_without_write') {
      return reject(
        'escalation_without_write',
        `${problem.flag} requires ${problem.requiresWriteIntent}`,
      );
    }
    return reject(
      'authorization_ref_misplaced',
      `${AUTHORIZATION_REF_FLAG} must be given to the launcher, before --`,
    );
  }
  let authorizationRef: string | undefined;
  try {
    authorizationRef = normalizeAuthorizationRef(invocation.authorizationRef);
  } catch (error) {
    return reject('authorization_ref_invalid', error instanceof Error ? error.message : 'invalid');
  }
  if (authorizationRef) receipt.authorizationRef = authorizationRef;
  if (classification.mode === 'write' && !authorizationRef) {
    return reject(
      'write_flag_without_authorization',
      `write intent ${classification.writeIntents.join(', ')} requires ${AUTHORIZATION_REF_FLAG} <ticket>`,
    );
  }

  let runtimeIdentity: RuntimeIdentity;
  try {
    runtimeIdentity = resolveRuntimeIdentity(deps.env);
  } catch (error) {
    if (error instanceof LauncherRejection) return reject(error.category, error.message);
    throw error;
  }
  receipt.environment = runtimeIdentity.environment;
  if (!command.governance.supportedEnvironments.includes(runtimeIdentity.environment)) {
    return reject(
      'environment_unsupported',
      `${invocation.command} is not supported in ${runtimeIdentity.environment}`,
    );
  }

  let runtimeDependenciesJson: string | undefined;
  try {
    runtimeDependenciesJson = (
      await deps.readFile(join(releaseRoot, 'runtime-dependencies.json'))
    ).toString('utf8');
  } catch {
    runtimeDependenciesJson = undefined;
  }
  const release = checkReleaseIdentity({
    runtimeIdentity,
    runtimeDependenciesJson,
    manifestDependencyContractDigest: manifest.dependencyContractDigest,
  });
  receipt.release = release;
  if (!releaseIdentityAllowed(runtimeIdentity.environment, release)) {
    return reject(
      release.status === 'mismatch' ? 'release_identity_mismatch' : 'release_identity_missing',
      `release identity ${release.status}${release.reason ? ` (${release.reason})` : ''}`,
    );
  }
  const cancelled = cancelledDuringPreflight();
  if (cancelled) return cancelled;

  // 预检与子进程必须读同一份配置：绝对化一次，同时喂给 CLI 与子进程 env。
  const configPath = resolveConfigPath(deps.env, releaseRoot, deps.cwd);
  const configIdentity = await observeConfigIdentity(
    deps,
    releaseRoot,
    configPath,
    runtimeIdentity.environment,
    invocation,
    runtimeIdentity,
  );
  const cancelledAfterObservation = cancelledDuringPreflight();
  if (cancelledAfterObservation) return cancelledAfterObservation;
  const gate = decideConfigIdentityGate(
    runtimeIdentity.environment,
    classification.mode,
    configIdentity,
  );
  receipt.configIdentity = {
    ...configIdentity,
    gate: gate.allowed ? (gate.annotated ? 'annotated' : 'passed') : 'rejected',
  };
  if (!gate.allowed) {
    return reject(
      configIdentity.status === 'drifted'
        ? 'config_identity_drifted'
        : 'config_identity_unverifiable',
      `config identity ${configIdentity.status}${configIdentity.reason ? ` (${configIdentity.reason})` : ''} blocks ${classification.mode} in ${runtimeIdentity.environment}`,
    );
  }

  // 预检全部通过：先落 started 回执，再执行。
  try {
    await writeReceiptAtomically(receiptDir, receipt, deps.receiptFs, writeOptions);
  } catch (error) {
    releaseSignals();
    deps.stderr(
      `[admin-launcher] receipt write failed before execution (${error instanceof Error ? error.message : String(error)})`,
    );
    return EXIT_RECEIPT_FAILED;
  }
  const cancelledAfterStarted = cancelledDuringPreflight();
  if (cancelledAfterStarted) return cancelledAfterStarted;

  const forwardedArgs = [...invocation.scriptArgs];
  if (command.governance.acceptsAuthorizationRef && authorizationRef) {
    forwardedArgs.push(AUTHORIZATION_REF_FLAG, authorizationRef);
    receipt.authorizationForwarded = true;
  }
  const nonce = deps.nonce();
  const markerDir = join(receiptDir, '.launch');
  const markerPath = join(markerDir, `${nonce}.json`);
  try {
    await deps.receiptFs.mkdir(markerDir, { recursive: true, mode: 0o700 });
    const realMarkerDir = await deps.receiptFs.realpath(markerDir);
    if (isInsideDirectory(releaseRealRoot, realMarkerDir)) {
      throw new Error('marker directory resolves inside the sealed release directory');
    }
    await deps.receiptFs.writeFile(
      markerPath,
      `${JSON.stringify({ entry: command.entry, command: command.command, invocationId: receipt.invocationId })}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  } catch {
    return finish({
      result: 'rejected',
      errorCategory: 'receipt_dir_unavailable',
      errorDetail: 'launch marker could not be created under the receipt directory',
    });
  }
  const preSpawnCancel = cancelledDuringPreflight();
  if (preSpawnCancel) {
    await deps.receiptFs.unlink(markerPath).catch(() => undefined);
    return preSpawnCancel;
  }

  phase = 'running';
  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: string;
  }>((resolvePromise) => {
    try {
      child = deps.spawn(deps.nodePath, [join(adminDir, command.entry), ...forwardedArgs], {
        cwd: releaseRoot,
        env: {
          ...deps.env,
          [LAUNCH_NONCE_ENV]: nonce,
          [RECEIPT_DIR_ENV]: receiptDir,
          [CONFIG_PATH_ENV]: configPath,
        },
        stdio: 'inherit',
      });
    } catch (error) {
      resolvePromise({
        code: null,
        signal: null,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (interruptedBy) child.kill(interruptedBy);
    child.on('error', (error) =>
      resolvePromise({ code: null, signal: null, spawnError: error.message }),
    );
    child.on('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  phase = 'finishing';

  await deps.receiptFs.unlink(markerPath).catch(() => undefined);

  if (outcome.spawnError !== undefined) {
    return finish({
      result: 'failed',
      errorCategory: 'script_spawn_failed',
      errorDetail: 'entry process could not be started',
      exitCode: 1,
    });
  }
  if (interruptedBy || outcome.signal) {
    const signal = interruptedBy ?? outcome.signal!;
    return finish({
      result: 'cancelled',
      signal,
      errorCategory: 'script_signal',
      ...(outcome.code !== null ? { exitCode: outcome.code } : {}),
    });
  }
  if (outcome.code === 0) return finish({ result: 'succeeded', exitCode: 0 });
  return finish({
    result: 'failed',
    exitCode: outcome.code ?? 1,
    errorCategory: 'script_exit_nonzero',
    errorDetail:
      'script exited non-zero; its own gate rejection and runtime failure are not distinguished here',
  });
}

export function defaultLauncherDeps(launcherUrl: string): LauncherDeps {
  return {
    env: process.env,
    launcherUrl,
    cwd: process.cwd(),
    nodePath: process.execPath,
    readFile: (path) => readFile(path),
    receiptFs: { mkdir, writeFile, rename, unlink, realpath: (path) => realpath(path) },
    spawn: (file, args, options) => spawn(file, args, options),
    runConfigIdentityCli: (file, args, options) =>
      new Promise((resolvePromise, rejectPromise) => {
        execFile(
          file,
          args,
          { cwd: options.cwd, env: options.env, maxBuffer: 1024 * 1024, timeout: 60_000 },
          (error, stdout, stderr) => {
            if (error && typeof (error as { code?: unknown }).code === 'number') {
              resolvePromise({
                code: (error as { code: number }).code,
                stdout: String(stdout),
                stderr: String(stderr),
              });
              return;
            }
            if (error) {
              rejectPromise(new Error('config-identity-cli could not be executed'));
              return;
            }
            resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      }),
    now: () => new Date(),
    nonce: () => randomBytes(16).toString('hex'),
    stderr: (line) => process.stderr.write(`${line}\n`),
    signals: {
      on: (signal, listener) => process.on(signal, listener),
      off: (signal, listener) => process.off(signal, listener),
    },
  };
}
