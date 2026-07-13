import React from 'react';
import { View, Text } from 'react-native';
import { Image } from 'expo-image';
import { User } from 'lucide-react-native';
import { isEmojiAvatar, getAgentAvatarUrl } from '@agent/shared';
import { getServerUrl } from '../platform/mobileConfig';
import { useColors } from '../theme';

// ---------------------------------------------------------------------------
// Shared base
// ---------------------------------------------------------------------------

function AvatarShell({ uri, fallback, size }: { uri: string | number | null; fallback: React.ReactNode; size: number }) {
  const colors = useColors();

  if (uri == null) {
    return (
      <View style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: colors.muted,
        alignItems: 'center', justifyContent: 'center',
      }}>
        {fallback}
      </View>
    );
  }

  return (
    <Image
      source={typeof uri === 'number' ? uri : { uri }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      cachePolicy="disk"
    />
  );
}

/** 空值与旧的 "🤖" 哨兵值统一渲染品牌默认头像「开开」 */
const DEFAULT_AVATAR_SENTINEL = '🤖';
const DEFAULT_AVATAR_SOURCE = require('../../assets/kaikai-avatar.png');

// ---------------------------------------------------------------------------
// Agent Avatar
// ---------------------------------------------------------------------------

interface AgentAvatarProps {
  avatar?: string;
  username?: string;
  size?: number;
  version?: number;
}

export function AgentAvatar({ avatar, username, size = 40, version }: AgentAvatarProps) {
  const isEmoji = isEmojiAvatar(avatar);

  if (isEmoji) {
    const isDefault = !avatar || avatar === DEFAULT_AVATAR_SENTINEL;
    if (isDefault) {
      return <AvatarShell uri={DEFAULT_AVATAR_SOURCE} fallback={null} size={size} />;
    }
    return (
      <AvatarShell
        uri={null}
        fallback={<Text style={{ fontSize: size * 0.5 }}>{avatar}</Text>}
        size={size}
      />
    );
  }

  const url = getAgentAvatarUrl(username || '', avatar, getServerUrl(), version);
  return (
    <AvatarShell
      uri={url ?? DEFAULT_AVATAR_SOURCE}
      fallback={null}
      size={size}
    />
  );
}

// ---------------------------------------------------------------------------
// User Avatar
// ---------------------------------------------------------------------------

interface UserAvatarProps {
  userId?: string;
  avatar?: string;
  size?: number;
  version?: number;
}

export function UserAvatar({ userId, avatar, size = 40, version }: UserAvatarProps) {
  const colors = useColors();

  const url = (avatar && userId)
    ? `${getServerUrl()}/api/auth/avatar/${userId}${version ? `?v=${version}` : ''}`
    : null;

  return (
    <AvatarShell
      uri={url}
      fallback={<User size={size * 0.5} color={colors.mutedForeground} strokeWidth={2} />}
      size={size}
    />
  );
}
