import type { Express } from 'express';

import { requireAdmin } from '../auth/middleware.js';
import { createAgentDwsAccountsRouter } from '../routes/agentDwsAccounts.js';
import type { AppRuntime } from './runtimeContracts.js';

export function registerAgentDwsRoutes(app: Express, runtime: AppRuntime): void {
  app.use('/api/agent-dws-accounts', requireAdmin);
  app.use(
    '/api',
    createAgentDwsAccountsRouter({
      accountStore: runtime.agentDwsAccountStore,
      messageStore: runtime.agentDwsMessageStore,
      orgGroupAgentStore: runtime.orgGroupAgentStore,
      approvalService: runtime.orgAgentApprovalService,
      orgAgentStore: runtime.orgAgentStore,
      assignmentStore: runtime.assignmentStore,
      contextStore: runtime.contextStore,
      backgroundTasks: runtime.backgroundTasks,
      isOrgAgentRuntimeV2Ready: runtime.isOrgAgentRuntimeV2Ready,
      authFlowService: runtime.agentDwsAuthFlowService,
      eventGateway: runtime.dwsPersonalEventGateway,
      auditStore: runtime.governanceAuditStore,
      onContextPolicyUpdated: runtime.agentDwsContextPolicyUpdated,
      onGroupBindingUpdated: runtime.agentDwsGroupBindingUpdated,
      onEnabledChanged: runtime.agentDwsEnabledChanged,
    }),
  );
}
