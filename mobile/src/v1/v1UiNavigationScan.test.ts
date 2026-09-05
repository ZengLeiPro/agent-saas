/**
 * M00-01：生产可见界面的导航目标扫描测试（生产菜单快照 + 深链可达性）。
 *
 * 扫描 V1 生产可达的 UI 源文件，提取所有 router.push / router.replace /
 * href 的路由目标，断言：
 *   1. 每个目标路由在生产档位要么被 allowlist 放行，要么在源文件中
 *      通过 `isV1RouteAllowed("<route>", ...)` 显式门控（fail closed）；
 *   2. 目标路由都能被能力清单解析（防止导航到未分类路由）；
 *   3. 生产可见界面无 Spike 入口残留。
 *
 * 该测试与 v1RouteInventory.test.ts 互补：清单测试约束「路由全集」，
 * 本测试约束「生产界面的导航行为」。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  V1_ALLOWED_ROUTES,
  V1_DEFERRED_ROUTES,
  classifyV1Route,
  type V1RouteClassification,
} from './v1Capabilities';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = join(HERE, '..', '..');

/** V1 生产构建可达的 UI 界面（M00-01 裁剪后的生产信息架构）。 */
const PRODUCTION_REACHABLE_UI: readonly string[] = [
  'app/_layout.tsx',
  'app/index.tsx',
  'app/login.tsx',
  'app/+not-found.tsx',
  'app/(tabs)/_layout.tsx',
  'app/(tabs)/chat/index.tsx',
  'app/(tabs)/settings/index.tsx',
  'app/chat/[sessionId].tsx',
  'app/settings/user-detail/[userId].tsx',
  'app/settings/agent-profile/index.tsx',
  'src/components/settings/AgentProfileEditor.tsx',
  // P3-3a 能力中心：四 Tab 路由、Tab 切换与会话列表入口
  'app/capabilities/index.tsx',
  'app/capabilities/workflows.tsx',
  'app/capabilities/skills.tsx',
  'app/capabilities/connectors.tsx',
  'app/capabilities/experts.tsx',
  'src/components/capabilities/CapabilityTabBar.tsx',
  'src/components/sessions/SessionPillRow.tsx',
  // P3-3b 任务中心：列表 / 详情 / 创建编辑，以及表单里跳转全屏文本编辑器
  'app/cron/index.tsx',
  'app/cron/[jobId].tsx',
  'app/cron-form.tsx',
  'app/text-editor.tsx',
  'src/components/cron/CronJobForm.tsx',
  'src/components/cron/JobList.tsx',
  'src/hooks/useCapabilityContext.ts',
  // P3-3c 文件中心：浏览 / 子目录 / 通用预览，以及条目点击分派与引用卡
  'app/files/index.tsx',
  'app/files/browse.tsx',
  'app/files/preview.tsx',
  'app/chat/markdown-preview.tsx',
  'src/hooks/useFileEntryPress.ts',
  'src/components/chat/blocks/CitationCard.tsx',
  // 路由门禁本身也是生产可达代码（其 replace 目标为动态值，不受字符串扫描影响，
  // 行为由 v1RouteGate.runtime.test.tsx 运行时守卫覆盖）
  'src/v1/V1RouteGate.tsx',
];

/** 提取 push/replace/href 的字符串字面量目标（含模板字面量）。 */
const NAV_TARGET_RE =
  /(?:\.push|\.replace|href)\s*[=(]\s*\{?\s*(?:pathname:\s*)?(['"`])([^'"`]+)\1/g;

function normalizeTarget(raw: string): string | null {
  // 模板字面量中的插值段视为动态段通配（* 可被 [^/]+ 匹配）。
  const templated = raw.replace(/\$\{[^}]*\}/g, '*');
  const target = templated.split('?')[0].replace(/^\/+/, '');
  if (!target) return null;
  return target;
}

/** 将清单路由 pattern 转为正则：[name] -> [^/]+，插值通配 \u0000* -> [^/]*。 */
function routeToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\[[^\]]+\\\]/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

/** 解析导航目标的分类；支持动态路由/插值通配匹配。 */
function resolveClassification(target: string): V1RouteClassification | null {
  const direct = classifyV1Route(target);
  if (direct !== 'unclassified') return direct;
  const patterns = [...V1_ALLOWED_ROUTES, ...Object.keys(V1_DEFERRED_ROUTES)];
  for (const pattern of patterns) {
    const re = routeToRegExp(pattern);
    if (re.test(target)) {
      return classifyV1Route(pattern);
    }
  }
  return null;
}

interface Finding {
  file: string;
  target: string;
  classification: V1RouteClassification | null;
}

/** 去掉块注释与整行注释，避免被注释掉的旧代码产生误报。
 *  注意：不能剥出行内尾注释，以免破坏字符串中的 `//`（如 URL）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function scanNavigationTargets(): Finding[] {
  const findings: Finding[] = [];
  for (const rel of PRODUCTION_REACHABLE_UI) {
    const content = stripComments(
      readFileSync(join(MOBILE_ROOT, rel), 'utf8'),
    );
    for (const match of content.matchAll(NAV_TARGET_RE)) {
      const target = normalizeTarget(match[2]);
      if (!target) continue;
      findings.push({
        file: rel,
        target,
        classification: resolveClassification(target),
      });
    }
  }
  return findings;
}

describe('M00-01 生产界面导航扫描', () => {
  const findings = scanNavigationTargets();

  it('扫描能提取到导航目标（防止正则/路径失效导致空跑）', () => {
    expect(findings.length).toBeGreaterThan(5);
    // 登录/对话回跳等根导航目标（登录回跳现由 V1RouteGate 动态执行，
    // 由 v1RouteGate.runtime.test.tsx 运行时断言；此处抽查静态导航样本）
    expect(findings.some((f) => f.target === '(tabs)/chat')).toBe(true);
    expect(findings.some((f) => f.target === 'settings/agent-profile')).toBe(true);
    // P3-3a：会话列表 pill 与 Tab 切换的导航目标都必须被扫到
    expect(findings.some((f) => f.target === 'capabilities')).toBe(true);
    expect(findings.some((f) => f.target === 'capabilities/experts')).toBe(true);
    // P3-3b：任务中心入口、详情深链与创建编辑页都必须被扫到
    expect(findings.some((f) => f.target === 'cron')).toBe(true);
    expect(findings.some((f) => f.target === 'cron/[jobId]')).toBe(true);
    expect(findings.some((f) => f.target === 'cron-form')).toBe(true);
    expect(findings.some((f) => f.target === 'text-editor')).toBe(true);
    // P3-3c：文件中心入口、子目录深链与通用预览路由都必须被扫到
    expect(findings.some((f) => f.target === 'files')).toBe(true);
    expect(findings.some((f) => f.target === 'files/browse')).toBe(true);
    expect(findings.some((f) => f.target === 'files/preview')).toBe(true);
    expect(findings.some((f) => f.target === 'chat/markdown-preview')).toBe(true);
  });

  it('所有导航目标都能被能力清单解析（无未分类路由）', () => {
    const unresolvable = findings.filter((f) => f.classification === null);
    expect(
      unresolvable,
      `无法解析的导航目标：\n${unresolvable
        .map((f) => `${f.file} -> ${f.target}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('延期路由目标必须被同文件 isV1RouteAllowed("<route>") 显式门控', () => {
    const offenders: string[] = [];
    for (const finding of findings) {
      if (finding.classification !== 'deferred') continue;
      const content = readFileSync(join(MOBILE_ROOT, finding.file), 'utf8');
      const gateRe = new RegExp(
        `isV1RouteAllowed\\(\\s*(['\"])${finding.target.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        )}\\1`,
      );
      if (!gateRe.test(content)) {
        offenders.push(`${finding.file} -> ${finding.target}`);
      }
    }
    expect(
      offenders,
      `以下延期路由导航未经 V1 门控（生产必须 fail closed）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('生产可达界面无 Spike 入口（webview-spike 字样零残留）', () => {
    for (const rel of PRODUCTION_REACHABLE_UI) {
      const content = readFileSync(join(MOBILE_ROOT, rel), 'utf8');
      expect(content.includes('webview-spike'), rel).toBe(false);
      expect(content.includes('Web 版体验'), rel).toBe(false);
    }
  });

  it('设置页保留的生产菜单快照（对话/设置 + 账号/Agent/通用/退出）', () => {
    const settings = readFileSync(
      join(MOBILE_ROOT, 'app/(tabs)/settings/index.tsx'),
      'utf8',
    );
    // V1 IA（方案 §1.3）：当前账号与当前 Agent / 字体与必要偏好 / 退出登录。
    for (const label of ['账户', 'Agent', '字体大小', '退出登录']) {
      expect(settings.includes(label), `设置页缺少 V1 信息架构菜单：${label}`).toBe(true);
    }
  });
});
