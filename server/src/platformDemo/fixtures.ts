import type { PlatformDemoAnalyticsFixture, PlatformDemoConfigFixture } from './types.js';

/** Sample analytics only — never backed by production stores. */
export function platformDemoAnalyticsFixture(): PlatformDemoAnalyticsFixture {
  const series = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 8, 9 + index));
    return {
      date: day.toISOString().slice(0, 10),
      requests: 1200 + index * 85,
      tokens: 4_500_000 + index * 120_000,
      activeUsers: 48 + index * 3,
    };
  });
  return {
    series,
    totals: {
      organizations: 12,
      users: 186,
      runs24h: 940,
      errorRate: 0.012,
    },
  };
}

/** Sample config shapes matching real platform admin forms (no secrets). */
export function platformDemoConfigFixtures(): PlatformDemoConfigFixture[] {
  return [
    {
      sectionId: 'models',
      label: '模型',
      shape: {
        defaultModel: 'demo-model/general',
        allowedModels: ['demo-model/general', 'demo-model/coding'],
        allowUserModelSwitch: true,
        showGroupNames: true,
      },
    },
    {
      sectionId: 'tool-controls',
      label: '工具开关',
      shape: {
        filesEnabled: true,
        cronEnabled: true,
        mcpEnabled: true,
        imageGenEnabled: false,
      },
    },
    {
      sectionId: 'billing',
      label: '计费',
      shape: {
        plan: 'demo-growth',
        monthlyCredits: 100_000,
        overagePolicy: 'soft_cap',
      },
    },
    {
      sectionId: 'system',
      label: '系统配置',
      shape: {
        supportEmail: 'demo-support@example.com',
        maintenanceWindow: '周日 02:00-04:00 +08',
        featureFlags: { platformDemoMode: true },
      },
    },
  ];
}

export function platformDemoConfigFixture(sectionId: string): PlatformDemoConfigFixture | undefined {
  return platformDemoConfigFixtures().find((item) => item.sectionId === sectionId);
}
