/**
 * skills zip 上传安全 + moveSkillIntoPlace EXDEV 降级回归测试（routes/skills.ts）
 *
 * 背景：核实报告确认 skills.ts 的 zip 上传过滤对经典 `../` 家族严密，但存在
 * 一个真实可利用旁路——zip 内符号链接条目（unix mode 0o120xxx）。过滤仅校验
 * `unzip -Z -1` 打印的干净条目名（如 `leak`），symlink 目标写在条目内容里，
 * 第二次 `unzip -q` 会如实创建活符号链接，随后被 moveSkillIntoPlace 原样搬入
 * agent 可读的 skills 目录，造成沙箱外文件读取。
 *
 * 本文件覆盖两块此前零测试的逻辑：
 *   K2 —— zip 上传安全过滤（symlink 旁路 / 字面 ../ 家族 / 绝对路径 / 合法 zip）
 *   K1 —— moveSkillIntoPlace 的 EXDEV 降级复制与失败清理（renameSync 抛 EXDEV）
 *
 * 与邻近 skillsRoutesCoverage.test.ts / skillsRouterTenantIsolation.test.ts 同范式：
 * 真 express + 真 fetch + 真文件系统 pool + in-memory store。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { crc32 } from 'node:zlib';

// ── K1 需要拦截 skills.ts 内 `import { renameSync, cpSync } from 'node:fs'` ──
// 用 importOriginal 保留所有真实 fs 函数（rig / mkdtemp / writeFile 等仍走真实实现），
// 仅在 per-test 标志置位时让 renameSync 抛 EXDEV / cpSync 抛错，模拟跨文件系统场景。
let renameShouldThrowExdev = false;
let cpShouldThrow = false;
const cpSyncSpy = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameShouldThrowExdev) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      }
      return actual.renameSync(...args);
    },
    cpSync: ((...args: Parameters<typeof actual.cpSync>) => {
      cpSyncSpy(...args);
      if (cpShouldThrow) {
        throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      }
      return actual.cpSync(...args);
    }) as typeof actual.cpSync,
  };
});

// 在 mock 就绪后再引入被测模块与 fs（rig 用）
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillsRouter } from '../routes/skills.js';
import type { UserStore } from '../data/users/store.js';
import type { UserRecord } from '../data/users/types.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const KAIYAN_USER: JwtPayload = { sub: 'u-ku', username: 'alice', role: 'user', tenantId: 'kaiyan' };

function userRecord(id: string, username: string, role: 'admin' | 'user', tenantId: string): UserRecord {
  return {
    id, username, passwordHash: 'x', role, tenantId, realName: username,
    createdAt: '2026-06-23T00:00:00Z', createdBy: 'system', updatedAt: '2026-06-23T00:00:00Z',
  };
}

function fakeUserStore(): UserStore {
  const users: UserRecord[] = [
    userRecord('u-platform', 'admin', 'admin', DEFAULT_TENANT_ID),
    userRecord('u-ku', 'alice', 'user', 'kaiyan'),
  ];
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    findById: (id: string) => users.find(u => u.id === id),
    listAll: () => users.map(({ passwordHash: _p, ...rest }) => rest as never),
  } as unknown as UserStore;
}

function fakeSkillConfigStore(): SkillConfigStore {
  const visibility: Record<string, boolean> = {};
  const userSelections = new Map<string, string[]>();
  let configVersion = 1;
  return {
    getPoolVisibility: () => ({ ...visibility }),
    getPlatformSkillConfig: (id: string) => ({ enabled: visibility[id] !== false, exposure: 'all' as const, tenantIds: [] }),
    isPoolSkillAvailableToTenant: (id: string) => visibility[id] !== false,
    setPoolVisibility: async (updates: Record<string, boolean>) => { Object.assign(visibility, updates); configVersion++; },
    isTenantSkillAvailableToUser: () => true,
    isTenantOwnSkillAvailableToUser: () => true,
    getTenantSkillRule: () => ({ enabled: true, exposure: 'all' as const, usernames: [] }),
    getTenantOwnSkillRule: () => ({ enabled: true, exposure: 'all' as const, usernames: [] }),
    getUserSelectedSkills: (u: string) => userSelections.get(u) ?? [],
    setUserSelectedSkills: async (u: string, skills: string[]) => { userSelections.set(u, skills); configVersion++; },
    getConfigVersion: () => configVersion,
    touchConfigVersion: async () => { configVersion++; },
    syncWithPool: () => 0,
    pruneStaleSkills: () => 0,
  } as unknown as SkillConfigStore;
}

// ── 极简 store-mode ZIP writer ──────────────────────────────
// Node stdlib 无 zip 打包器；手写足以覆盖两类条目：普通文件、符号链接（unix
// mode 高 16 位写进 external_attr，unzip 会据此创建真 symlink）。零外部依赖。
interface ZipEntry { name: string; data: string; mode: number }
function makeZip(entries: ZipEntry[]): Buffer {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = Buffer.from(enc.encode(e.name));
    const dataBytes = Buffer.from(enc.encode(e.data));
    const crc = crc32(dataBytes) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 8); // store
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(dataBytes.length, 18);
    lfh.writeUInt32LE(dataBytes.length, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);
    locals.push(lfh, nameBytes, dataBytes);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(0x031e, 4); // version made by: unix
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 10); // store
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(dataBytes.length, 20);
    cdh.writeUInt32LE(dataBytes.length, 24);
    cdh.writeUInt16LE(nameBytes.length, 28);
    cdh.writeUInt32LE(((e.mode & 0xffff) * 0x10000) >>> 0, 38); // unix mode → external attr 高位
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBytes);
    offset += lfh.length + nameBytes.length + dataBytes.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, ...central, eocd]);
}

const FILE_MODE = 0o100644;
const SYMLINK_MODE = 0o120777;
const VALID_SKILL_MD = '---\nname: evil\ndescription: x\n---\n';

function zipForm(buf: Buffer, filename = 'skill.zip'): FormData {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(buf)], { type: 'application/zip' }), filename);
  return form;
}

interface Rig {
  agentCwd: string;
  userSkillsDir: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  setCaller(c: JwtPayload | undefined): void;
  close(): Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-zipsec-'));
  const agentCwd = join(tmpRoot, 'workspace');
  const sharedDir = join(tmpRoot, 'shared');
  const tenantSkillsRootDir = join(tmpRoot, 'tenant-skills');
  const poolDir = join(sharedDir, '.ky-agent', 'skills-pool');
  mkdirSync(agentCwd, { recursive: true });
  mkdirSync(poolDir, { recursive: true });
  mkdirSync(join(poolDir, 'shared_skill'), { recursive: true });
  writeFileSync(join(poolDir, 'shared_skill', 'SKILL.md'), '---\nname: shared_skill\ndescription: shared\n---\nhi');

  const app = express();
  app.use(express.json());
  let caller: JwtPayload | undefined = KAIYAN_USER;
  app.use((req, _res, next) => { if (caller) req.user = caller; next(); });
  app.use('/api/skills', createSkillsRouter({
    skillConfigStore: fakeSkillConfigStore(),
    userStore: fakeUserStore(),
    agentCwd, sharedDir, tenantSkillsRootDir,
  }));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    agentCwd,
    userSkillsDir: join(agentCwd, 'kaiyan', 'u-ku', '.ky-agent', 'skills'),
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    setCaller(c) { caller = c; },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** 递归判断目录里是否存在任何符号链接条目 */
function containsSymlink(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return true;
    if (st.isDirectory() && containsSymlink(p)) return true;
  }
  return false;
}

describe('skills zip 上传安全（K2 symlink 旁路 + 路径过滤）', () => {
  let h: Rig;
  beforeEach(async () => {
    renameShouldThrowExdev = false;
    cpShouldThrow = false;
    cpSyncSpy.mockClear();
    h = await makeRig();
    h.setCaller(KAIYAN_USER);
  });
  afterEach(async () => { await h.close(); });

  it('★ 拒绝含符号链接条目的 zip（symlink 旁路）→ 400，且落地目录无 symlink', async () => {
    // leak 是干净名字（过 safeRelativePath），symlink 目标写在内容里 → 旁路旧过滤
    const buf = makeZip([
      { name: 'leak', data: '/etc/passwd', mode: SYMLINK_MODE },
      { name: 'SKILL.md', data: VALID_SKILL_MD, mode: FILE_MODE },
    ]);
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: zipForm(buf) });
    expect(res.status).toBe(400);
    // 修复后不应有 skill 落盘；即便未来行为变化，也绝不能留下指向绝对路径的活链接
    const evilDir = join(h.userSkillsDir, 'evil');
    if (existsSync(evilDir)) {
      expect(containsSymlink(evilDir)).toBe(false);
    }
  });

  it('合法 zip（纯普通文件，无 symlink）→ 200 正常安装', async () => {
    const buf = makeZip([
      { name: 'SKILL.md', data: '---\nname: legit\ndescription: a legit skill\n---\nbody', mode: FILE_MODE },
      { name: 'helper.py', data: 'print(1)\n', mode: FILE_MODE },
    ]);
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: zipForm(buf) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; skill: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.skill.id).toBe('legit');
    const installed = join(h.userSkillsDir, 'legit');
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true);
    expect(containsSymlink(installed)).toBe(false);
  });

  it('字面 ../ 路径条目仍被拒 → 400（回归 safeRelativePath）', async () => {
    const buf = makeZip([
      { name: '../evil.txt', data: 'x', mode: FILE_MODE },
      { name: 'SKILL.md', data: VALID_SKILL_MD, mode: FILE_MODE },
    ]);
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: zipForm(buf) });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('不安全路径');
  });

  it('反斜杠 ..\\ 变体条目仍被拒 → 400', async () => {
    const buf = makeZip([
      { name: '..\\evil.txt', data: 'x', mode: FILE_MODE },
      { name: 'SKILL.md', data: VALID_SKILL_MD, mode: FILE_MODE },
    ]);
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: zipForm(buf) });
    expect(res.status).toBe(400);
  });

  it('嵌套 sub/../../ 逃逸条目仍被拒 → 400', async () => {
    const buf = makeZip([
      { name: 'sub/../../evil.txt', data: 'x', mode: FILE_MODE },
      { name: 'SKILL.md', data: VALID_SKILL_MD, mode: FILE_MODE },
    ]);
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: zipForm(buf) });
    expect(res.status).toBe(400);
  });
});

describe('moveSkillIntoPlace EXDEV 降级（K1）', () => {
  let h: Rig;
  beforeEach(async () => {
    renameShouldThrowExdev = false;
    cpShouldThrow = false;
    cpSyncSpy.mockClear();
    h = await makeRig();
    h.setCaller(KAIYAN_USER);
  });
  afterEach(async () => {
    renameShouldThrowExdev = false;
    cpShouldThrow = false;
    await h.close();
  });

  function legitMultipartForm(skillName: string): FormData {
    const form = new FormData();
    form.append('files', new Blob([`---\nname: ${skillName}\ndescription: d\n---\nbody`], { type: 'text/markdown' }), 'SKILL.md');
    return form;
  }

  it('renameSync 抛 EXDEV → 降级 cpSync 成功，skill 正常落盘 200', async () => {
    renameShouldThrowExdev = true;
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: legitMultipartForm('xdevok') });
    expect(res.status).toBe(200);
    expect(cpSyncSpy).toHaveBeenCalled();
    const installed = join(h.userSkillsDir, 'xdevok');
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true);
  });

  it('EXDEV 后 cpSync 抛错 → 清理半份 targetDir 并 500（不误报 200/409）', async () => {
    renameShouldThrowExdev = true;
    cpShouldThrow = true;
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: legitMultipartForm('xdevfail') });
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toBe('导入技能失败');
    // 半份目录必须被 rmSync 清掉，避免重传时误报 409
    const installed = join(h.userSkillsDir, 'xdevfail');
    expect(existsSync(installed)).toBe(false);
  });

  it('清理后重传（rename 恢复正常）→ 200，不残留 409', async () => {
    renameShouldThrowExdev = true;
    cpShouldThrow = true;
    await h.request('/api/skills/me/import', { method: 'POST', body: legitMultipartForm('retryme') });

    // 恢复正常文件系统语义，重传应干净成功
    renameShouldThrowExdev = false;
    cpShouldThrow = false;
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: legitMultipartForm('retryme') });
    expect(res.status).toBe(200);
    expect(existsSync(join(h.userSkillsDir, 'retryme', 'SKILL.md'))).toBe(true);
  });
});
