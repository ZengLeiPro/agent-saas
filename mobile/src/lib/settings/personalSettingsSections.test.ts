/**
 * P3-3d：个人设置 8 分区注册表与 Web 的同名同序契约测试。
 *
 * Web 的权威源是 `web/src/lib/unifiedSettingsRegistry.ts`（跨 package 不能直接
 * import，这里按文本解析其 `scope: "personal"` 条目），断言：
 *   1. id / label / group 与顺序逐条一致（将来 Web 改分区，本测试立刻失败）；
 *   2. 分组标题与 Web `SettingsCenter/settingsConfig.ts` 的 SETTINGS_GROUP_LABELS 一致；
 *   3. 每个 Stack 路由落点都已被 V1 能力清单放行（生产不会跳到 fail closed 路由）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyV1Route } from '../../v1/v1Capabilities';
import {
  PERSONAL_SETTINGS_GROUP_LABELS,
  PERSONAL_SETTINGS_GROUP_ORDER,
  PERSONAL_SETTINGS_SECTIONS,
  groupPersonalSettingsSections,
  personalSettingsRoutes,
} from './personalSettingsSections';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, '..', '..', '..', '..');

interface WebPersonalEntry {
  id: string;
  label: string;
  group: string;
  iconKey: string;
}

/** 解析 Web 注册表里 scope: "personal" 的条目（保持声明顺序）。 */
function readWebPersonalSections(): WebPersonalEntry[] {
  const source = readFileSync(
    join(REPOSITORY_ROOT, 'web/src/lib/unifiedSettingsRegistry.ts'),
    'utf8',
  );
  const entries: WebPersonalEntry[] = [];
  for (const line of source.split('\n')) {
    if (!line.includes('scope: "personal"')) continue;
    const id = /\bid: "([^"]+)"/.exec(line)?.[1];
    const label = /\blabel: "([^"]+)"/.exec(line)?.[1];
    const group = /\bgroup: "([^"]+)"/.exec(line)?.[1];
    const iconKey = /\biconKey: "([^"]+)"/.exec(line)?.[1];
    if (!id || !label || !group || !iconKey) continue;
    entries.push({ id, label, group, iconKey });
  }
  return entries;
}

describe('P3-3d 个人设置分区与 Web 对齐', () => {
  const webSections = readWebPersonalSections();

  it('能解析到 Web 的 8 个个人分区（防止解析失效导致空跑）', () => {
    expect(webSections).toHaveLength(8);
    expect(webSections[0].id).toBe('account-security');
  });

  it('id / label / group / iconKey 与 Web 逐条同名同序', () => {
    expect(
      PERSONAL_SETTINGS_SECTIONS.map((section) => ({
        id: section.id,
        label: section.label,
        group: section.group,
        iconKey: section.iconKey,
      })),
    ).toEqual(webSections);
  });

  it('分组顺序与标题与 Web SETTINGS_GROUP_LABELS 一致', () => {
    const source = readFileSync(
      join(REPOSITORY_ROOT, 'web/src/components/SettingsCenter/settingsConfig.ts'),
      'utf8',
    );
    for (const group of PERSONAL_SETTINGS_GROUP_ORDER) {
      expect(
        source.includes(`${group}: "${PERSONAL_SETTINGS_GROUP_LABELS[group]}"`),
        `分组标题与 Web 不一致：${group}`,
      ).toBe(true);
    }
    // Web 侧栏按 personal / preferences / access / data 顺序渲染
    expect([...PERSONAL_SETTINGS_GROUP_ORDER]).toEqual([
      'personal',
      'preferences',
      'access',
      'data',
    ]);
  });

  it('每个 Stack 路由落点都被 V1 能力清单放行', () => {
    const routes = personalSettingsRoutes();
    expect(routes.length).toBe(7); // 回收站是页内浮层，没有路由
    for (const route of routes) {
      expect(classifyV1Route(route), route).toBe('allowed');
    }
  });

  it('分组投影按 Web 顺序返回，隐藏项不产生空组', () => {
    const all = groupPersonalSettingsSections();
    expect(all.map((view) => view.group)).toEqual(['personal', 'preferences', 'access', 'data']);
    expect(all.flatMap((view) => view.sections.map((s) => s.id))).toEqual([
      'account-security',
      'my-agent',
      'chat-model',
      'appearance-layout',
      'my-permissions',
      'connections',
      'files-storage',
      'trash',
    ]);

    const trimmed = groupPersonalSettingsSections(['my-permissions', 'connections']);
    expect(trimmed.map((view) => view.group)).toEqual(['personal', 'preferences', 'data']);
  });
});
