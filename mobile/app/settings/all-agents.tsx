import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Image,
  Modal,
  Dimensions,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, spacing, typography, radius } from '../../src/theme';
import { AgentAvatar } from '../../src/components/AgentAvatar';
import { fetchAllAgentProfiles, isEmojiAvatar, getAgentAvatarUrl, reportActivity } from '@agent/shared';
import { getServerUrl } from '../../src/platform/mobileConfig';
import type { AgentProfile } from '@agent/shared';

export default function AllAgentsScreen() {
  useEffect(() => { reportActivity('agent_profile_viewed', { detail: '所有 Agent' }); }, []);
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewProfile, setPreviewProfile] = useState<AgentProfile | null>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const data = await fetchAllAgentProfiles({ scope: 'currentTenant' });
      setProfiles(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scrollContent: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg + insets.bottom,
    },
    section: { marginBottom: spacing.xl },
    sectionTitle: {
      ...typography.caption,
      color: colors.mutedForeground,
      textTransform: 'uppercase',
      marginBottom: spacing.sm,
      marginLeft: spacing.xs,
    },
    card: { backgroundColor: colors.card, borderRadius: radius.lg, overflow: 'hidden' },
    profileRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.md,
      paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    },
    profileRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    profileInfo: { flex: 1, minWidth: 0 },
    profileNameRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
    profileName: { ...typography.body, color: colors.foreground, fontWeight: '500', flexShrink: 0 },
    profileOwner: { ...typography.caption, color: colors.mutedForeground, flexShrink: 1 },
    profileSignature: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
    loadingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
    emptyText: { ...typography.caption, color: colors.mutedForeground },
    modalOverlay: { flex: 1, backgroundColor: colors.overlayHeavy, justifyContent: 'center' as const, alignItems: 'center' as const },
    modalClose: { position: 'absolute' as const, top: insets.top + 12, right: 16, zIndex: 10, padding: 8 },
    modalImage: { width: Dimensions.get('window').width - 40, height: Dimensions.get('window').width - 40, borderRadius: 12 },
  }), [colors, insets.top, insets.bottom]);

  const renderItem = (p: AgentProfile, index: number) => {
    const avatarEl = !isEmojiAvatar(p.avatar) ? (
      <TouchableOpacity onPress={() => setPreviewProfile(p)} activeOpacity={0.8}>
        <AgentAvatar avatar={p.avatar} username={p.username} size={40} version={p.avatarVersion} />
      </TouchableOpacity>
    ) : (
      <AgentAvatar avatar={p.avatar} username={p.username} size={40} version={p.avatarVersion} />
    );

    const info = (
      <View style={styles.profileInfo}>
        <View style={styles.profileNameRow}>
          <Text style={styles.profileName} numberOfLines={1}>{p.name}</Text>
          <Text style={styles.profileOwner} numberOfLines={1}>{p.realName || p.username} 的 Agent</Text>
        </View>
        {p.signature ? (
          <Text style={styles.profileSignature} numberOfLines={1}>{p.signature}</Text>
        ) : null}
      </View>
    );

    return (
      <View
        key={p.username}
        style={[styles.profileRow, index < profiles.length - 1 && styles.profileRowBorder]}
      >
        {avatarEl}
        {info}
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: '所有 Agent' }} />
      <View style={styles.container}>
        {loading ? (
          <View style={styles.loadingCenter}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>所有 Agent</Text>
              <View style={styles.card}>
                {profiles.map(renderItem)}
                {profiles.length === 0 && (
                  <View style={styles.profileRow}>
                    <Text style={styles.emptyText}>暂无用户</Text>
                  </View>
                )}
              </View>
            </View>
          </ScrollView>
        )}
      </View>
      <Modal visible={!!previewProfile} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setPreviewProfile(null)}>
          <TouchableOpacity style={styles.modalClose} onPress={() => setPreviewProfile(null)} activeOpacity={0.7}>
            <Ionicons name="close" size={28} color={colors.onOverlay} />
          </TouchableOpacity>
          {previewProfile && !isEmojiAvatar(previewProfile.avatar) && (
            <Image
              source={{ uri: getAgentAvatarUrl(previewProfile.username, previewProfile.avatar, getServerUrl(), previewProfile.avatarVersion)! }}
              style={styles.modalImage}
              resizeMode="contain"
            />
          )}
        </Pressable>
      </Modal>
    </>
  );
}
