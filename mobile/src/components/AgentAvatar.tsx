import React from 'react';
import { View, Text } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { isEmojiAvatar, getAgentAvatarUrl } from '@agent/shared';
import { getServerUrl } from '../platform/mobileConfig';
import { useColors } from '../theme';

// ---------------------------------------------------------------------------
// Shared base
// ---------------------------------------------------------------------------

function AvatarShell({ uri, fallback, size }: { uri: string | null; fallback: React.ReactNode; size: number }) {
  const colors = useColors();

  if (!uri) {
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
      source={{ uri }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      cachePolicy="disk"
    />
  );
}

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
    return (
      <AvatarShell
        uri={null}
        fallback={<Text style={{ fontSize: size * 0.5 }}>{avatar || '🤖'}</Text>}
        size={size}
      />
    );
  }

  const url = getAgentAvatarUrl(username || '', avatar, getServerUrl(), version);
  return (
    <AvatarShell
      uri={url}
      fallback={<Text style={{ fontSize: size * 0.5 }}>🤖</Text>}
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
      fallback={<Ionicons name="person" size={size * 0.5} color={colors.mutedForeground} />}
      size={size}
    />
  );
}
