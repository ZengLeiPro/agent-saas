// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * URL 契约守护测试（S4 上线）。
 *
 * 为什么需要它：URL 参数名是**对外契约**。改一个 key 名，已经分享出去的链接不会报错、
 * 不会崩溃，只是「对方打开看到的是默认值」——静默失效，测试和类型都拦不住。
 * 这里把每个参数名钉在它的宿主文件上，重命名时必须同时改契约表（并考虑旧 key 兼容）。
 *
 * 同时守两条结构性红线：
 *   1. `dispatchEvent(new PopStateEvent(...))` 只允许出现在 lib/urlSync.ts（土制路由的唯一派发点）；
 *   2. 客户面模块（TenantAnalytics / QaConsole / UsageDashboard / AdminShells 的组织侧）
 *      的 URL 参数名不得直接用内部字段名。
 */

const SRC_ROOT = join(__dirname, "..");

/**
 * URL 参数契约表：文件 → 该文件必须仍然读写的参数名。
 * 与 assets/20260725/S4实施报告.md 的「URL 参数契约表」一一对应。
 */
const URL_PARAM_CONTRACT: Record<string, string[]> = {
  // ── platform-admin（内部运维，可用工程术语） ──
  "components/PlatformAdmin/ToolAnalysisPanel.tsx": [
    "toolTenantId", "toolUserId", "toolName", "skillName", "toolStatus", "toolHours", "toolOffset", "toolError",
  ],
  "components/UsageDashboard/EfficiencyView.tsx": ["effDays"],
  // ── 双受众（平台运维 + 组织管理员共用同一面板） ──
  "components/AdminShells.tsx": ["org"],
  "components/GovernanceAuditPanel.tsx": [
    "auditType", "auditChannel", "auditUser", "auditOrg", "auditFrom", "auditTo",
  ],
  // ── tenant-admin（客户视图，参数名必须业务可读） ──
  "components/UsageDashboard/index.tsx": [
    "usageRange", "usageFrom", "usageTo", "usageModelGroup", "usageView", "usageUser", "usageSort", "usageSortDir",
  ],
  "components/OrganizationGovernance/OrganizationUsageBillingPage.tsx": ["usageSection"],
  "components/OrganizationGovernance/OrganizationGovernancePage.tsx": [
    "contextTenant", "contextView", "contextFilter", "contextEntity",
  ],
  "components/TenantAnalytics/OverviewSection.tsx": ["orgRange", "orgFrom", "orgTo"],
  "components/QaConsole/index.tsx": ["qaView"],
  "components/QaConsole/SessionsView.tsx": ["qaAgent", "qaMember", "qaFrom", "qaTo"],
  "components/QaConsole/GuardrailEventsView.tsx": ["qaLogAgent", "qaLogResult", "qaLogFrom", "qaLogTo"],
  "components/QaConsole/GuardrailBoardView.tsx": [
    "qaBoardTab", "qaBoardMode", "qaBoardAgent", "qaBoardFrom", "qaBoardTo",
  ],
  "components/QaConsole/FeedbackView.tsx": ["qaFeedbackAgent", "qaFeedbackFrom", "qaFeedbackTo"],
};

/**
 * 客户面（tenant-admin）URL 参数名禁用词：内部字段名 / 工程术语。
 * 客户看得见地址栏，参数名也是产品文案的一部分。
 */
const CUSTOMER_FACING_FILES = [
  "components/UsageDashboard/index.tsx",
  "components/OrganizationGovernance/OrganizationUsageBillingPage.tsx",
  "components/OrganizationGovernance/OrganizationGovernancePage.tsx",
  "components/TenantAnalytics/OverviewSection.tsx",
  "components/QaConsole/index.tsx",
  "components/QaConsole/SessionsView.tsx",
  "components/QaConsole/GuardrailEventsView.tsx",
  "components/QaConsole/GuardrailBoardView.tsx",
  "components/QaConsole/FeedbackView.tsx",
];

/** 这些名字一旦作为 URL 参数名出现在客户面，就是把内部字段名泄漏给客户 */
const FORBIDDEN_CUSTOMER_PARAM_NAMES = [
  "tenantId", "orgAgentId", "userId", "family", "verdict", "runId", "sessionId", "sandboxName", "workspaceId",
];

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      acc.push(p);
    }
  }
  return acc;
}

/** 抓出 url.get("x") / url.set("x", …) / patch({ x: … }) 这类字面量参数名 */
function urlParamLiterals(source: string): Set<string> {
  const found = new Set<string>();
  const re = /\.(?:get|set)\(\s*["']([A-Za-z][\w-]*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) found.add(m[1]);
  // 常量声明形式：const XXX_KEY = "yyy"
  const constRe = /_KEY\s*=\s*["']([A-Za-z][\w-]*)["']/g;
  while ((m = constRe.exec(source))) found.add(m[1]);
  // patch / 对象字面量里的 key（含计算属性 [XXX_KEY]）
  const patchRe = /\.patch\(\s*\{([^}]*)\}/g;
  while ((m = patchRe.exec(source))) {
    const keyRe = /(?:^|[,{\s])([A-Za-z][\w-]*)\s*:/g;
    let k: RegExpExecArray | null;
    while ((k = keyRe.exec(m[1]))) found.add(k[1]);
  }
  return found;
}

describe("URL 参数契约", () => {
  it("契约表里的每个参数名都仍在其宿主文件中被读写", () => {
    const violations: string[] = [];
    for (const [file, params] of Object.entries(URL_PARAM_CONTRACT)) {
      const source = readFileSync(join(SRC_ROOT, file), "utf8");
      for (const param of params) {
        // 参数名可能以字面量或 *_KEY 常量出现，统一按「源码里包含这个字符串」判定
        if (!source.includes(`"${param}"`) && !source.includes(`'${param}'`)) {
          violations.push(`${file}: 契约参数 ${param} 已从源码消失（改名会让已分享的链接静默失效）`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("客户面 URL 参数名不得使用内部字段名", () => {
    const violations: string[] = [];
    for (const file of CUSTOMER_FACING_FILES) {
      const source = readFileSync(join(SRC_ROOT, file), "utf8");
      for (const param of urlParamLiterals(source)) {
        if (FORBIDDEN_CUSTOMER_PARAM_NAMES.includes(param)) {
          violations.push(`${file}: URL 参数名 ${param} 是内部字段名，客户面必须换成业务可读词`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("popstate 派发只允许出现在 lib/urlSync.ts（土制路由唯一派发点）", () => {
    const violations: string[] = [];
    const allowed = join(SRC_ROOT, "lib", "urlSync.ts");
    for (const file of collectSourceFiles(SRC_ROOT)) {
      if (file === allowed) continue;
      const source = readFileSync(file, "utf8");
      // 允许多行折行写法，因此按去掉空白后匹配
      if (/dispatchEvent\(\s*new\s+PopStateEvent/.test(source.replace(/\s+/g, " "))) {
        violations.push(`${relative(SRC_ROOT, file)}: 请改用 urlSync 的 navigatePlatformAdmin / navigateTenantAdmin / navigateAdminSettings / navigateToHref`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  }, 15_000);
});
