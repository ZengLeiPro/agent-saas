import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 图标体系守护测试（2026-07-15 Batch 3 上线）：
 * 1. 概念图标必须走 lib/icons.ts 语义注册表，禁止业务代码直接 import；
 * 2. lucide 已弃用的旧别名禁止引入（统一新命名）；
 * 3. strokeWidth 只允许 1.5（大图标减重）与 2.5（强调）两种显式取值（默认 2 不显式写）。
 * 违规时的正确修法：从 "@/lib/icons" 取 EntityIcons/StatusIcons/ActionIcons，
 * 或为新概念在注册表补充条目后使用。
 */

/** 概念图标：语义已被注册表锚定，直接 import 会破坏「一概念一图标」 */
const CONCEPT_ICONS = [
  "Building2",   // EntityIcons.org
  "ShieldCheck", // EntityIcons.admin
  "Blocks",      // EntityIcons.capabilityCenter
  "ScrollText",  // EntityIcons.audit
  "ChartColumn", // EntityIcons.analytics
  "WalletCards", // EntityIcons.billing
  "Coins",       // EntityIcons.credits
  "Recycle",     // EntityIcons.trash
  "Files",       // EntityIcons.files
  "Puzzle",      // EntityIcons.skill
  "Plug",        // EntityIcons.connector
  "Cpu",         // EntityIcons.model
  "Library",     // EntityIcons.knowledgeBase
];

/** lucide 旧别名 → 新命名 */
const DEPRECATED_ALIASES: Record<string, string> = {
  AlertCircle: "CircleAlert",
  CheckCircle2: "CircleCheck",
  CheckCircle: "CircleCheckBig",
  XCircle: "CircleX",
  AlertTriangle: "TriangleAlert",
  BarChart3: "ChartColumn",
  BarChart2: "ChartColumnBig",
};

const SRC_ROOT = join(__dirname, "..");
const REGISTRY_FILE = join(__dirname, "icons.ts");

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      collectSourceFiles(p, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

/** 提取文件中所有 lucide-react import 的标识符（含 type import，剥离 as 别名与 type 前缀） */
function lucideImports(source: string): string[] {
  const names: string[] = [];
  const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']lucide-react["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    for (const raw of m[1].split(",")) {
      const name = raw.replace(/\btype\b/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("图标体系守护", () => {
  const files = collectSourceFiles(SRC_ROOT).filter((p) => p !== REGISTRY_FILE);

  it("概念图标不得绕过 lib/icons.ts 注册表直接 import", () => {
    const violations: string[] = [];
    for (const file of files) {
      const names = lucideImports(readFileSync(file, "utf8"));
      for (const name of names) {
        if (CONCEPT_ICONS.includes(name)) {
          violations.push(`${relative(SRC_ROOT, file)}: ${name}（应走 lib/icons.ts 注册表）`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("禁止引入 lucide 已弃用旧别名（统一新命名）", () => {
    const violations: string[] = [];
    for (const file of files) {
      const names = lucideImports(readFileSync(file, "utf8"));
      for (const name of names) {
        if (name in DEPRECATED_ALIASES) {
          violations.push(`${relative(SRC_ROOT, file)}: ${name} → 应使用 ${DEPRECATED_ALIASES[name]}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("strokeWidth 显式取值仅允许 1.5（大图标减重）或 2.5（强调）", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // 仅检查 JSX 属性写法；SVG 图表（stroke-width 变量/自绘 path）不在 lucide 图标范围
      const re = /strokeWidth=\{(\d+(?:\.\d+)?)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) {
        const value = Number(m[1]);
        if (value !== 1.5 && value !== 2.5) {
          violations.push(`${relative(SRC_ROOT, file)}: strokeWidth={${m[1]}}`);
        }
      }
    }
    // 允许清单：自绘 SVG（非 lucide 图标）的 stroke 宽度
    const allowed = new Set([
      "components/MessageList.tsx: strokeWidth={1}",          // 用户气泡 tail 自绘 path
      "components/mobile/PullToRefresh.tsx: strokeWidth={4}", // 下拉刷新自绘 spinner
    ]);
    const real = violations.filter((v) => !allowed.has(v));
    expect(real, real.join("\n")).toEqual([]);
  });
});
