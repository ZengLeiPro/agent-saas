/**
 * CRM 单轨推送协议测试
 *
 * 验证与 ky-azeroth verifySignature / kaiyan.net collector 的协议一致性：
 * stableStringify（key 排序 + 过滤 undefined + 数组递归）与 HMAC 签名格式。
 * azeroth 侧算法参照 apps/server/src/modules/website-leads/website-leads.service.ts。
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildTrialSignupPayload,
  stableStringify,
} from "../integrations/azeroth/websiteLeadSync.js";

describe("stableStringify（与 azeroth/collector 逐字节一致）", () => {
  it("key 排序 + 过滤 undefined + 保留 null + 数组递归", () => {
    expect(
      stableStringify({ b: 1, a: "x", skip: undefined, n: null, arr: [{ z: 1, y: 2 }] }),
    ).toBe('{"a":"x","arr":[{"y":2,"z":1}],"b":1,"n":null}');
  });

  it("标量与嵌套对象", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("s")).toBe('"s"');
    expect(stableStringify({ o: { b: 2, a: 1 } })).toBe('{"o":{"a":1,"b":2}}');
  });
});

describe("buildTrialSignupPayload", () => {
  const info = {
    userId: "user-abc123",
    phone: "13800001111",
    name: "张总",
    position: "老板/总经理",
    company: "测试制造有限公司",
    scenario: "boss-competitor-daily",
    tenantId: "trial-ab12cd34",
    utm: { utm_source: "website", utm_content: "scenario_boss-competitor-daily" },
  };

  it("payload 结构：sourceId 幂等键 + event + utm 展开", () => {
    const payload = buildTrialSignupPayload(info);
    expect(payload).toMatchObject({
      sourceId: "ts_user-abc123",
      event: "trial_signup",
      site: "agent.kaiyan.net",
      phone: "13800001111",
      channel: "ai_employee",
      name: "张总",
      scenario: "boss-competitor-daily",
      tenantId: "trial-ab12cd34",
      utmSource: "website",
      utmContent: "scenario_boss-competitor-daily",
      utmMedium: null,
    });
  });

  it("签名可被 azeroth 端算法验证（同 secret 同串复算一致）", () => {
    const payload = buildTrialSignupPayload(info);
    const secret = "website-lead-secret-for-test";
    const timestamp = "1720000000000";
    // 发送端算法
    const sent = createHmac("sha256", secret)
      .update(`${timestamp}.${stableStringify(payload)}`)
      .digest("hex");
    // azeroth verifySignature 的期望值算法（同构复刻）
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${stableStringify(JSON.parse(JSON.stringify(payload)))}`)
      .digest("hex");
    expect(sent).toBe(expected);
  });
});
