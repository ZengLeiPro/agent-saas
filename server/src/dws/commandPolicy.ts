import {
  DWS_COMMAND_FILE_FLAGS_BY_CLI_VERSION,
  DWS_COMMAND_POLICY_BY_CLI_VERSION,
  DWS_COMMAND_POLICY_CATALOGS,
  type DwsCommandFileFlagPolicy,
  type DwsCommandPolicyCode,
} from './generated/commandPolicy.js';
import {
  DWS_READ_COMMAND_OVERRIDES,
  DWS_WRITE_COMMAND_OVERRIDES,
} from './commandPolicyOverrides.js';
import { DWS_ACTIVE_CLI_VERSION } from './commandPolicyVersion.js';

const ALLOWED_MODULES = new Set([
  'agoal',
  'aisearch',
  'aitable',
  'approval',
  'attendance',
  'auth',
  'axls',
  'bot',
  'calendar',
  'chat',
  'contact',
  'devdoc',
  'ding',
  'doc',
  'drive',
  'kb',
  'mail',
  'minutes',
  'oa',
  'report',
  'sheet',
  'table',
  'todo',
  'wiki',
]);

const DESTRUCTIVE_VERBS = new Set([
  'agree',
  'approve',
  'clear',
  'delete',
  'dismiss',
  'kick',
  'pass',
  'purge',
  'recall',
  'reject',
  'remove',
  'revoke',
  'transfer',
  'truncate',
  'withdraw',
]);
const FORBIDDEN_VERBS = new Set([
  'auth',
  'consume',
  'credential',
  'download',
  'exec',
  'export',
  'import',
  'login',
  'logout',
  'pat',
  'serve',
  'shell',
  'token',
  'upload',
  'watch',
]);
const FORBIDDEN_FLAGS =
  /^(?:-p|--profile|--token|--access-token|--refresh-token|--config-dir|--keychain-dir|--client-id|--client-secret|--action|--operation|--method|--command|--output|--out|--output-dir|--download-dir|--file|--path|--dir|--directory)(?:=|$)/;

export type DwsCommandPolicySource =
  | 'cli_schema'
  | 'legacy_read_table'
  | 'legacy_write_table'
  | 'auth_status'
  | 'platform_boundary'
  | 'unregistered';

export interface ClassifiedDwsCommand {
  module: string;
  commandPath: string;
  risk: 'read' | 'write';
  policySource: DwsCommandPolicySource;
}

export class DwsCommandPolicyError extends Error {
  constructor(
    message: string,
    readonly commandPath: string | undefined,
    readonly policySource: DwsCommandPolicySource,
  ) {
    super(message);
    this.name = 'DwsCommandPolicyError';
  }
}

export { DWS_ACTIVE_CLI_VERSION };
export const DWS_COMMAND_POLICY_CLI_VERSIONS = Object.freeze(
  DWS_COMMAND_POLICY_CATALOGS.map((catalog) => catalog.cliVersion),
);
const DWS_ACTIVE_COMMAND_POLICY: Readonly<Record<string, DwsCommandPolicyCode>> =
  DWS_COMMAND_POLICY_BY_CLI_VERSION[DWS_ACTIVE_CLI_VERSION];
const DWS_ACTIVE_COMMAND_FILE_FLAGS: DwsCommandFileFlagPolicy =
  DWS_COMMAND_FILE_FLAGS_BY_CLI_VERSION[DWS_ACTIVE_CLI_VERSION];

function isForbiddenDwsFlag(arg: string): boolean {
  if (FORBIDDEN_FLAGS.test(arg)) return true;
  if (!arg.startsWith('-')) return false;
  const name = arg.split('=', 1)[0]!.toLowerCase();
  if (
    /(?:^|-)(?:file|path|attachment|media|image)(?:-|$)/.test(name) &&
    !/(?:^|-)(?:file|attachment|media|image)-ids?$/.test(name)
  )
    return true;
  return /(?:^|-)(?:local|source-file|contents-file|template-file)(?:-|$)/.test(name);
}

function isForbiddenDwsValue(arg: string): boolean {
  const separator = arg.startsWith('-') ? arg.indexOf('=') : -1;
  const value = separator >= 0 ? arg.slice(separator + 1) : arg;
  return (value.startsWith('@') && value.length > 1) || /^file:\/\//i.test(value);
}

function hasForbiddenDwsCatalogFileFlag(commandPath: string, trailingArgs: string[]): boolean {
  const policy = DWS_ACTIVE_COMMAND_FILE_FLAGS[commandPath];
  if (!policy) return false;
  for (let index = 0; index < trailingArgs.length; index += 1) {
    const arg = trailingArgs[index]!;
    if (!arg.startsWith('--')) continue;
    const separator = arg.indexOf('=');
    const name = arg.slice(2, separator >= 0 ? separator : undefined).toLowerCase();
    const mode = policy[name];
    if (!mode) continue;
    if (mode === 'path') return true;
    const value = separator >= 0 ? arg.slice(separator + 1) : trailingArgs[index + 1];
    if (value === '-' || (value !== undefined && isForbiddenDwsValue(value))) return true;
  }
  return false;
}

function manifestPolicy(
  policyCode: DwsCommandPolicyCode,
  module: string,
  commandPath: string,
  pathTokens: string[],
): ClassifiedDwsCommand {
  if (policyCode === 'r') {
    return { module, commandPath, risk: 'read', policySource: 'cli_schema' };
  }
  if (policyCode === 'w') {
    if (pathTokens.some((token) => DESTRUCTIVE_VERBS.has(token))) {
      throw new DwsCommandPolicyError(
        'DWS 破坏性或高影响动作本阶段未开放',
        commandPath,
        'platform_boundary',
      );
    }
    return { module, commandPath, risk: 'write', policySource: 'cli_schema' };
  }
  throw new DwsCommandPolicyError(
    policyCode === 'u' ? 'DWS 命令在当前 CLI 契约中不可用' : 'DWS 破坏性或高影响动作本阶段未开放',
    commandPath,
    'cli_schema',
  );
}

export function classifyDwsBusinessCommand(args: string[]): ClassifiedDwsCommand {
  if (args.length < 2) {
    throw new DwsCommandPolicyError('DWS 命令路径不完整', undefined, 'unregistered');
  }
  for (const arg of args) {
    if (/[\u0000-\u001F\u007F]/.test(arg) || isForbiddenDwsFlag(arg) || isForbiddenDwsValue(arg)) {
      throw new DwsCommandPolicyError('DWS 命令包含受限参数', undefined, 'platform_boundary');
    }
  }

  const module = args[0]!.toLowerCase();
  if (!ALLOWED_MODULES.has(module)) {
    throw new DwsCommandPolicyError(
      'DWS 模块未登记或不允许由 Broker 执行',
      module,
      'platform_boundary',
    );
  }
  const firstFlagIndex = args.findIndex((token) => token.startsWith('-'));
  const commandTokens = args
    .slice(0, firstFlagIndex < 0 ? args.length : firstFlagIndex)
    .map((token) => token.toLowerCase().replace(/^\+/, ''));
  const commandPath = commandTokens.join('.');
  const pathTokens = commandTokens.flatMap((token) => token.split('-').filter(Boolean));
  const trailingArgs = firstFlagIndex < 0 ? [] : args.slice(firstFlagIndex);
  if (hasForbiddenDwsCatalogFileFlag(commandPath, trailingArgs)) {
    throw new DwsCommandPolicyError('DWS 命令包含本地文件参数', commandPath, 'platform_boundary');
  }
  const flagNameTokens = trailingArgs
    .filter((token) => token.startsWith('-'))
    .flatMap((token) => token.split('=', 1)[0]!.toLowerCase().split('-').filter(Boolean));
  if (flagNameTokens.some((token) => DESTRUCTIVE_VERBS.has(token))) {
    throw new DwsCommandPolicyError(
      'DWS 破坏性或高影响动作本阶段未开放',
      commandPath,
      'platform_boundary',
    );
  }

  const isAuthStatus =
    commandPath === 'auth.status' &&
    trailingArgs.every(
      (token) =>
        token === '--help' ||
        token === '-h' ||
        token === '--format' ||
        token === '-f' ||
        token === 'json',
    );
  if (isAuthStatus) return { module, commandPath, risk: 'read', policySource: 'auth_status' };

  if (pathTokens.some((token) => FORBIDDEN_VERBS.has(token))) {
    throw new DwsCommandPolicyError(
      'DWS 命令超出业务 Broker 边界',
      commandPath,
      'platform_boundary',
    );
  }

  // 仅已复核的同名查询可先于 destructive 路径检查；所有其他平台边界均先于 manifest。
  if (DWS_READ_COMMAND_OVERRIDES.has(commandPath)) {
    return { module, commandPath, risk: 'read', policySource: 'legacy_read_table' };
  }
  if (pathTokens.some((token) => DESTRUCTIVE_VERBS.has(token))) {
    throw new DwsCommandPolicyError(
      'DWS 破坏性或高影响动作本阶段未开放',
      commandPath,
      'platform_boundary',
    );
  }
  if (DWS_WRITE_COMMAND_OVERRIDES.has(commandPath)) {
    return { module, commandPath, risk: 'write', policySource: 'legacy_write_table' };
  }

  const manifestPolicyCode = DWS_ACTIVE_COMMAND_POLICY[commandPath];
  if (manifestPolicyCode) {
    return manifestPolicy(manifestPolicyCode, module, commandPath, pathTokens);
  }
  throw new DwsCommandPolicyError(
    'DWS 动作未登记风险等级，已拒绝执行',
    commandPath,
    'unregistered',
  );
}
