import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { RefreshCw } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, spacing, typography, radius } from '../../src/theme';
import { useAdminPoolSkills, useAdminCustomSkills } from '../../src/hooks/useAdminSkills';
import { useAuth } from '../../src/contexts/AuthContext';

export default function SkillsAdminScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  // Admin guard
  useEffect(() => {
    if (user && user.role !== 'admin') router.replace('/(tabs)/settings');
  }, [user, router]);
  if (!user || user.role !== 'admin') return null;
  const pool = useAdminPoolSkills();
  const custom = useAdminCustomSkills();

  const loading = pool.loading || custom.loading;
  const usernames = Object.keys(custom.users).sort();
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([pool.refresh(), custom.refresh()]);
    setRefreshing(false);
  }, [pool.refresh, custom.refresh]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await custom.sync();
      await Promise.all([pool.refresh(), custom.refresh()]);
      Alert.alert('成功', '已强制同步所有用户');
    } catch {
      Alert.alert('操作失败', '同步失败');
    } finally {
      setSyncing(false);
    }
  }, [custom.sync, pool.refresh, custom.refresh]);

  const handleToggleVisibility = async (id: string, value: boolean) => {
    try {
      await pool.toggleVisibility(id, value);
    } catch {
      Alert.alert('操作失败', '更新可见性失败');
    }
  };

  const handlePromote = (skillId: string, skillName: string, sourceUser: string) => {
    Alert.alert('提升到系统', `确定将“${skillName}”提升到系统技能池？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '确定', onPress: async () => {
          try {
            await custom.promote(skillId, sourceUser);
            pool.refresh();
            Alert.alert('成功', '技能已提升到系统池');
          } catch {
            Alert.alert('操作失败', '提升失败');
          }
        },
      },
    ]);
  };

  const handleDelete = (username: string, skillId: string, skillName: string) => {
    Alert.alert('删除技能', `确定删除用户 ${username} 的“${skillName}”？此操作不可恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: async () => {
          try {
            await custom.remove(username, skillId);
            Alert.alert('成功', '技能已删除');
          } catch {
            Alert.alert('操作失败', '删除失败');
          }
        },
      },
    ]);
  };

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scrollContent: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg + insets.bottom,
    },
    loadingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
    section: { marginBottom: spacing.xl },
    sectionTitle: {
      ...typography.caption, color: colors.mutedForeground,
      textTransform: 'uppercase', marginBottom: spacing.sm, marginLeft: spacing.xs,
    },
    card: { backgroundColor: colors.card, borderRadius: radius.lg, overflow: 'hidden' },
    row: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    },
    rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    rowLeft: { flex: 1 },
    rowName: { ...typography.body, color: colors.foreground, fontWeight: '500' },
    rowDesc: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
    userHeader: {
      ...typography.bodySmall, color: colors.mutedForeground, fontWeight: '600',
      paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs,
    },
    customRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    },
    actionBtns: { flexDirection: 'row', gap: spacing.sm, marginLeft: spacing.sm },
    actionBtn: {
      paddingHorizontal: spacing.sm, paddingVertical: spacing.xs,
      borderRadius: radius.sm, backgroundColor: colors.secondary,
    },
    actionBtnDestructive: {
      backgroundColor: colors.errorBg,
    },
    actionBtnText: { ...typography.caption, color: colors.primary, fontWeight: '500' },
    actionBtnTextDestructive: { ...typography.caption, color: colors.destructive, fontWeight: '500' },
    syncBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
      borderRadius: radius.sm, backgroundColor: colors.secondary,
    },
    syncBtnText: { ...typography.caption, color: colors.primary, fontWeight: '500' },
    emptyText: {
      ...typography.body, color: colors.mutedForeground,
      textAlign: 'center', paddingVertical: spacing.xl,
    },
  }), [colors, insets.top, insets.bottom]);

  return (
    <>
      <Stack.Screen options={{ title: '技能管理' }} />
      <View style={styles.container}>
        {loading ? (
          <View style={styles.loadingCenter}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.mutedForeground} />}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: spacing.sm }}>
              <TouchableOpacity
                style={styles.syncBtn}
                onPress={handleSync}
                disabled={syncing}
                activeOpacity={0.7}
              >
                {syncing ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <RefreshCw size={14} color={colors.primary} strokeWidth={2} />
                )}
                <Text style={styles.syncBtnText}>强制同步</Text>
              </TouchableOpacity>
            </View>

            {pool.skills.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>系统技能</Text>
                <View style={styles.card}>
                  {pool.skills.map((skill, idx) => (
                    <View
                      key={skill.id}
                      style={[styles.row, idx < pool.skills.length - 1 && styles.rowBorder]}
                    >
                      <View style={styles.rowLeft}>
                        <Text style={styles.rowName}>{skill.name}</Text>
                        {skill.description ? (
                          <Text style={styles.rowDesc} numberOfLines={2}>{skill.description}</Text>
                        ) : null}
                      </View>
                      <Switch
                        value={skill.visible}
                        onValueChange={(val) => handleToggleVisibility(skill.id, val)}
                        trackColor={{ false: colors.muted, true: colors.success }}
                        thumbColor={colors.card}
                        ios_backgroundColor={colors.muted}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}

            {usernames.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>用户自建技能</Text>
                <View style={styles.card}>
                  {usernames.map((user, uIdx) => {
                    const skills = custom.users[user];
                    if (!skills || skills.length === 0) return null;
                    return (
                      <React.Fragment key={user}>
                        <Text style={[styles.userHeader, uIdx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
                          {user}
                        </Text>
                        {skills.map((skill, sIdx) => (
                          <View
                            key={skill.id}
                            style={[
                              styles.customRow,
                              (sIdx < skills.length - 1 || uIdx < usernames.length - 1) && styles.rowBorder,
                            ]}
                          >
                            <View style={styles.rowLeft}>
                              <Text style={styles.rowName}>{skill.name}</Text>
                              {skill.description ? (
                                <Text style={styles.rowDesc} numberOfLines={2}>{skill.description}</Text>
                              ) : null}
                            </View>
                            <View style={styles.actionBtns}>
                              <TouchableOpacity
                                style={styles.actionBtn}
                                onPress={() => handlePromote(skill.id, skill.name, user)}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.actionBtnText}>提升</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.actionBtn, styles.actionBtnDestructive]}
                                onPress={() => handleDelete(user, skill.id, skill.name)}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.actionBtnTextDestructive}>删除</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </View>
              </View>
            )}

            {pool.skills.length === 0 && usernames.length === 0 && (
              <Text style={styles.emptyText}>暂无技能</Text>
            )}
          </ScrollView>
        )}
      </View>
    </>
  );
}
