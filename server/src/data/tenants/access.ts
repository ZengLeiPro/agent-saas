import type { AgentRunDispatch } from '../../agent/types.js';
import type { ChannelContext, InboundMessage, OutboundEvent } from '../../types/index.js';
import type { TenantStore } from './store.js';

export const TENANT_DISABLED_CODE = 'TENANT_DISABLED';
export const TENANT_NOT_FOUND_CODE = 'TENANT_NOT_FOUND';
export const TENANT_DISABLED_MESSAGE = '组织已被禁用';
export const TENANT_NOT_FOUND_MESSAGE = '组织不存在或已不可用';

export type TenantAccessResult =
  | { ok: true }
  | { ok: false; code: typeof TENANT_DISABLED_CODE | typeof TENANT_NOT_FOUND_CODE; message: string };

export function checkTenantAccess(
  tenantStore: TenantStore | undefined,
  tenantId: string | undefined,
): TenantAccessResult {
  if (!tenantStore || !tenantId) return { ok: true };
  const tenant = tenantStore.findById(tenantId);
  if (!tenant) return { ok: false, code: TENANT_NOT_FOUND_CODE, message: TENANT_NOT_FOUND_MESSAGE };
  if (tenant.disabled) return { ok: false, code: TENANT_DISABLED_CODE, message: TENANT_DISABLED_MESSAGE };
  return { ok: true };
}

export function isTenantDisabled(
  tenantStore: TenantStore | undefined,
  tenantId: string | undefined,
): boolean {
  const access = checkTenantAccess(tenantStore, tenantId);
  return !access.ok && access.code === TENANT_DISABLED_CODE;
}

export function tenantAccessErrorMessage(
  tenantStore: TenantStore | undefined,
  tenantId: string | undefined,
): string | null {
  const access = checkTenantAccess(tenantStore, tenantId);
  return access.ok ? null : access.message;
}

export function resolveTenantIdFromContext(context: ChannelContext): string | undefined {
  return context.sessionOwner?.tenantId ?? context.user?.tenantId;
}

export function wrapDispatchWithTenantAccess(
  dispatch: AgentRunDispatch,
  tenantStore: TenantStore | undefined,
): AgentRunDispatch {
  return async function* tenantAccessWrappedDispatch(
    message: InboundMessage,
    context: ChannelContext,
    options,
    hooks,
  ): AsyncGenerator<OutboundEvent> {
    const error = tenantAccessErrorMessage(tenantStore, resolveTenantIdFromContext(context));
    if (error) {
      yield { type: 'error', error };
      return;
    }
    yield* dispatch(message, context, options, hooks);
  };
}
