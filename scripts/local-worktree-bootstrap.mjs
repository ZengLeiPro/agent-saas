#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { parse, printParseErrorCode } from 'jsonc-parser';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const targetConfigPath = join(projectRoot, 'config.json.local-worktree');
const postgresContainer = 'local-postgres';
const postgresRole = 'agent_saas_local_app';
const postgresPassword = 'agent_saas_local_dev_password';
const adminUsername = 'admin';
const adminPassword = 'admin123';

function shell(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  }).trim();
}

function safeIdentifier(value, label) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error(`${label} 只能包含小写字母、数字和下划线`);
  return value;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function deriveDatabaseName(worktreePath) {
  const slug =
    basename(worktreePath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'worktree';
  const digest = createHash('sha256').update(resolve(worktreePath)).digest('hex').slice(0, 8);
  return `agent_saas_${slug.slice(0, 43)}_${digest}`;
}

export function parseWorktreeList(raw) {
  const entries = [];
  let current;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  return entries;
}

function parseArgs(args) {
  let sourceConfig;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--source-config') {
      sourceConfig = args[index + 1];
      if (!sourceConfig) throw new Error('--source-config 后必须提供文件路径');
      index += 1;
    } else {
      throw new Error(`未知参数：${args[index]}`);
    }
  }
  return { sourceConfig };
}

export function resolveSourceConfig({ explicitPath, root, worktreeOutput }) {
  const candidates = [];
  if (explicitPath) {
    const resolvedExplicitPath = resolve(explicitPath);
    if (!existsSync(resolvedExplicitPath)) throw new Error(`指定的源配置不存在：${explicitPath}`);
    return resolvedExplicitPath;
  }
  candidates.push(join(root, 'config.json'));
  for (const worktree of parseWorktreeList(worktreeOutput)) {
    if (resolve(worktree.path) !== resolve(root))
      candidates.push(join(worktree.path, 'config.json'));
  }
  candidates.push(join(root, 'config.example.json'));
  const selected = candidates.find(existsSync);
  if (!selected) throw new Error('找不到可复用的 config.json 或 config.example.json');
  return selected;
}

export function parseJsoncConfig(raw, sourcePath) {
  const errors = [];
  const config = parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)}@${error.offset}`)
      .join(', ');
    throw new Error(`配置解析失败 ${sourcePath}: ${detail}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error(`配置根节点必须是对象：${sourcePath}`);
  return config;
}

export function buildLocalConfig(baseConfig, { connectionString, root }) {
  const config = structuredClone(baseConfig);
  config.server = {
    ...(config.server || {}),
    port: 3200,
    timezone: config.server?.timezone || 'Asia/Shanghai',
  };
  config.auth = { ...(config.auth || {}), enabled: true };
  if (
    typeof config.auth.jwtSecret !== 'string' ||
    config.auth.jwtSecret.length < 32 ||
    config.auth.jwtSecret.startsWith('your-')
  ) {
    config.auth.jwtSecret = randomBytes(32).toString('hex');
  }
  config.agent = { ...(config.agent || {}) };
  if (!config.agent.cwd || String(config.agent.cwd).includes('/path/to/'))
    config.agent.cwd = join(homedir(), 'workspace');
  if (!config.agent.sharedDir || String(config.agent.sharedDir).includes('/path/to/'))
    config.agent.sharedDir = join(root, 'workspace-shared');
  config.cron = { ...(config.cron || {}), enabled: false };
  config.runtimeEventStore = {
    backend: 'pg',
    connectionString,
    tablePrefix: 'runtime',
    writerCapability: { capability: 'tenant-native-v1' },
  };
  return config;
}

async function ensureAdmin(usersPath) {
  let data = { version: 1, debugModeMigrationVersion: 1, users: [] };
  if (existsSync(usersPath)) {
    data = JSON.parse(readFileSync(usersPath, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.users))
      throw new Error(`用户文件结构无效：${usersPath}`);
  }
  const now = new Date().toISOString();
  let admin = data.users.find((user) => user.username === adminUsername);
  let changed = false;
  if (!admin) {
    const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
    const id = `ky${[...randomBytes(12)].map((byte) => alphabet[byte & 31]).join('')}`;
    admin = {
      id,
      username: adminUsername,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      role: 'admin',
      tenantId: 'pantheon',
      realName: '本地平台管理员',
      debugMode: false,
      preferences: { sessionOrganizationEnabled: false },
      createdAt: now,
      createdBy: 'local-worktree-bootstrap',
      updatedAt: now,
    };
    data.users.push(admin);
    changed = true;
  } else {
    if (!(await bcrypt.compare(adminPassword, admin.passwordHash))) {
      admin.passwordHash = await bcrypt.hash(adminPassword, 10);
      changed = true;
    }
    for (const [key, value] of Object.entries({ role: 'admin', tenantId: 'pantheon' })) {
      if (admin[key] !== value) {
        admin[key] = value;
        changed = true;
      }
    }
    admin.preferences ||= {};
    if (admin.preferences.sessionOrganizationEnabled === undefined) {
      admin.preferences.sessionOrganizationEnabled = false;
      changed = true;
    }
    if (changed) admin.updatedAt = now;
  }
  if (!changed) return false;
  mkdirSync(dirname(usersPath), { recursive: true });
  const tempPath = join(
    dirname(usersPath),
    `.users.bootstrap-${randomBytes(6).toString('hex')}.tmp`,
  );
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, usersPath);
  chmodSync(usersPath, 0o600);
  return true;
}

function ensurePostgres(databaseName) {
  safeIdentifier(postgresRole, 'LOCAL_PG_USER');
  safeIdentifier(databaseName, '数据库名');
  shell('docker', ['start', postgresContainer], { capture: true });
  const roleSql = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${sqlLiteral(postgresRole)}) THEN CREATE ROLE ${postgresRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${sqlLiteral(postgresPassword)}; ELSE ALTER ROLE ${postgresRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${sqlLiteral(postgresPassword)}; END IF; END $$;`;
  shell(
    'docker',
    [
      'exec',
      postgresContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      roleSql,
    ],
    { capture: true },
  );
  const exists = shell(
    'docker',
    [
      'exec',
      postgresContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-Atc',
      `SELECT 1 FROM pg_database WHERE datname=${sqlLiteral(databaseName)}`,
    ],
    { capture: true },
  );
  if (exists !== '1')
    shell(
      'docker',
      ['exec', postgresContainer, 'createdb', '-U', 'postgres', '-O', postgresRole, databaseName],
      { capture: true },
    );
  shell(
    'docker',
    [
      'exec',
      postgresContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `ALTER DATABASE ${databaseName} OWNER TO ${postgresRole}`,
    ],
    { capture: true },
  );
  const identity = shell(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${postgresPassword}`,
      postgresContainer,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      postgresRole,
      '-d',
      databaseName,
      '-Atc',
      "SELECT current_user || '|' || rolsuper || '|' || rolbypassrls FROM pg_roles WHERE rolname=current_user",
    ],
    { capture: true },
  );
  if (identity !== `${postgresRole}|false|false`)
    throw new Error(`PostgreSQL 写入账号门禁校验失败：${identity}`);
}

export async function main(args = process.argv.slice(2)) {
  const { sourceConfig } = parseArgs(args);
  const databaseName = deriveDatabaseName(projectRoot);
  const worktreeOutput = shell('git', ['worktree', 'list', '--porcelain'], { capture: true });
  const selectedSource =
    !sourceConfig && existsSync(targetConfigPath)
      ? targetConfigPath
      : resolveSourceConfig({ explicitPath: sourceConfig, root: projectRoot, worktreeOutput });
  const baseConfig = parseJsoncConfig(readFileSync(selectedSource, 'utf8'), selectedSource);
  ensurePostgres(databaseName);
  const connectionString = `postgresql://${postgresRole}:${encodeURIComponent(postgresPassword)}@127.0.0.1:5432/${databaseName}`;
  const config = buildLocalConfig(baseConfig, { connectionString, root: projectRoot });
  writeFileSync(targetConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(targetConfigPath, 0o600);
  const adminChanged = await ensureAdmin(join(projectRoot, 'server/data/users.json'));
  const fallback = selectedSource.endsWith('config.example.json');
  console.log('本地 worktree 环境已就绪');
  console.log(`  配置：${targetConfigPath}`);
  console.log(`  PostgreSQL：${postgresContainer}/${databaseName}（非超管写入账号）`);
  console.log(`  管理员：${adminUsername}${adminChanged ? '（已创建或校准）' : '（已存在）'}`);
  if (fallback)
    console.warn(
      '  警告：未找到其他 checkout 的 config.json，已使用 config.example.json；模型调用需另行配置。',
    );
}

if (resolve(process.argv[1] || '') === scriptPath) {
  main().catch((error) => {
    console.error(`本地环境初始化失败：${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
