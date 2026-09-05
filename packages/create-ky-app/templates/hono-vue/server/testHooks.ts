/**
 * §3.8 `/ky/v1/test/*` 的钩子实现 —— **只在 `KY_ENV=test` 下注册**（SDK 保证）。
 *
 * 这是 `ky-app doctor` 与定制项目之间的约定，一致性测试全靠它驱动：
 * - `POST /ky/v1/test/provision`
 *     `{ users: [{ sub, roles?, isTenantAdmin?, displayName? }] }` 预置测试用户的业务角色
 *     `{ capabilityDelayMs: n }`                                   给能力 handler 加人为延迟
 * - `POST /ky/v1/test/break-glass`
 *     `{ action:'setup', sub, password }` → `{ codes: [8 个一次性恢复码] }`
 *     `{ action:'disable' }` / `{ action:'status' }`
 * - `POST /ky/v1/test/directory`
 *     `{ action:'sync' | 'state' | 'staleness' | 'ack' }`
 * - `POST /ky/v1/test/clock` 由 SDK 自带。
 */
import type { Pool } from 'pg';

import {
  KyAppError,
  type BreakGlass,
  type DirectoryClient,
  type DirectoryStore,
  type KyAppConfig,
} from '@kaiyan/ky-app-server';
import type { KyAppTestHooks } from '@kaiyan/ky-app-server/hono';

import { setUserRoles } from './services/users.service.js';
import { testState } from './state.js';

export interface TestHookDeps {
  pool: Pool;
  config: KyAppConfig;
  breakGlass: BreakGlass;
  directory: DirectoryClient;
  directoryStore: DirectoryStore;
}

interface ProvisionInput {
  users?: Array<{ sub?: unknown; roles?: unknown; isTenantAdmin?: unknown; displayName?: unknown }>;
  capabilityDelayMs?: unknown;
}

export function createTestHooks(deps: TestHookDeps): KyAppTestHooks {
  const key = (sub: string): { tenantId: string; installationId: string; sub: string } => ({
    tenantId: deps.config.tenantId,
    installationId: deps.config.installationId,
    sub,
  });

  return {
    async provision(raw: unknown): Promise<unknown> {
      const input = (raw ?? {}) as ProvisionInput;
      const provisioned: string[] = [];
      for (const user of input.users ?? []) {
        if (typeof user.sub !== 'string' || user.sub === '') {
          throw new KyAppError('invalid_input', { message: 'users[].sub 必填' });
        }
        const roles = Array.isArray(user.roles)
          ? user.roles.filter((role): role is string => typeof role === 'string')
          : [];
        await setUserRoles(deps.pool, key(user.sub), roles);
        if (user.isTenantAdmin === true) {
          // §3.4 双通道：目录侧也标一次组织管理员，SAT 的 `tadm` 仍然优先。
          await deps.directoryStore.setTenantAdmin(user.sub, true, Date.now());
        }
        provisioned.push(user.sub);
      }
      if (input.capabilityDelayMs !== undefined) {
        if (
          !Number.isSafeInteger(input.capabilityDelayMs) ||
          (input.capabilityDelayMs as number) < 0
        ) {
          throw new KyAppError('invalid_input', { message: 'capabilityDelayMs 必须是非负整数' });
        }
        testState.capabilityDelayMs = input.capabilityDelayMs as number;
      }
      return { provisioned, capabilityDelayMs: testState.capabilityDelayMs };
    },

    async breakGlass(raw: unknown): Promise<unknown> {
      const input = (raw ?? {}) as { action?: unknown; sub?: unknown; password?: unknown };
      switch (input.action) {
        case 'setup': {
          if (typeof input.sub !== 'string' || typeof input.password !== 'string') {
            throw new KyAppError('invalid_input', { message: 'setup 需要 sub 与 password' });
          }
          // 恢复因子只能在正常模式下设置：先确保兜底模式是关的。
          await deps.breakGlass.disable();
          return deps.breakGlass.setupRecoveryRecord({ sub: input.sub, password: input.password });
        }
        case 'disable':
          await deps.breakGlass.disable();
          return { active: false };
        case 'status':
          return {
            active: await deps.breakGlass.isActive(),
            session: await deps.breakGlass.session(),
          };
        default:
          throw new KyAppError('invalid_input', { message: 'action 只支持 setup|disable|status' });
      }
    },

    async directory(raw: unknown): Promise<unknown> {
      const input = (raw ?? {}) as { action?: unknown };
      switch (input.action) {
        case 'sync':
          return deps.directory.sync();
        case 'state': {
          const checkpoint = await deps.directoryStore.getCheckpoint();
          const users = await deps.directoryStore.listUsers();
          const groups = await deps.directoryStore.listGroups();
          return {
            checkpoint: checkpoint?.seq ?? null,
            users: users.map((user) => ({
              userId: user.userId,
              displayName: user.displayName,
              removed: user.removed,
              localStatus: user.localStatus,
              isTenantAdmin: user.isTenantAdmin,
            })),
            groups: groups.map((group) => ({ groupId: group.groupId })),
          };
        }
        case 'staleness':
          return deps.directory.staleness();
        case 'ack':
          await deps.directory.ackCredential();
          return { acked: true };
        default:
          throw new KyAppError('invalid_input', {
            message: 'action 只支持 sync|state|staleness|ack',
          });
      }
    },
  };
}
