/**
 * Admin Runner manifest（schemaVersion 2）读取与严格校验。
 *
 * 唯一真相源是 `server/scripts/admin-runner-entries.mjs`；build 把它写进
 * `dist/admin/manifest.json`。launcher 只信任通过本文件校验的 manifest：任何
 * 未知字段、缺失字段、非法枚举都 fail closed，不做宽松兼容。
 */

export const ADMIN_RUNNER_MANIFEST_KIND = 'agent-saas-admin-runner';
export const ADMIN_RUNNER_MANIFEST_SCHEMA_VERSION = 2;

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export const DEFAULT_MODES = ['read_only', 'dry_run'] as const;
export const IDEMPOTENCY = ['idempotent', 'resumable', 'one_shot'] as const;
export const SUPPORTED_ENVIRONMENTS = ['production', 'staging', 'development', 'test'] as const;
export const CONFIG_REQUIREMENTS = [
  'app_config',
  'pg_connection',
  'transcripts_root',
  'release_layout',
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
export type DefaultMode = (typeof DEFAULT_MODES)[number];
export type Idempotency = (typeof IDEMPOTENCY)[number];
export type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];
export type ConfigRequirement = (typeof CONFIG_REQUIREMENTS)[number];

export interface WriteIntentSpec {
  flag: string;
  riskLevel: RiskLevel;
  description: string;
}

export interface EscalationFlagSpec {
  flag: string;
  requiresWriteIntent: string;
  riskLevel: RiskLevel;
  description: string;
}

export interface CommandGovernance {
  riskLevel: RiskLevel;
  defaultMode: DefaultMode;
  writeIntents: WriteIntentSpec[];
  escalationFlags: EscalationFlagSpec[];
  acceptsAuthorizationRef: boolean;
  idempotency: Idempotency;
  /** 只是脚本依赖的声明，launcher 不据此做任何检查（见 docs/admin-runner.md §2）。 */
  configRequirements: ConfigRequirement[];
  supportedEnvironments: SupportedEnvironment[];
  /** 必须出现在脚本参数中的 flag（精确名或 `--flag=value`），缺失即 invalid_arguments。 */
  requiredFlags: string[];
}

export interface ManifestFile {
  entry: string;
  digest: string;
  size: number;
}

export interface ManifestCommand extends ManifestFile {
  command: string;
  source: string;
  description: string;
  governance: CommandGovernance;
}

export interface AdminRunnerManifest {
  schemaVersion: typeof ADMIN_RUNNER_MANIFEST_SCHEMA_VERSION;
  kind: typeof ADMIN_RUNNER_MANIFEST_KIND;
  dependencyContractDigest: string;
  runtimeDependencyGuard: ManifestFile;
  governanceBootstrap: ManifestFile;
  launcher: ManifestFile & { source: string };
  commands: ManifestCommand[];
}

export class AdminRunnerManifestError extends Error {
  constructor(message: string) {
    super(`Admin Runner manifest invalid: ${message}`);
    this.name = 'AdminRunnerManifestError';
  }
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FLAG_PATTERN = /^--[a-z][a-z0-9-]*$/u;
const COMMAND_PATTERN = /^[a-z0-9-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AdminRunnerManifestError(
      `${label} keys drifted: expected [${expected.join(', ')}] got [${actual.join(', ')}]`,
    );
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AdminRunnerManifestError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new AdminRunnerManifestError(`${label} must be one of ${allowed.join('|')}`);
  }
  return value as T;
}

function requireEnumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T[] {
  if (!Array.isArray(value)) throw new AdminRunnerManifestError(`${label} must be an array`);
  const items = value.map((item) => requireEnum(item, allowed, label));
  if (new Set(items).size !== items.length) {
    throw new AdminRunnerManifestError(`${label} must not repeat`);
  }
  return items;
}

function requireFlag(value: unknown, label: string): string {
  const flag = requireString(value, label);
  if (!FLAG_PATTERN.test(flag)) throw new AdminRunnerManifestError(`${label} must be a --flag`);
  return flag;
}

function parseFile(value: unknown, label: string, expectedEntry?: string): ManifestFile {
  if (!isRecord(value)) throw new AdminRunnerManifestError(`${label} must be an object`);
  requireKeys(value, ['entry', 'digest', 'size'], label);
  const entry = requireString(value.entry, `${label}.entry`);
  if (expectedEntry && entry !== expectedEntry) {
    throw new AdminRunnerManifestError(`${label}.entry must be ${expectedEntry}`);
  }
  const digest = requireString(value.digest, `${label}.digest`);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new AdminRunnerManifestError(`${label}.digest must be a sha256 digest`);
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) {
    throw new AdminRunnerManifestError(`${label}.size must be a positive integer`);
  }
  return { entry, digest, size: value.size as number };
}

export function parseCommandGovernance(value: unknown, label: string): CommandGovernance {
  if (!isRecord(value)) throw new AdminRunnerManifestError(`${label} governance must be an object`);
  requireKeys(
    value,
    [
      'riskLevel',
      'defaultMode',
      'writeIntents',
      'escalationFlags',
      'acceptsAuthorizationRef',
      'idempotency',
      'configRequirements',
      'supportedEnvironments',
      'requiredFlags',
    ],
    `${label} governance`,
  );
  if (!Array.isArray(value.writeIntents)) {
    throw new AdminRunnerManifestError(`${label} writeIntents must be an array`);
  }
  const writeIntents: WriteIntentSpec[] = value.writeIntents.map((intent, index) => {
    if (!isRecord(intent)) {
      throw new AdminRunnerManifestError(`${label} writeIntents[${index}] must be an object`);
    }
    requireKeys(intent, ['flag', 'riskLevel', 'description'], `${label} writeIntents[${index}]`);
    return {
      flag: requireFlag(intent.flag, `${label} writeIntents[${index}].flag`),
      riskLevel: requireEnum(intent.riskLevel, RISK_LEVELS, `${label} writeIntent riskLevel`),
      description: requireString(intent.description, `${label} writeIntent description`),
    };
  });
  const writeFlags = new Set(writeIntents.map((intent) => intent.flag));
  if (writeFlags.size !== writeIntents.length) {
    throw new AdminRunnerManifestError(`${label} write intents repeat a flag`);
  }
  if (!Array.isArray(value.escalationFlags)) {
    throw new AdminRunnerManifestError(`${label} escalationFlags must be an array`);
  }
  const escalationFlags: EscalationFlagSpec[] = value.escalationFlags.map((escalation, index) => {
    if (!isRecord(escalation)) {
      throw new AdminRunnerManifestError(`${label} escalationFlags[${index}] must be an object`);
    }
    requireKeys(
      escalation,
      ['flag', 'requiresWriteIntent', 'riskLevel', 'description'],
      `${label} escalationFlags[${index}]`,
    );
    const flag = requireFlag(escalation.flag, `${label} escalation flag`);
    if (writeFlags.has(flag)) {
      throw new AdminRunnerManifestError(
        `${label} escalation ${flag} collides with a write intent`,
      );
    }
    const requiresWriteIntent = requireFlag(
      escalation.requiresWriteIntent,
      `${label} escalation requiresWriteIntent`,
    );
    if (!writeFlags.has(requiresWriteIntent)) {
      throw new AdminRunnerManifestError(
        `${label} escalation ${flag} requires an undeclared write intent`,
      );
    }
    return {
      flag,
      requiresWriteIntent,
      riskLevel: requireEnum(escalation.riskLevel, RISK_LEVELS, `${label} escalation riskLevel`),
      description: requireString(escalation.description, `${label} escalation description`),
    };
  });
  if (typeof value.acceptsAuthorizationRef !== 'boolean') {
    throw new AdminRunnerManifestError(`${label} acceptsAuthorizationRef must be boolean`);
  }
  const defaultMode = requireEnum(value.defaultMode, DEFAULT_MODES, `${label} defaultMode`);
  if (defaultMode === 'dry_run' && writeIntents.length === 0) {
    throw new AdminRunnerManifestError(`${label} declares dry_run without a write intent`);
  }
  const supportedEnvironments = requireEnumList(
    value.supportedEnvironments,
    SUPPORTED_ENVIRONMENTS,
    `${label} supportedEnvironments`,
  );
  if (supportedEnvironments.length === 0) {
    throw new AdminRunnerManifestError(`${label} must support at least one environment`);
  }
  if (!Array.isArray(value.requiredFlags)) {
    throw new AdminRunnerManifestError(`${label} requiredFlags must be an array`);
  }
  const requiredFlags = value.requiredFlags.map((flag, index) =>
    requireFlag(flag, `${label} requiredFlags[${index}]`),
  );
  if (new Set(requiredFlags).size !== requiredFlags.length) {
    throw new AdminRunnerManifestError(`${label} requiredFlags must not repeat`);
  }
  for (const flag of requiredFlags) {
    if (writeFlags.has(flag)) {
      throw new AdminRunnerManifestError(
        `${label} required flag ${flag} must not be a write intent`,
      );
    }
  }
  return {
    requiredFlags,
    riskLevel: requireEnum(value.riskLevel, RISK_LEVELS, `${label} riskLevel`),
    defaultMode,
    writeIntents,
    escalationFlags,
    acceptsAuthorizationRef: value.acceptsAuthorizationRef,
    idempotency: requireEnum(value.idempotency, IDEMPOTENCY, `${label} idempotency`),
    configRequirements: requireEnumList(
      value.configRequirements,
      CONFIG_REQUIREMENTS,
      `${label} configRequirements`,
    ),
    supportedEnvironments,
  };
}

export function parseAdminRunnerManifest(raw: unknown): AdminRunnerManifest {
  if (!isRecord(raw)) throw new AdminRunnerManifestError('document must be an object');
  requireKeys(
    raw,
    [
      'schemaVersion',
      'kind',
      'dependencyContractDigest',
      'runtimeDependencyGuard',
      'governanceBootstrap',
      'launcher',
      'commands',
    ],
    'document',
  );
  if (raw.schemaVersion !== ADMIN_RUNNER_MANIFEST_SCHEMA_VERSION) {
    throw new AdminRunnerManifestError(
      `schemaVersion must be ${ADMIN_RUNNER_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (raw.kind !== ADMIN_RUNNER_MANIFEST_KIND) {
    throw new AdminRunnerManifestError(`kind must be ${ADMIN_RUNNER_MANIFEST_KIND}`);
  }
  const dependencyContractDigest = requireString(
    raw.dependencyContractDigest,
    'dependencyContractDigest',
  );
  if (!DIGEST_PATTERN.test(dependencyContractDigest)) {
    throw new AdminRunnerManifestError('dependencyContractDigest must be a sha256 digest');
  }
  const runtimeDependencyGuard = parseFile(
    raw.runtimeDependencyGuard,
    'runtimeDependencyGuard',
    '../runtime-dependency-admin-guard.mjs',
  );
  const governanceBootstrap = parseFile(
    raw.governanceBootstrap,
    'governanceBootstrap',
    '../admin-governance-bootstrap.mjs',
  );
  if (!isRecord(raw.launcher)) throw new AdminRunnerManifestError('launcher must be an object');
  requireKeys(raw.launcher, ['entry', 'source', 'digest', 'size'], 'launcher');
  const launcher = {
    ...parseFile(
      { entry: raw.launcher.entry, digest: raw.launcher.digest, size: raw.launcher.size },
      'launcher',
      'launcher.mjs',
    ),
    source: requireString(raw.launcher.source, 'launcher.source'),
  };
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) {
    throw new AdminRunnerManifestError('commands must be a non-empty array');
  }
  const commands: ManifestCommand[] = raw.commands.map((command, index) => {
    if (!isRecord(command)) {
      throw new AdminRunnerManifestError(`commands[${index}] must be an object`);
    }
    requireKeys(
      command,
      ['command', 'entry', 'source', 'description', 'governance', 'digest', 'size'],
      `commands[${index}]`,
    );
    const name = requireString(command.command, `commands[${index}].command`);
    if (!COMMAND_PATTERN.test(name)) {
      throw new AdminRunnerManifestError(`commands[${index}].command has invalid characters`);
    }
    const file = parseFile(
      { entry: command.entry, digest: command.digest, size: command.size },
      `commands[${index}]`,
      `${name}.mjs`,
    );
    return {
      ...file,
      command: name,
      source: requireString(command.source, `commands[${index}].source`),
      description: requireString(command.description, `commands[${index}].description`),
      governance: parseCommandGovernance(command.governance, `command ${name}`),
    };
  });
  const names = commands.map((command) => command.command);
  if (new Set(names).size !== names.length) {
    throw new AdminRunnerManifestError('commands repeat a command name');
  }
  return {
    schemaVersion: ADMIN_RUNNER_MANIFEST_SCHEMA_VERSION,
    kind: ADMIN_RUNNER_MANIFEST_KIND,
    dependencyContractDigest,
    runtimeDependencyGuard,
    governanceBootstrap,
    launcher,
    commands,
  };
}

export function findManifestCommand(
  manifest: AdminRunnerManifest,
  command: string,
): ManifestCommand | undefined {
  return manifest.commands.find((candidate) => candidate.command === command);
}
