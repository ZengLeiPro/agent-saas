/**
 * One-shot local migration:
 * - platform root tenant: pantheon / 万神殿
 * - daily internal tenant: kaiyan / 开沿科技
 * - admin user belongs to pantheon
 *
 * Default is dry-run. Use --apply to write.
 * This script intentionally does not move workspaces or transcripts.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SETTINGS,
  LEGACY_TENANT_ID,
} from '../src/data/tenants/types.js';

const PLATFORM_TENANT_NAME = '万神殿';
const LEGACY_TENANT_NAME = '开沿科技';
const ADMIN_USERNAME = 'admin';

type JsonObject = Record<string, unknown>;

interface CliOptions {
  apply: boolean;
  dataDir: string;
  configDir: string;
  workspaceSharedDir: string;
}

interface TenantRecord extends JsonObject {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  disabled?: boolean;
  settings?: unknown;
}

interface TenantsData {
  version: 1;
  tenants: TenantRecord[];
}

interface UserRecord extends JsonObject {
  id: string;
  username: string;
  role: 'admin' | 'user';
  tenantId?: string;
  updatedAt?: string;
}

interface UsersData {
  version: 1;
  users: UserRecord[];
}

interface AzerothTenantTokens {
  tokens?: Record<string, string>;
}

interface AzerothTokensConfig extends JsonObject {
  azerothApiUrl?: string;
  tenants?: Record<string, AzerothTenantTokens>;
  tokens?: Record<string, string>;
}

interface FileChange {
  path: string;
  changed: boolean;
  summary: string[];
  write?: () => Promise<void>;
}

function parseArgs(argv: string[]): CliOptions {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '..', '..');
  function pick(name: string): string | undefined {
    const idx = argv.indexOf(name);
    if (idx >= 0) return argv[idx + 1];
    const prefix = `${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  }
  return {
    apply: argv.includes('--apply'),
    dataDir: resolve(pick('--data-dir') ?? resolve(repoRoot, 'server/data')),
    configDir: resolve(pick('--config-dir') ?? resolve(repoRoot, 'server/config')),
    workspaceSharedDir: resolve(pick('--workspace-shared') ?? resolve(repoRoot, 'workspace-shared')),
  };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(data, null, 2)}\n`, 0o600);
}

async function writeTextAtomic(path: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmpPath, content, { mode });
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tenantSettingsFrom(source?: TenantRecord): unknown {
  return clone(source?.settings ?? DEFAULT_TENANT_SETTINGS);
}

async function planTenants(dataDir: string): Promise<FileChange> {
  const path = resolve(dataDir, 'tenants.json');
  const data = await readJson<TenantsData>(path, { version: 1, tenants: [] });
  const tenants = [...(data.tenants ?? [])];
  const now = new Date().toISOString();
  const summary: string[] = [];
  let changed = false;

  const kaiyan = tenants.find((tenant) => tenant.id === LEGACY_TENANT_ID);
  let pantheon = tenants.find((tenant) => tenant.id === DEFAULT_TENANT_ID);

  if (!pantheon) {
    pantheon = {
      id: DEFAULT_TENANT_ID,
      name: PLATFORM_TENANT_NAME,
      createdAt: now,
      createdBy: 'system',
      updatedAt: now,
      settings: tenantSettingsFrom(kaiyan),
    };
    tenants.unshift(pantheon);
    changed = true;
    summary.push(`新增组织 ${DEFAULT_TENANT_ID} / ${PLATFORM_TENANT_NAME}`);
  } else if (pantheon.name !== PLATFORM_TENANT_NAME || pantheon.disabled) {
    pantheon.name = PLATFORM_TENANT_NAME;
    pantheon.disabled = undefined;
    pantheon.updatedAt = now;
    changed = true;
    summary.push(`更新组织 ${DEFAULT_TENANT_ID} 为 ${PLATFORM_TENANT_NAME}，并确保未禁用`);
  }

  if (!kaiyan) {
    tenants.push({
      id: LEGACY_TENANT_ID,
      name: LEGACY_TENANT_NAME,
      createdAt: now,
      createdBy: 'system',
      updatedAt: now,
      settings: tenantSettingsFrom(pantheon),
    });
    changed = true;
    summary.push(`新增组织 ${LEGACY_TENANT_ID} / ${LEGACY_TENANT_NAME}`);
  } else if (kaiyan.name !== LEGACY_TENANT_NAME || kaiyan.disabled) {
    kaiyan.name = LEGACY_TENANT_NAME;
    kaiyan.disabled = undefined;
    kaiyan.updatedAt = now;
    changed = true;
    summary.push(`更新组织 ${LEGACY_TENANT_ID} 为 ${LEGACY_TENANT_NAME}，并确保未禁用`);
  }

  return {
    path,
    changed,
    summary: summary.length ? summary : ['无需修改'],
    write: changed ? () => writeJsonAtomic(path, { ...data, version: 1, tenants }) : undefined,
  };
}

async function planUsers(dataDir: string): Promise<FileChange> {
  const path = resolve(dataDir, 'users.json');
  const data = await readJson<UsersData>(path, { version: 1, users: [] });
  const users = [...(data.users ?? [])];
  const now = new Date().toISOString();
  const summary: string[] = [];
  let changed = false;

  const admin = users.find((user) => user.username.toLowerCase() === ADMIN_USERNAME);
  if (!admin) {
    summary.push('未找到 admin 用户：脚本不会自动创建未知密码账号');
  } else {
    if (admin.role !== 'admin') {
      admin.role = 'admin';
      changed = true;
      summary.push('将 admin.role 修正为 admin');
    }
    if (admin.tenantId !== DEFAULT_TENANT_ID) {
      summary.push(`将 admin.tenantId 从 ${admin.tenantId ?? '<missing>'} 改为 ${DEFAULT_TENANT_ID}`);
      admin.tenantId = DEFAULT_TENANT_ID;
      admin.updatedAt = now;
      changed = true;
    }
  }

  for (const user of users) {
    if (!user.tenantId) {
      user.tenantId = user.username.toLowerCase() === ADMIN_USERNAME && user.role === 'admin'
        ? DEFAULT_TENANT_ID
        : LEGACY_TENANT_ID;
      user.updatedAt = now;
      changed = true;
      summary.push(`回填 ${user.username}.tenantId=${user.tenantId}`);
    }
  }

  const nonAdminPantheon = users
    .filter((user) => user.username.toLowerCase() !== ADMIN_USERNAME && user.tenantId === DEFAULT_TENANT_ID)
    .map((user) => user.username);
  if (nonAdminPantheon.length > 0) {
    summary.push(`注意：发现非 admin 用户仍在 ${DEFAULT_TENANT_ID}: ${nonAdminPantheon.join(', ')}，脚本未自动移动`);
  }

  return {
    path,
    changed,
    summary: summary.length ? summary : ['无需修改'],
    write: changed ? () => writeJsonAtomic(path, { ...data, version: 1, users }) : undefined,
  };
}

async function planAzerothTokens(configDir: string): Promise<FileChange> {
  const path = resolve(configDir, 'azeroth-tokens.json');
  if (!existsSync(path)) {
    return { path, changed: false, summary: ['文件不存在，跳过'] };
  }

  const data = await readJson<AzerothTokensConfig>(path, {});
  const legacyTokens = data.tokens ?? {};
  const legacyKeys = Object.keys(legacyTokens);
  const summary: string[] = [];
  let changed = false;

  if (legacyKeys.length === 0) {
    return { path, changed: false, summary: ['无 legacy tokens，跳过'] };
  }

  const tenants = { ...(data.tenants ?? {}) };
  const kaiyanTokens = { ...(tenants[LEGACY_TENANT_ID]?.tokens ?? {}) };
  const pantheonTokens = { ...(tenants[DEFAULT_TENANT_ID]?.tokens ?? {}) };
  const conflicts: string[] = [];
  const movedToKaiyan: string[] = [];
  const movedToPantheon: string[] = [];

  for (const [username, token] of Object.entries(legacyTokens)) {
    if (username === ADMIN_USERNAME) {
      if (pantheonTokens[username] && pantheonTokens[username] !== token) {
        conflicts.push(`${DEFAULT_TENANT_ID}.${username}`);
      } else if (!pantheonTokens[username]) {
        pantheonTokens[username] = token;
        movedToPantheon.push(username);
        changed = true;
      }
      continue;
    }

    if (kaiyanTokens[username] && kaiyanTokens[username] !== token) {
      conflicts.push(`${LEGACY_TENANT_ID}.${username}`);
    } else if (!kaiyanTokens[username]) {
      kaiyanTokens[username] = token;
      movedToKaiyan.push(username);
      changed = true;
    }
  }

  if (movedToPantheon.length > 0) {
    tenants[DEFAULT_TENANT_ID] = { ...(tenants[DEFAULT_TENANT_ID] ?? {}), tokens: pantheonTokens };
    summary.push(`复制 legacy token key 到 ${DEFAULT_TENANT_ID}: ${movedToPantheon.join(', ')}`);
  }
  if (movedToKaiyan.length > 0) {
    tenants[LEGACY_TENANT_ID] = { ...(tenants[LEGACY_TENANT_ID] ?? {}), tokens: kaiyanTokens };
    summary.push(`复制 legacy token key 到 ${LEGACY_TENANT_ID}: ${movedToKaiyan.join(', ')}`);
  }

  const next: AzerothTokensConfig = { ...data, tenants };
  if (conflicts.length === 0) {
    delete next.tokens;
    changed = true;
    summary.push('移除 legacy tokens 扁平字段');
  } else {
    summary.push(`保留 legacy tokens 字段：存在冲突 ${conflicts.join(', ')}`);
  }

  return {
    path,
    changed,
    summary,
    write: changed ? () => writeJsonAtomic(path, next) : undefined,
  };
}

async function planPantheonCompany(workspaceSharedDir: string): Promise<FileChange> {
  const path = resolve(workspaceSharedDir, 'tenants', DEFAULT_TENANT_ID, 'company.md');
  const content = [
    '# 万神殿',
    '',
    '平台根组织，仅承载 Agent SaaS 平台管理员、跨组织运维与系统级配置。',
    `日常公司协作、客户资料与开沿科技业务上下文归属 \`${LEGACY_TENANT_ID}\` 组织。`,
    '',
  ].join('\n');

  if (existsSync(path)) {
    const current = await readFile(path, 'utf-8').catch(() => '');
    if (current === content) return { path, changed: false, summary: ['无需修改'] };
    return {
      path,
      changed: false,
      summary: ['文件已存在且内容不同，脚本未覆盖'],
    };
  }

  return {
    path,
    changed: true,
    summary: ['新增万神殿 company.md'],
    write: () => writeTextAtomic(path, content),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const plans = [
    await planTenants(options.dataDir),
    await planUsers(options.dataDir),
    await planAzerothTokens(options.configDir),
    await planPantheonCompany(options.workspaceSharedDir),
  ];

  console.log(options.apply ? '[apply] migrate platform tenant to pantheon' : '[dry-run] migrate platform tenant to pantheon');
  console.log(`dataDir=${options.dataDir}`);
  console.log(`configDir=${options.configDir}`);
  console.log(`workspaceSharedDir=${options.workspaceSharedDir}`);
  console.log('workspace/transcripts: no move, no delete');
  console.log('');

  for (const plan of plans) {
    console.log(`${plan.changed ? 'CHANGE' : 'OK'} ${plan.path}`);
    for (const line of plan.summary) console.log(`  - ${line}`);
  }

  if (!options.apply) {
    console.log('');
    console.log('dry-run only. Re-run with --apply to write changes.');
    return;
  }

  for (const plan of plans) {
    if (plan.changed && plan.write) await plan.write();
  }
  console.log('');
  console.log('migration applied.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
