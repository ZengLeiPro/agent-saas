/**
 * 公司级专职 Agent 路由注册（组织管理员配置、员工使用；2026-07 唯恩批次）。
 *
 * 原本内联在 `app/routes.ts`。该文件在大文件行数棘轮基线上（只许缩不许涨），
 * WP2a 需要在其中新增一行 `registerKyAppRoutes`，因此把这一段成组注册整体外提，
 * 行为逐字保持不变——依赖仍全部来自 `runtime`，只是换了个落脚点。
 */
import type { Express } from 'express';

import { createOrgAgentsRouter } from '../routes/orgAgents.js';
import type { AppRuntime } from './runtime.js';

export interface RegisterOrgAgentRoutesContext {
  orgAgentAvatarsDir: string;
  legacyWriteGate: Parameters<typeof createOrgAgentsRouter>[0]['legacyWriteGate'];
}

export function registerOrgAgentRoutes(
  app: Express,
  runtime: AppRuntime,
  context: RegisterOrgAgentRoutesContext,
): void {
  if (!runtime.orgAgentStore) return;
  app.use(
    '/api/org-agents',
    createOrgAgentsRouter({
      orgAgentStore: runtime.orgAgentStore,
      tenantStore: runtime.tenantStore!,
      orgAgentAvatarsDir: context.orgAgentAvatarsDir,
      getGuardrailModelConfigs: runtime.getGuardrailModelConfigs,
      billingService: runtime.billingService,
      legacyWriteGate: context.legacyWriteGate,
      onSkillAssignmentsChanged: runtime.skillConfigStore
        ? () => runtime.skillConfigStore!.touchConfigVersion()
        : undefined,
    }),
  );
}
