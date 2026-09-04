import {
  MembershipInvariantError,
  type MembershipIdentityPatch,
  type TenantMembership,
} from '../data/memberships/index.js';
import type { MembershipAllowedAction, MembershipMutation } from './governanceAccessValidation.js';

export function authorizePlatformMembershipMutation(
  actorTenantId: string,
  tenantId: string,
  current: TenantMembership,
  mutation: MembershipMutation,
  explicitTenantScope: boolean,
): MembershipIdentityPatch['authorization'] {
  const persona = mutation.persona ?? current.persona;
  const isOwner = mutation.isOwner ?? current.isOwner;
  const status = mutation.status ?? current.status;
  const recoveryOnly =
    persona === 'org_admin' &&
    isOwner &&
    status === 'active' &&
    mutation.persona !== 'member' &&
    mutation.isOwner !== false &&
    mutation.status !== 'disabled';
  if (!explicitTenantScope || tenantId === actorTenantId || !mutation.reason?.trim()) {
    throw new MembershipInvariantError('PLATFORM_RECOVERY_SCOPE_REQUIRED');
  }
  return {
    kind: recoveryOnly ? 'platform_recovery' : 'platform_manage',
    actorTenantId,
    reason: mutation.reason,
  };
}

export function platformMembershipActions(
  actorTenantId: string,
  tenantId: string,
  target: TenantMembership,
): MembershipAllowedAction[] {
  if (tenantId === actorTenantId) return [];
  const identityAction =
    target.persona === 'member'
      ? {
          id: 'promote_admin' as const,
          label: '设为组织管理员',
          change: { persona: 'org_admin' as const },
          requiresReason: true,
        }
      : {
          id: 'demote_member' as const,
          label: '降为成员',
          change: { persona: 'member' as const, isOwner: false },
          requiresReason: true,
        };
  const ownerAction = target.isOwner
    ? {
        id: 'revoke_owner' as const,
        label: '撤销 Owner',
        change: { isOwner: false },
        requiresReason: true,
      }
    : {
        id: 'recover_owner' as const,
        label: '恢复为 Owner',
        change: { persona: 'org_admin' as const, isOwner: true, status: 'active' as const },
        requiresReason: true,
      };
  return [
    ownerAction,
    identityAction,
    target.status === 'active'
      ? { id: 'disable', label: '停用账号', change: { status: 'disabled' }, requiresReason: true }
      : { id: 'restore', label: '恢复账号', change: { status: 'active' }, requiresReason: true },
  ];
}
