import type { UserInfo } from '@agent/shared';
import type { V1BuildProfile } from './v1Capabilities';

interface UserDetailSelection {
  profile: V1BuildProfile;
  currentUserId?: string;
  requestedUserId?: string;
  selfProfile: UserInfo | null;
  users: readonly UserInfo[];
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
  if (profile === 'production') return isSelf ? selfProfile : null;
  return users.find((user) => user.id === requestedUserId) ?? (isSelf ? selfProfile : null);
}
