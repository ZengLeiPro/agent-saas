/**
 * Config identity CLI（TASK-318）。
 *
 * 部署脚本在发布主机上调用它，把实际 config.json 的 expected identity 写入
 * release env。projection/digest 与运行期共用同一实现，禁止脚本另写一套算法。
 *
 * 用法：
 *   node dist/config-identity-cli.js \
 *     --config /etc/agent-saas/config.json \
 *     --environment production \
 *     --process-cwd /opt/agent-saas-app/color/blue/server \
 *     --runtime-data-dir /mnt/agent-saas/server-data \
 *     --env-file /etc/agent-saas/server.env
 *
 * `--runtime-data-dir` 用于 systemd BindPaths 场景：服务内的 `<cwd>/data` 在
 * 发布脚本进程外对应持久主机目录，不能误读 release artifact 自带的 data。
 * 显式运维覆盖只接受 `--vault-file/--vault-key-env <ENV_NAME>`；密钥值禁止
 * 进入 argv（会暴露在进程列表与 /proc）。
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';

import { parseAppConfig, type AppConfig } from '../app/config.js';
import { assertAuxiliaryModelRefsResolvable } from '../app/modelsHotUpdate.js';
import {
  EncryptedFileSecretVault,
  HttpSecretVault,
  type SecretVault,
} from '../security/secretVault.js';
import {
  assertProductionManagedCredentialSafety,
  computeObservedConfigIdentity,
  CONFIG_IDENTITY_SCHEMA_VERSION,
  type ConfigIdentityObservation,
} from './configIdentity.js';

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error('Invalid arguments: expected --name value pairs');
    }
    output[key.slice(2)] = value;
  }
  return output;
}

function loadConfig(configPath: string): AppConfig {
  const raw = parseJsonc(readFileSync(configPath, 'utf-8'));
  return parseAppConfig(raw);
}

export function readEnvironmentFile(path: string | undefined): Record<string, string> {
  if (!path) return {};
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function resolveVaultFile(
  filePath: string,
  processCwd: string,
  runtimeDataDir: string | undefined,
): string {
  if (isAbsolute(filePath)) return filePath;
  const normalized = filePath.replace(/^\.\//u, '');
  if (runtimeDataDir && (normalized === 'data' || normalized.startsWith('data/'))) {
    return resolve(runtimeDataDir, normalized === 'data' ? '' : normalized.slice(5));
  }
  return resolve(processCwd, filePath);
}

function resolveEnvironmentValue(
  name: string | undefined,
  fileEnvironment: Record<string, string>,
): string | undefined {
  if (!name) return undefined;
  return process.env[name] ?? fileEnvironment[name];
}

export function buildConfigIdentityVault(
  options: Record<string, string>,
  config: AppConfig,
): SecretVault | undefined {
  if (options['vault-key']) {
    throw new Error(
      '--vault-key is forbidden because argv may expose plaintext; use --vault-key-env',
    );
  }
  const fileEnvironment = readEnvironmentFile(options['env-file']);
  // 显式运维覆盖只传环境变量名；密钥值来自进程环境或受控 EnvironmentFile。
  if (options['vault-file']) {
    const keyEnv = options['vault-key-env'];
    if (!keyEnv) throw new Error('--vault-file requires --vault-key-env <ENV_NAME>');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(keyEnv)) {
      throw new Error('--vault-key-env must be an environment variable name');
    }
    const key = resolveEnvironmentValue(keyEnv, fileEnvironment);
    if (!key || key.length < 16) {
      throw new Error('--vault-key-env resolved to a missing or shorter-than-16 value');
    }
    return new EncryptedFileSecretVault(options['vault-file'], key);
  }
  if (options['vault-key-env']) throw new Error('--vault-key-env requires --vault-file');

  const processCwd = options['process-cwd'] ?? process.cwd();
  const runtimeDataDir = options['runtime-data-dir'];
  const configured = config.secretVault;

  if (configured) {
    if (configured.backend === 'memory') {
      // memory 无跨进程持久版本；Production 有受管 ref 时由调用方 fail closed。
      return undefined;
    }
    if (configured.backend === 'http') {
      const token =
        configured.authToken ?? resolveEnvironmentValue(configured.authTokenEnv, fileEnvironment);
      if (!token || token.length < 8) {
        throw new Error('configured http vault auth token is missing or shorter than 8 characters');
      }
      // HttpSecretVault.inspectRef 使用 metadata-only /secrets/inspect，不拉取明文。
      return new HttpSecretVault({ baseUrl: configured.baseUrl, authToken: token });
    }
    const key =
      configured.encryptionKey ??
      resolveEnvironmentValue(configured.encryptionKeyEnv, fileEnvironment);
    if (!key || key.length < 16) {
      throw new Error(
        'configured encrypted-file vault key is missing or shorter than 16 characters',
      );
    }
    return new EncryptedFileSecretVault(
      resolveVaultFile(configured.filePath, processCwd, runtimeDataDir),
      key,
    );
  }

  // 复刻 runtimeGovernanceCredentials 的 production/PG 默认 vault：
  // <runtime-data-dir>/secrets.enc + JWT 派生 key。
  if (config.runtimeEventStore?.backend !== 'pg') return undefined;
  const jwtSecret = config.auth?.jwtSecret;
  if (!jwtSecret) return undefined;
  const filePath = runtimeDataDir
    ? join(runtimeDataDir, 'secrets.enc')
    : join(processCwd, 'data', 'secrets.enc');
  return new EncryptedFileSecretVault(filePath, `agent-saas/secret-vault/v1:${jwtSecret}`);
}

export function computeConfigIdentityForCli(
  options: Record<string, string>,
  config: AppConfig,
  vault: Pick<SecretVault, 'inspectRef'> | undefined,
): Promise<ConfigIdentityObservation> {
  const processCwd = options['process-cwd'] ?? process.cwd();
  return computeObservedConfigIdentity(config, vault, processCwd);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const configPath = options.config;
  if (!configPath) throw new Error('--config <path> is required');
  const config = loadConfig(configPath);
  if (config.models) assertAuxiliaryModelRefsResolvable(config, config.models);
  if (options.environment === 'production') {
    // 部署期就拒绝「已有 ref 方案的 inline secret」，而不是等候选进程拒启。
    assertProductionManagedCredentialSafety(config);
  }
  const vault = buildConfigIdentityVault(options, config);
  const observation = await computeConfigIdentityForCli(options, config, vault);
  if (
    options.environment === 'production' &&
    observation.secretRefCount > 0 &&
    observation.versionResolution !== 'resolved'
  ) {
    throw new Error(
      `production managed SecretVault refs are not verifiable: ${observation.unresolvedRefPaths.join(', ')}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: CONFIG_IDENTITY_SCHEMA_VERSION,
      digest: observation.digest,
      credentialVersionDigest: observation.credentialVersionDigest,
      secretRefCount: observation.secretRefCount,
      versionResolution: observation.versionResolution,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `config-identity-cli failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
