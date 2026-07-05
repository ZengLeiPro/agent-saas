/**
 * 自助注册试用链路测试（官网联动 MVP）
 *
 * 覆盖：验证码服务（一次性/冷却/防爆破/万能码）+ 注册路由全链路
 * （开通租户/模型白名单/用户/计费 policy+grant/查重/回滚/开关）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TenantStore } from "../data/tenants/store.js";
import { UserStore } from "../data/users/store.js";
import type { BillingService } from "../data/billing/service.js";
import type { ModelsConfig, SelfSignupConfig } from "../app/config.js";
import { createSignupRouter } from "../routes/signup.js";
import {
  VerificationCodeService,
  type SmsSender,
} from "../integrations/sms/verificationService.js";

// ---- 测试基建 ----

class CaptureSender implements SmsSender {
  readonly providerName = "capture";
  lastPhone = "";
  lastCode = "";

  async sendCode(phone: string, code: string): Promise<void> {
    this.lastPhone = phone;
    this.lastCode = code;
  }
}

interface BillingCalls {
  policy?: { tenantId: string; patch: Record<string, unknown> };
  grant?: Record<string, unknown>;
}

function makeBillingMock(calls: BillingCalls, opts?: { failPolicy?: boolean }) {
  return {
    updateTenantPolicy: async (
      tenantId: string,
      patch: Record<string, unknown>,
    ) => {
      if (opts?.failPolicy) throw new Error("pg down");
      calls.policy = { tenantId, patch };
    },
    adjustAccount: async (input: Record<string, unknown>) => {
      calls.grant = input;
    },
  } as unknown as BillingService;
}

const MODELS_CONFIG = {
  groups: [],
  default: "test-group/test-model",
  allowCrossGroupSwitch: false,
} as unknown as ModelsConfig;

const SELF_SIGNUP: SelfSignupConfig = {
  enabled: true,
  grantCredits: 500,
};

const PHONE = "13800001111";

interface TestRig {
  tenantStore: TenantStore;
  userStore: UserStore;
  sender: CaptureSender;
  billingCalls: BillingCalls;
  request(path: string, body?: unknown): Promise<Response>;
  close(): Promise<void>;
}

async function makeTestRig(options?: {
  selfSignup?: SelfSignupConfig;
  failPolicy?: boolean;
  injectCodeService?: boolean;
}): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "signup-router-"));
  const tenantStore = new TenantStore(join(tmpRoot, "tenants.json"));
  // 模拟生产实况：平台根组织常驻（trial 租户永远不是唯一活跃租户，
  // 否则 setDisabled 的「最后一个活跃租户」保护会拦住回滚路径）
  await tenantStore.create({
    id: "pantheon",
    name: "万神殿",
    createdBy: "system",
  });
  const userStore = new UserStore(join(tmpRoot, "users.json"));
  const sender = new CaptureSender();
  const billingCalls: BillingCalls = {};
  const selfSignup = options?.selfSignup ?? SELF_SIGNUP;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/signup",
    createSignupRouter({
      userStore,
      tenantStore,
      billingService: makeBillingMock(billingCalls, {
        failPolicy: options?.failPolicy,
      }),
      modelsConfig: MODELS_CONFIG,
      selfSignup,
      jwtSecret: "test-secret-test-secret-test-secret",
      tokenExpiresIn: "1h",
      agentCwd: join(tmpRoot, "workspaces"),
      sharedDir: join(tmpRoot, "shared"),
      loginLogFilePath: join(tmpRoot, "login.jsonl"),
      codeService: selfSignup.enabled && options?.injectCodeService !== false
        ? new VerificationCodeService({ sender })
        : undefined,
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const baseUrl =
    typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

  return {
    tenantStore,
    userStore,
    sender,
    billingCalls,
    request: (path, body) =>
      fetch(`${baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

const REGISTER_BODY = {
  phone: PHONE,
  password: "secret123",
  name: "张总",
  position: "销售",
  company: "测试制造有限公司",
  utm: { utm_source: "website", utm_content: "ai-employee", evil: "drop-me" },
};

const DEV_SMS_LIMITS = {
  provider: "dev",
  codeTtlSeconds: 300,
  cooldownSeconds: 60,
  dailyLimitPerPhone: 10,
  maxVerifyAttempts: 5,
  maxSendPerIpPerMinute: 5,
  maxRegisterPerIpPerMinute: 5,
} satisfies NonNullable<SelfSignupConfig["sms"]>;

const ALIYUN_SMS_LIMITS = {
  ...DEV_SMS_LIMITS,
  provider: "aliyun",
} satisfies NonNullable<SelfSignupConfig["sms"]>;

// ---- 验证码服务单测 ----

describe("VerificationCodeService", () => {
  it("验证码一次性：成功消费后再验失败", async () => {
    const sender = new CaptureSender();
    const svc = new VerificationCodeService({ sender });
    const result = await svc.requestCode(PHONE);
    expect(result.ok).toBe(true);
    expect(sender.lastCode).toMatch(/^\d{6}$/);
    expect(svc.verifyAndConsume(PHONE, sender.lastCode)).toBe(true);
    expect(svc.verifyAndConsume(PHONE, sender.lastCode)).toBe(false);
  });

  it("同号发送冷却", async () => {
    const svc = new VerificationCodeService({ sender: new CaptureSender() });
    expect((await svc.requestCode(PHONE)).ok).toBe(true);
    const second = await svc.requestCode(PHONE);
    expect(second.ok).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("错误尝试 5 次后作废（真码也不再可用）", async () => {
    const sender = new CaptureSender();
    const svc = new VerificationCodeService({ sender });
    await svc.requestCode(PHONE);
    for (let i = 0; i < 5; i += 1) {
      expect(svc.verifyAndConsume(PHONE, "000000")).toBe(false);
    }
    expect(svc.verifyAndConsume(PHONE, sender.lastCode)).toBe(false);
  });

  it("万能码（内测）可通过且不依赖已发送验证码", () => {
    const svc = new VerificationCodeService({
      sender: {
        providerName: "dev",
        sendCode: async () => {},
      },
      universalCode: "424242",
    });
    expect(svc.verifyAndConsume(PHONE, "424242")).toBe(true);
  });

  it("万能码在非 dev sender 下被忽略", () => {
    const svc = new VerificationCodeService({
      sender: {
        providerName: "aliyun",
        sendCode: async () => {},
      },
      universalCode: "424242",
    });
    expect(svc.verifyAndConsume(PHONE, "424242")).toBe(false);
  });

  it("错误尝试次数可配置", async () => {
    const sender = new CaptureSender();
    const svc = new VerificationCodeService({
      sender,
      maxVerifyAttempts: 2,
    });
    await svc.requestCode(PHONE);
    expect(svc.verifyAndConsume(PHONE, "000000")).toBe(false);
    expect(svc.verifyAndConsume(PHONE, "111111")).toBe(false);
    expect(svc.verifyAndConsume(PHONE, sender.lastCode)).toBe(false);
  });

  it("同号日限可配置", async () => {
    const svc = new VerificationCodeService({
      sender: new CaptureSender(),
      cooldownMs: 0,
      dailyLimitPerPhone: 1,
    });
    expect((await svc.requestCode(PHONE)).ok).toBe(true);
    const second = await svc.requestCode(PHONE);
    expect(second.ok).toBe(false);
    expect(second.error).toBe("该手机号今日获取验证码次数已达上限");
  });
});

// ---- 注册路由集成 ----

describe("signup router", () => {
  let h: TestRig;

  afterEach(async () => {
    await h?.close();
  });

  it("status 反映开关状态", async () => {
    h = await makeTestRig();
    const res = await h.request("/api/signup/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("aliyun provider 配置不齐时失败关闭，不回退 dev", async () => {
    const originalSecret = process.env.AGENT_SMS_ACCESS_KEY_SECRET;
    delete process.env.AGENT_SMS_ACCESS_KEY_SECRET;
    try {
      h = await makeTestRig({
        injectCodeService: false,
        selfSignup: {
          enabled: true,
          grantCredits: 500,
          sms: {
            ...ALIYUN_SMS_LIMITS,
            accessKeyId: "ak-test",
            signName: "开沿科技",
          },
        },
      });

      const status = await h.request("/api/signup/status");
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ enabled: false });
      expect(
        (await h.request("/api/signup/send-code", { phone: PHONE })).status,
      ).toBe(403);
    } finally {
      if (originalSecret === undefined) {
        delete process.env.AGENT_SMS_ACCESS_KEY_SECRET;
      } else {
        process.env.AGENT_SMS_ACCESS_KEY_SECRET = originalSecret;
      }
    }
  });

  it("未启用时 send-code/register 拒绝但 status 可用", async () => {
    h = await makeTestRig({
      selfSignup: { enabled: false, grantCredits: 500 },
    });
    expect((await h.request("/api/signup/status")).status).toBe(200);
    expect(
      (await h.request("/api/signup/send-code", { phone: PHONE })).status,
    ).toBe(403);
    expect(
      (await h.request("/api/signup/register", REGISTER_BODY)).status,
    ).toBe(403);
  });

  it("发送验证码 IP 频控可配置", async () => {
    h = await makeTestRig({
      selfSignup: {
        enabled: true,
        grantCredits: 500,
        sms: {
          ...DEV_SMS_LIMITS,
          maxSendPerIpPerMinute: 1,
        },
      },
    });

    expect(
      (await h.request("/api/signup/send-code", { phone: PHONE })).status,
    ).toBe(200);
    expect(
      (await h.request("/api/signup/send-code", { phone: "13900001111" })).status,
    ).toBe(429);
  });

  it("完整注册链路：租户+模型白名单+用户+计费+token", async () => {
    h = await makeTestRig();
    const sent = await h.request("/api/signup/send-code", { phone: PHONE });
    expect(sent.status).toBe(200);
    expect(h.sender.lastPhone).toBe(PHONE);

    const res = await h.request("/api/signup/register", {
      ...REGISTER_BODY,
      code: h.sender.lastCode,
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      token: string;
      user: {
        username: string;
        tenantId: string;
        position?: string;
        phone?: string;
        role: string;
      };
    };
    expect(data.token).toBeTruthy();
    expect(data.user.username).toBe(PHONE);
    expect(data.user.role).toBe("user");
    expect(data.user.tenantId).toMatch(/^trial-[a-z0-9]{8}$/);
    expect(data.user.position).toBe("销售");
    expect(data.user.phone).toBe(PHONE);

    // 租户：名称取公司名，模型白名单锁到全局默认模型且禁切换
    const tenant = h.tenantStore.findById(data.user.tenantId);
    expect(tenant?.name).toBe("测试制造有限公司");
    const settings = h.tenantStore.getSettings(data.user.tenantId);
    expect(settings?.models.allowedModels).toEqual(["test-group/test-model"]);
    expect(settings?.models.defaultModel).toBe("test-group/test-model");
    expect(settings?.models.allowUserModelSwitch).toBe(false);

    // 计费：trial + 硬封顶 + 赠送
    expect(h.billingCalls.policy?.tenantId).toBe(data.user.tenantId);
    expect(h.billingCalls.policy?.patch).toMatchObject({
      billingEnabled: true,
      billingMode: "trial",
      hardCapMode: "stop_before_run",
    });
    expect(h.billingCalls.grant).toMatchObject({
      tenantId: data.user.tenantId,
      creditsDelta: 500,
      type: "grant",
    });

    // 用户持久化：phone 写入
    const record = h.userStore.findByUsername(PHONE);
    expect(record?.phone).toBe(PHONE);
  });

  it("验证码错误返回 400，不创建任何资源", async () => {
    h = await makeTestRig();
    await h.request("/api/signup/send-code", { phone: PHONE });
    const res = await h.request("/api/signup/register", {
      ...REGISTER_BODY,
      code: "000000",
    });
    expect(res.status).toBe(400);
    expect(h.userStore.listAll()).toHaveLength(0);
    expect(
      h.tenantStore.listAll().filter((t) => t.id.startsWith("trial-")),
    ).toHaveLength(0);
  });

  it("已注册手机号：send-code 与 register 均 409", async () => {
    h = await makeTestRig();
    await h.request("/api/signup/send-code", { phone: PHONE });
    await h.request("/api/signup/register", {
      ...REGISTER_BODY,
      code: h.sender.lastCode,
    });

    expect(
      (await h.request("/api/signup/send-code", { phone: PHONE })).status,
    ).toBe(409);
    // 新验证码走万能码不可得，用旧码也应先撞 409 查重
    const res = await h.request("/api/signup/register", {
      ...REGISTER_BODY,
      code: h.sender.lastCode,
    });
    expect(res.status).toBe(409);
  });

  it("计费写入失败时回滚：用户删除、租户禁用、返回 500", async () => {
    h = await makeTestRig({ failPolicy: true });
    await h.request("/api/signup/send-code", { phone: PHONE });
    const res = await h.request("/api/signup/register", {
      ...REGISTER_BODY,
      code: h.sender.lastCode,
    });
    expect(res.status).toBe(500);
    expect(h.userStore.listAll()).toHaveLength(0);
    const trialTenants = h.tenantStore
      .listAll()
      .filter((t) => t.id.startsWith("trial-"));
    expect(trialTenants).toHaveLength(1);
    expect(trialTenants[0].disabled).toBe(true);
  });
});
