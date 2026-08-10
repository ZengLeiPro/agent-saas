export const ALLOWED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function buildAvatarUrl(
  userId: string,
  avatar?: string,
  avatarVersion?: number,
): string | undefined {
  if (!avatar) return undefined;
  const base = `/api/auth/avatar/${userId}`;
  return avatarVersion ? `${base}?v=${avatarVersion}` : base;
}
