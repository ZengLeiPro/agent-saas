import type { UserInfo } from '@agent/shared';
import type { V1BuildProfile } from './v1Capabilities';

interface UserDetailSelection {
  profile: V1BuildProfile;
  currentUserId?: string;
  requestedUserId?: string;
  selfProfile: UserInfo | null;
  users: readonly UserInfo[];
}

export function isMatchingSelfProfile(
  currentUserId: string | undefined,
  requestedUserId: string | undefined,
  selfProfile: UserInfo | null,
): selfProfile is UserInfo {
  return !!currentUserId
    && requestedUserId === currentUserId
    && selfProfile?.id === currentUserId;
}

/** Production V1 exposes account self-service only; cached admin lists are never a fallback. */
export function selectUserDetailProfile({
  profile,
  currentUserId,
  requestedUserId,
  selfProfile,
  users,
}: UserDetailSelection): UserInfo | null {
  const isSelf = !!currentUserId && requestedUserId === currentUserId;
  if (profile === 'production') {
    return isMatchingSelfProfile(currentUserId, requestedUserId, selfProfile) ? selfProfile : null;
  }
  return users.find((user) => user.id === requestedUserId) ?? (isSelf ? selfProfile : null);
}
