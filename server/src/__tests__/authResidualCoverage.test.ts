/**
 * Auth 路由残余分支补测（auth.ts）—— 第二批
 *
 * 与既有 auth 测试的分工（不重复已覆盖分支）：
 *  - authUsersRouter.test.ts：admin 同租户边界（peerAdmin/自删自降）+ 短信登录正路径
 *    （send-code→login→重放 400）+ /me/phone 验证正路径与 send-code 409。
 *  - authRoutesCoverage.test.ts：密码登录 200/401/400/429、/me、GET|POST /users、
 *    /users/:id/status、/password、/activity、login-logs 非法 tenantId 400。
 *  - authTenantIsolation.test.ts：跨租户 403 隔离线 + /users/:id/avatar + login-logs 租户 scope。
 *  - platformGovernance.test.ts：requireSuperAdmin/enforcePlatformWritePolicy 中间件
 *    **本体**（探针 app），但没有测 auth 路由上的真实挂载——把 auth.ts 里
 *    DELETE /login-logs 的 requireSuperAdmin 换回 requireAdmin，它依然全绿。
 *
 * 本文件专补（按防回归价值排序）：
 *  1. DELETE /login-logs 的 requireSuperAdmin 门禁（07-18 从 requireAdmin 收紧；
 *     历史上组织 admin 可清全局审计日志，属跨租户写漏洞）：组织 admin/普通用户/匿名
 *     /非 super 平台 admin → 403 且日志未动；@admin → 200 清空 + before/excludeUsername 条件清理。
 *  2. /me/phone/send-code、/me/phone/verify：401/格式 400/验证码错误/过期 400/
 *     verify 409 先于验证码校验/冷却 429/IP 频控 429/短信未配置 403。
 *  3. /me/preferences：401/400/200 合并落盘 + 未知键剥离。
 *  4. GET /login-logs 查询参数解析：username 单值/逗号多值/尾逗号、limit+offset 分页、
 *     日志文件读失败 500。
 *  5. 头像上传 POST /avatar（本人）：401/无文件 400/上传成功/换扩展名清理旧文件 +
 *     avatarVersion 递增/GET 缓存头（带 v immutable、不带 v 短缓存）/文件缺失 404，
 *     以及「已知缺陷记录」：非图片 MIME 被 multer fileFilter 拒绝后无路由级捕获 → 500。
 *  6. 现场侦察新增：/sms/send-code 的登录资格分支（未注册 404/未验证 403/禁用 403）——
 *     SMS 发送侧经 loginCodeService 注入 CaptureSender，可完全离线测（A 类）。
 *
 * 模式对齐 authRoutesCoverage.test.ts：真实 UserStore/TenantStore（mkdtemp 临时目录）
 * + 真 express + listen(0) + 全局 fetch；认证伪造 = 中间件注入 req.user，setCaller 切换；
 * trust proxy + 每用例独立 X-Forwarded-For 隔离按 IP keyed 的频控器。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { TenantStore } from '../data/tenants/store.js';
import { UserStore } from '../data/users/store.js';
import type { UserInfo } from '../data/users/types.js';
import { createAuthRouter } from '../routes/auth.js';
import {
  appendLoginLog,
  queryLoginLogs,
} from '../data/login-logs/store.js';
import type { LoginLogEntry } from '../data/login-logs/types.js';
import {
  VerificationCodeService,
  type SmsSender,
} from '../integrations/sms/verificationService.js';

/** 捕获式短信发送器：不外呼，只记录最后一次发送的号码与验证码。 */
class CaptureSender implements SmsSender {
  readonly providerName = 'capture';
  lastPhone = '';
  lastCode = '';

  async sendCode(phone: string, code: string): Promise<void> {
    this.lastPhone = phone;
    this.lastCode = code;
  }
}

interface RigOptions {
  /**
   * 短信验证码服务配置：
   *  - 缺省 = 注入 CaptureSender + cooldownMs 0（多数用例无冷却干扰）
   *  - false = 不注入（覆盖「短信通道未配置」403 分支）
   *  - 对象 = 定制 cooldownMs / codeTtlMs（冷却 429、过期 400 用例）
   */
  sms?: false | { cooldownMs?: number; codeTtlMs?: number };
}

interface TestRig {
  users: {
    /** username='admin' + pantheon：默认 SUPER_ADMIN_USERNAMES 名单内的超管 */
    superAdmin: UserInfo;
    /** pantheon 普通员工 admin：平台 admin 但非 super */
    pantheonStaff: UserInfo;
    wainAdmin: UserInfo;
    /** 手机号 13800001111 已验证 */
    wainUser: UserInfo;
  };
  userStore: UserStore;
  sender: CaptureSender;
  loginLogFilePath: string;
  avatarsDir: string;
  setCaller(user: UserInfo | undefined): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

function asCaller(user: UserInfo): JwtPayload {
  return { sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId };
}

async function makeRig(options: RigOptions = {}): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'auth-residual-'));
  const tenantStore = new TenantStore(join(tmpRoot, 'tenants.json'));
  await tenantStore.create({ id: DEFAULT_TENANT_ID, name: '万神殿', createdBy: 'system' });
  await tenantStore.create({ id: 'wain', name: '唯恩', createdBy: 'system' });
  await tenantStore.create({ id: 'acme', name: '阿康', createdBy: 'system' });

  const userStore = new UserStore(join(tmpRoot, 'users.json'));
  const superAdmin = await userStore.create({
    username: 'admin', password: 'password123', role: 'admin',
    createdBy: 'system', tenantId: DEFAULT_TENANT_ID,
  });
  const pantheonStaff = await userStore.create({
    username: 'pantheon_staff', password: 'password123', role: 'admin',
    createdBy: 'system', tenantId: DEFAULT_TENANT_ID,
  });
  const wainAdmin = await userStore.create({
    username: 'wain_admin', password: 'password123', role: 'admin',
    createdBy: 'system', tenantId: 'wain',
  });
  const wainUser = await userStore.create({
    username: 'wain_user', password: 'password123', role: 'user',
    createdBy: 'system', tenantId: 'wain',
    phone: '13800001111', phoneVerifiedAt: new Date().toISOString(),
  });

  const sender = new CaptureSender();
  const loginLogFilePath = join(tmpRoot, 'login.jsonl');
  const avatarsDir = join(tmpRoot, 'avatars');

  const app = express();
  // 与生产一致（index.ts）：信任代理头，让测试可通过 X-Forwarded-For 给每个用例
  // 分配独立 client IP，隔离按 IP keyed 的频控器（登录 + 短信发送/校验）。
  app.set('trust proxy', true);
  app.use(express.json());
  let currentCaller: JwtPayload | undefined = asCaller(superAdmin);
  app.use((req, _res, next) => {
    req.user = currentCaller;
    next();
  });
  app.use('/api/auth', createAuthRouter({
    userStore,
    tenantStore,
    jwtSecret: 'test-secret',
    tokenExpiresIn: '1h',
    avatarsDir,
    loginLogFilePath,
    agentCwd: join(tmpRoot, 'workspaces'),
    sharedDir: join(tmpRoot, 'shared'),
    ...(options.sms === false
      ? {}
      : {
          loginCodeService: new VerificationCodeService({
            sender,
            cooldownMs: options.sms?.cooldownMs ?? 0,
            ...(options.sms?.codeTtlMs !== undefined
              ? { codeTtlMs: options.sms.codeTtlMs }
              : {}),
          }),
        }),
  }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    users: { superAdmin, pantheonStaff, wainAdmin, wainUser },
    userStore,
    sender,
    loginLogFilePath,
    avatarsDir,
    setCaller(user) { currentCaller = user ? asCaller(user) : undefined; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function jsonInit(method: string, body: unknown, extraHeaders?: Record<string, string>): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** 播种一条操作日志（默认 wain 租户 page_viewed）。 */
async function seedLog(
  filePath: string,
  overrides: Partial<LoginLogEntry> & { username: string },
): Promise<void> {
  await appendLoginLog(
    {
      timestamp: new Date().toISOString(),
      event: 'page_viewed',
      tenantId: 'wain',
      ip: '9.9.9.9',
      userAgent: 'test',
      channel: 'web',
      ...overrides,
    },
    filePath,
  );
}

/** 1x1 PNG 字节（合法 image/png，过 multer fileFilter）。 */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQ' +
  'DJ/AP+AAAAAElFTkSuQmCC';

function fileForm(fieldFile: { name: string; type: string } | null): FormData {
  const form = new FormData();
  if (fieldFile) {
    const bytes = Buffer.from(PNG_1X1_BASE64, 'base64');
    form.append('avatar', new Blob([bytes], { type: fieldFile.type }), fieldFile.name);
  }
  return form;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /login-logs：requireSuperAdmin 门禁（07-18 从 requireAdmin 收紧，防回归核心）', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  it('组织 admin / 普通用户 / 匿名 → 403 SUPER_ADMIN_REQUIRED，且日志一条未删（含他租户日志）', async () => {
    // 07-18 前该路由是 requireAdmin：wainAdmin（组织 admin）会被放行并清掉全局
    // （含 acme 租户）的审计日志——本用例锁死收紧后的行为。
    await seedLog(h.loginLogFilePath, { username: 'wain_user', tenantId: 'wain' });
    await seedLog(h.loginLogFilePath, { username: 'acme_user', tenantId: 'acme' });

    for (const caller of [h.users.wainAdmin, h.users.wainUser, undefined]) {
      h.setCaller(caller);
      const res = await h.request('/api/auth/login-logs', { method: 'DELETE' });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('SUPER_ADMIN_REQUIRED');
      expect(body.error).toContain('平台超级管理员');
    }

    // 落盘副作用断言：日志文件未被清空
    const after = await queryLoginLogs({}, h.loginLogFilePath);
    expect(after.total).toBe(2);
  });

  it('非 super 的平台 admin（pantheon 员工）→ 403（路由级独立防线，不依赖 /api 层策略）', async () => {
    // 生产还有 enforcePlatformWritePolicy 在 /api 层兜底；本 rig 故意不挂它，
    // 证明 auth.ts 路由自身的 requireSuperAdmin 也能单独拦住万神殿普通员工。
    await seedLog(h.loginLogFilePath, { username: 'wain_user' });

    h.setCaller(h.users.pantheonStaff);
    const res = await h.request('/api/auth/login-logs', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('SUPER_ADMIN_REQUIRED');
    expect((await queryLoginLogs({}, h.loginLogFilePath)).total).toBe(1);
  });

  it('平台超管（@admin）→ 200 全量清空，清空后 GET 总数为 0（行为闭环）', async () => {
    await seedLog(h.loginLogFilePath, { username: 'u1' });
    await seedLog(h.loginLogFilePath, { username: 'u2' });
    await seedLog(h.loginLogFilePath, { username: 'u3', tenantId: 'acme' });

    h.setCaller(h.users.superAdmin);
    const res = await h.request('/api/auth/login-logs', { method: 'DELETE' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: 3 });

    const get = await h.request('/api/auth/login-logs');
    expect(get.status).toBe(200);
    expect((await get.json() as { total: number }).total).toBe(0);
  });

  it('超管带 before + excludeUsername 条件清理：早于 before 且不在豁免名单的被删', async () => {
    await seedLog(h.loginLogFilePath, {
      username: 'u_old', timestamp: '2020-05-05T00:00:00.000Z',
    });
    await seedLog(h.loginLogFilePath, {
      username: 'keep_me', timestamp: '2020-06-06T00:00:00.000Z',
    });
    await seedLog(h.loginLogFilePath, { username: 'u_new' }); // now（>= before）

    h.setCaller(h.users.superAdmin);
    const res = await h.request(
      '/api/auth/login-logs?before=2026-01-01T00:00:00.000Z&excludeUsername=keep_me',
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: 1 });

    const after = await queryLoginLogs({}, h.loginLogFilePath);
    expect(after.total).toBe(2);
    expect(after.entries.map((e) => e.username).sort()).toEqual(['keep_me', 'u_new']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('/me/phone/send-code 与 /me/phone/verify：验证码分支', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  it('未登录 401；手机号格式非法 400；code 非 6 位数字 400（zod 层）', async () => {
    h.setCaller(undefined);
    const anonSend = await h.request('/api/auth/me/phone/send-code',
      jsonInit('POST', { phone: '13900002222' }));
    expect(anonSend.status).toBe(401);
    const anonVerify = await h.request('/api/auth/me/phone/verify',
      jsonInit('POST', { phone: '13900002222', code: '123456' }));
    expect(anonVerify.status).toBe(401);

    h.setCaller(h.users.wainAdmin);
    // 第二位非 3-9 → 不符合大陆手机号格式
    const badPhone = await h.request('/api/auth/me/phone/send-code',
      jsonInit('POST', { phone: '12345678901' }));
    expect(badPhone.status).toBe(400);
    expect((await badPhone.json() as { error: string }).error).toBe('请输入有效的 11 位手机号');

    const badCode = await h.request('/api/auth/me/phone/verify',
      jsonInit('POST', { phone: '13900002222', code: 'abc123' }));
    expect(badCode.status).toBe(400);
    expect((await badCode.json() as { error: string }).error).toBe('验证码为 6 位数字');
  });

  it('verify 验证码错误 → 400 且不落库；随后用正确码重试成功并落库（闭环）', async () => {
    h.setCaller(h.users.wainAdmin);
    const phone = '13900003333';
    const send = await h.request('/api/auth/me/phone/send-code',
      jsonInit('POST', { phone }));
    expect(send.status).toBe(200);
    const correct = h.sender.lastCode;
    expect(correct).toMatch(/^\d{6}$/);

    // 错误验证码（保证与真码不同）→ 400，且用户记录未被写入手机号
    const wrong = correct === '000000' ? '111111' : '000000';
    const bad = await h.request('/api/auth/me/phone/verify',
      jsonInit('POST', { phone, code: wrong }));
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('验证码错误或已过期');
    expect(h.userStore.findById(h.users.wainAdmin.id)?.phone).toBeUndefined();

    // 错误尝试未达上限，正确码依然有效 → 200 + 落库
    const ok = await h.request('/api/auth/me/phone/verify',
      jsonInit('POST', { phone, code: correct }));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { phone: string; phoneVerifiedAt: string };
    expect(body.phone).toBe(phone);
    expect(body.phoneVerifiedAt).toBeTruthy();
    const record = h.userStore.findById(h.users.wainAdmin.id);
    expect(record?.phone).toBe(phone);
    expect(record?.phoneVerifiedAt).toBeTruthy();
  });

  it('verify 手机号已属他人 → 409，先于验证码校验拦截（无需发过码）', async () => {
    h.setCaller(h.users.wainAdmin);
    // 13800001111 是 wainUser 的已验证手机号；从未给它发过码也应先撞 409
    const res = await h.request('/api/auth/me/phone/verify',
      jsonInit('POST', { phone: '13800001111', code: '123456' }));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('手机号已存在');
  });

  it('send-code 单 IP 频控：每分钟第 6 次 → 429', async () => {
    h.setCaller(h.users.wainAdmin);
    const withIp = (phone: string) =>
      jsonInit('POST', { phone }, { 'X-Forwarded-For': '10.9.9.9' });
    for (let i = 0; i < 5; i++) {
      const ok = await h.request('/api/auth/me/phone/send-code', withIp('13900004444'));
      expect(ok.status).toBe(200); // cooldownMs=0，前 5 次全部放行
    }
    const limited = await h.request('/api/auth/me/phone/send-code', withIp('13900004444'));
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: string }).error).toBe('操作过于频繁，请稍后再试');
  });
});

describe('/me/phone/send-code：同号发送冷却（cooldown 60s rig）', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig({ sms: { cooldownMs: 60_000 } }); });
  afterEach(async () => { await h.close(); });

  it('冷却期内重复发送 → 429 + Retry-After 头', async () => {
    h.setCaller(h.users.wainAdmin);
    const first = await h.request('/api/auth/me/phone/send-code',
      jsonInit('POST', { phone: '13900005555' }));
    expect(first.status).toBe(200);

    const again = await h.request('/api/auth/me/phone/send-code',
      jsonInit('POST', { phone: '13900005555' }));
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await again.json() as { error: string }).error).toContain('发送过于频繁');
  });
});

describe('/me/phone/verify：验证码过期（codeTtl 1ms rig）', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig({ sms: { cooldownMs: 0, codeTtlMs: 1 } }); });
  afterEach(async () => { await h.close(); });

  it('过期后即使验证码正确也 → 400，且不落库', async () => {
    h.setCaller(h.users.wainAdmin);
    const phone = '13900006666';
    const send = await h.request('/api/auth/me/phone/send-code',
      jsonInit('POST', { phone }));
    expect(send.status).toBe(200);
    const correct = h.sender.lastCode;

    await sleep(20); // TTL 1ms，必然过期
    const res = await h.request('/api/auth/me/phone/verify',
      jsonInit('POST', { phone, code: correct }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('验证码错误或已过期');
    expect(h.userStore.findById(h.users.wainAdmin.id)?.phone).toBeUndefined();
  });
});

describe('短信通道未配置（无 loginCodeService rig）', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig({ sms: false }); });
  afterEach(async () => { await h.close(); });

  it('/me/phone/send-code、/me/phone/verify、/sms/send-code 均 403', async () => {
    h.setCaller(h.users.wainAdmin);
    const send = await h.request('/api/auth/me/phone/send-code',
      jsonInit('POST', { phone: '13900007777' }));
    expect(send.status).toBe(403);
    expect((await send.json() as { error: string }).error).toBe('当前未开放手机号验证');

    const verify = await h.request('/api/auth/me/phone/verify',
      jsonInit('POST', { phone: '13900007777', code: '123456' }));
    expect(verify.status).toBe(403);
    expect((await verify.json() as { error: string }).error).toBe('当前未开放手机号验证');

    const smsLogin = await h.request('/api/auth/sms/send-code',
      jsonInit('POST', { phone: '13800001111' }));
    expect(smsLogin.status).toBe(403);
    expect((await smsLogin.json() as { error: string }).error).toBe('当前未开放短信验证码登录');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('/sms/send-code：登录资格分支（现场侦察新增，SMS 侧为注入 fake）', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  it('未注册 404；手机号未验证 403 PHONE_NOT_VERIFIED；禁用用户 403 USER_DISABLED', async () => {
    // 未注册手机号
    const missing = await h.request('/api/auth/sms/send-code',
      jsonInit('POST', { phone: '13111112222' }));
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: string }).error).toBe('手机号未注册');

    // 有手机号但未验证 → 不能用于验证码登录
    await h.userStore.create({
      username: 'unverified_u', password: 'password123', role: 'user',
      createdBy: 'system', tenantId: 'wain', phone: '13511112222',
    });
    const unverified = await h.request('/api/auth/sms/send-code',
      jsonInit('POST', { phone: '13511112222' }));
    expect(unverified.status).toBe(403);
    expect((await unverified.json() as { code: string }).code).toBe('PHONE_NOT_VERIFIED');

    // 已验证但被禁用 → 拒发验证码（禁用闭环延伸到短信登录入口）
    const disabledUser = await h.userStore.create({
      username: 'disabled_u', password: 'password123', role: 'user',
      createdBy: 'system', tenantId: 'wain',
      phone: '13611112222', phoneVerifiedAt: new Date().toISOString(),
    });
    await h.userStore.setDisabled(disabledUser.id, true, h.users.superAdmin.id);
    const disabled = await h.request('/api/auth/sms/send-code',
      jsonInit('POST', { phone: '13611112222' }));
    expect(disabled.status).toBe(403);
    expect((await disabled.json() as { code: string }).code).toBe('USER_DISABLED');

    // 三次均被资格校验拦截，SMS 发送器从未被触达
    expect(h.sender.lastPhone).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /me/preferences', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  it('未登录 401；非法枚举 400；activeRoleId 空串 400', async () => {
    h.setCaller(undefined);
    const anon = await h.request('/api/auth/me/preferences',
      jsonInit('PATCH', { sidebarLayout: 'single' }));
    expect(anon.status).toBe(401);
    await expect(anon.json()).resolves.toMatchObject({ error: 'Not authenticated' });

    h.setCaller(h.users.wainUser);
    const badEnum = await h.request('/api/auth/me/preferences',
      jsonInit('PATCH', { sidebarLayout: 'triple' }));
    expect(badEnum.status).toBe(400);
    expect((await badEnum.json() as { error: string }).error).toBeTruthy();

    const emptyRole = await h.request('/api/auth/me/preferences',
      jsonInit('PATCH', { activeRoleId: '' }));
    expect(emptyRole.status).toBe(400);
    // 副作用断言：非法请求未写库
    expect(h.userStore.findById(h.users.wainUser.id)?.preferences?.activeRoleId).toBeUndefined();
  });

  it('200：增量合并落盘；未知键被 zod 剥离不落库', async () => {
    h.setCaller(h.users.wainUser);
    const first = await h.request('/api/auth/me/preferences',
      jsonInit('PATCH', { sidebarLayout: 'double', industryHint: 'trade' }));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { preferences: Record<string, unknown> };
    // 建号默认偏好（authorizationModeEnabled: true 等）与本次增量合并共存
    expect(firstBody.preferences).toMatchObject({
      sidebarLayout: 'double',
      industryHint: 'trade',
      authorizationModeEnabled: true,
    });

    // 第二次只改一个键 + 夹带未知键：已有键保持，未知键被剥离
    const second = await h.request('/api/auth/me/preferences',
      jsonInit('PATCH', { showSessionListAvatar: true, evil: 'x' }));
    expect(second.status).toBe(200);
    expect((await second.json() as { preferences: Record<string, unknown> }).preferences)
      .toMatchObject({ sidebarLayout: 'double', showSessionListAvatar: true });

    const record = h.userStore.findById(h.users.wainUser.id);
    expect(record?.preferences).toMatchObject({
      sidebarLayout: 'double',
      industryHint: 'trade',
      showSessionListAvatar: true,
    });
    expect('evil' in ((record?.preferences ?? {}) as Record<string, unknown>)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /login-logs：查询参数解析分支', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  async function seedFour(): Promise<void> {
    await seedLog(h.loginLogFilePath, { username: 'u1', timestamp: '2026-07-19T00:00:01.000Z' });
    await seedLog(h.loginLogFilePath, { username: 'u2', timestamp: '2026-07-19T00:00:02.000Z' });
    await seedLog(h.loginLogFilePath, { username: 'u3', timestamp: '2026-07-19T00:00:03.000Z' });
    await seedLog(h.loginLogFilePath, { username: 'u1', timestamp: '2026-07-19T00:00:04.000Z' });
  }

  it('username 单值 / 逗号多值 / 尾逗号（filter(Boolean)）', async () => {
    await seedFour();
    h.setCaller(h.users.wainAdmin);

    const single = await h.request('/api/auth/login-logs?username=u1');
    expect(single.status).toBe(200);
    const singleBody = await single.json() as { entries: Array<{ username: string }>; total: number };
    expect(singleBody.total).toBe(2);
    expect(singleBody.entries.every((e) => e.username === 'u1')).toBe(true);

    const multi = await h.request('/api/auth/login-logs?username=u1,u3');
    const multiBody = await multi.json() as { entries: Array<{ username: string }>; total: number };
    expect(multiBody.total).toBe(3);
    expect(multiBody.entries.some((e) => e.username === 'u2')).toBe(false);

    // 尾逗号被 filter(Boolean) 剔除，等价单值查询
    const trailing = await h.request('/api/auth/login-logs?username=u1%2C');
    expect((await trailing.json() as { total: number }).total).toBe(2);
  });

  it('limit + offset 解析生效：新→旧排序下取第 2 条', async () => {
    await seedFour();
    h.setCaller(h.users.wainAdmin);

    const res = await h.request('/api/auth/login-logs?limit=1&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Array<{ username: string }>; total: number };
    expect(body.total).toBe(4); // total 不受分页影响
    expect(body.entries).toHaveLength(1);
    // 新→旧：u1(04) → u3(03) → u2(02) → u1(01)；offset=1 命中 u3
    expect(body.entries[0].username).toBe('u3');
  });

  it('日志文件读取失败（路径被目录占用）→ 500', async () => {
    // 日志文件尚未创建；把路径变成目录使 readFile 抛 EISDIR，覆盖 catch 分支
    mkdirSync(h.loginLogFilePath, { recursive: true });
    h.setCaller(h.users.wainAdmin);
    const res = await h.request('/api/auth/login-logs');
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /avatar（本人头像上传）与 GET /avatar/:userId 文件服务', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  it('未登录（空表单）401；已登录未带文件 400', async () => {
    h.setCaller(undefined);
    const anon = await h.request('/api/auth/avatar', { method: 'POST', body: fileForm(null) });
    expect(anon.status).toBe(401);

    h.setCaller(h.users.wainUser);
    const noFile = await h.request('/api/auth/avatar', { method: 'POST', body: fileForm(null) });
    expect(noFile.status).toBe(400);
    expect((await noFile.json() as { error: string }).error).toBe('请选择图片文件');
    expect(h.userStore.findById(h.users.wainUser.id)?.avatar).toBeUndefined();
  });

  it('上传 PNG 成功；换 JPEG 后旧 .png 被清理且 avatarVersion 递增；GET 按版本设置缓存头', async () => {
    h.setCaller(h.users.wainUser);
    const uid = h.users.wainUser.id;

    // 首次上传 PNG
    const first = await h.request('/api/auth/avatar',
      { method: 'POST', body: fileForm({ name: 'a.png', type: 'image/png' }) });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { avatar: string; avatarVersion: number };
    expect(firstBody.avatar).toBe(`/api/auth/avatar/${uid}?v=${firstBody.avatarVersion}`);
    expect(readdirSync(h.avatarsDir)).toContain(`${uid}.png`);
    expect(h.userStore.findById(uid)?.avatar).toBe(`avatars/${uid}.png`);

    // 换 JPEG：旧扩展名文件被清理，avatarVersion（Date.now）递增
    await sleep(10);
    const second = await h.request('/api/auth/avatar',
      { method: 'POST', body: fileForm({ name: 'b.jpg', type: 'image/jpeg' }) });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { avatar: string; avatarVersion: number };
    expect(secondBody.avatarVersion).toBeGreaterThan(firstBody.avatarVersion);
    const files = readdirSync(h.avatarsDir);
    expect(files).toContain(`${uid}.jpg`);
    expect(files).not.toContain(`${uid}.png`);
    expect(h.userStore.findById(uid)?.avatar).toBe(`avatars/${uid}.jpg`);

    // 带版本号 → 一年 immutable；不带版本号 → 一天短缓存
    const versioned = await h.request(`/api/auth/avatar/${uid}?v=${secondBody.avatarVersion}`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const plain = await h.request(`/api/auth/avatar/${uid}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('GET /avatar/:userId：记录存在但文件缺失 → 404', async () => {
    await h.userStore.update(h.users.wainUser.id, { avatar: 'avatars/ghost.png' });
    const res = await h.request(`/api/auth/avatar/${h.users.wainUser.id}`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'Avatar file not found' });
  });

  it('已知缺陷记录：非图片 MIME 被 fileFilter 拒绝后无路由级捕获 → Express 默认 500', async () => {
    // auth.ts 的 avatar 路由未像 agents.ts/orgAgents.ts 那样捕获 multer 错误；
    // fileFilter 抛出的「仅支持 PNG、JPEG、WebP 格式的图片」落到 Express 默认
    // 错误处理器，对外表现为 500（而非语义正确的 4xx JSON）。固化现状防漂移。
    h.setCaller(h.users.wainUser);
    const res = await h.request('/api/auth/avatar',
      { method: 'POST', body: fileForm({ name: 'evil.txt', type: 'text/plain' }) });
    expect(res.status).toBe(500);
    // fileFilter 在写盘前拒绝：目录无残留文件，用户记录未被写
    expect(readdirSync(h.avatarsDir)).toHaveLength(0);
    expect(h.userStore.findById(h.users.wainUser.id)?.avatar).toBeUndefined();
  });
});
