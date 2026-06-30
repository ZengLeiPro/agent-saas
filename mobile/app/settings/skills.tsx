import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, spacing, typography, radius } from '../../src/theme';
import { useSkills } from '../../src/hooks/useSkills';

export default function SkillsScreen() {
  const { username } = useLocalSearchParams<{ username?: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    poolSkills,
    customSkills,
    loading,
    saving,
    selections,
    dirty,
    toggleSkill,
    save,
  } = useSkills(username);

  const handleSave = async () => {
    try {
      await save();
      Alert.alert('已保存', 'Skill 配置已更新，新会话生效');
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : '未知错误');
    }
  };

  const title = username ? `${username} 的 Skills` : 'Skills';

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
    rowLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
    rowIcon: { width: 28, alignItems: 'center' },
    rowText: { flex: 1 },
    rowName: { ...typography.body, color: colors.foreground, fontWeight: '500' },
    rowDesc: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
    badge: {
      backgroundColor: colors.secondary, borderRadius: radius.sm,
      paddingHorizontal: spacing.sm, paddingVertical: 2, marginLeft: spacing.sm,
    },
    badgeText: { ...typography.caption, color: colors.mutedForeground, fontSize: 10 },
    saveBtn: {
      backgroundColor: dirty ? colors.primary : colors.muted,
      borderRadius: radius.lg, paddingVertical: 14, alignItems: 'center',
      flexDirection: 'row', justifyContent: 'center', gap: spacing.sm,
    },
    saveBtnText: {
      ...typography.body,
      color: dirty ? colors.primaryForeground : colors.mutedForeground,
      fontWeight: '600',
    },
    emptyText: {
      ...typography.body, color: colors.mutedForeground,
      textAlign: 'center', paddingVertical: spacing.xl,
    },
  }), [colors, insets.top, insets.bottom, dirty]);

  return (
    <>
      <Stack.Screen options={{ title }} />
      <View style={styles.container}>
        {loading ? (
          <View style={styles.loadingCenter}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            {poolSkills.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>系统 Skills</Text>
                <View style={styles.card}>
                  {poolSkills.map((skill, idx) => (
                    <View
                      key={skill.id}
                      style={[styles.row, idx < poolSkills.length - 1 && styles.rowBorder]}
                    >
                      <View style={styles.rowLeft}>
                        <View style={styles.rowIcon}>
                          <Ionicons name="extension-puzzle-outline" size={18} color={colors.primary} />
                        </View>
                        <View style={styles.rowText}>
                          <Text style={styles.rowName}>{skill.name}</Text>
                          {skill.description ? (
                            <Text style={styles.rowDesc} numberOfLines={2}>{skill.description}</Text>
                          ) : null}
                        </View>
                      </View>
                      <Switch
                        value={selections.has(skill.id)}
                        onValueChange={() => toggleSkill(skill.id)}
                        trackColor={{ false: colors.muted, true: colors.success }}
                        thumbColor={colors.card}
                        ios_backgroundColor={colors.muted}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}

            {customSkills.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>自建 Skills</Text>
                <View style={styles.card}>
                  {customSkills.map((skill, idx) => (
                    <View
                      key={skill.id}
                      style={[styles.row, idx < customSkills.length - 1 && styles.rowBorder]}
                    >
                      <View style={styles.rowLeft}>
                        <View style={styles.rowIcon}>
                          <Ionicons name="hammer-outline" size={18} color={colors.primary} />
                        </View>
                        <View style={styles.rowText}>
                          <Text style={styles.rowName}>{skill.name}</Text>
                          {skill.description ? (
                            <Text style={styles.rowDesc} numberOfLines={2}>{skill.description}</Text>
                          ) : null}
                        </View>
                      </View>
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>自建</Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {poolSkills.length === 0 && customSkills.length === 0 && (
              <Text style={styles.emptyText}>暂无可用 Skill</Text>
            )}

            {(poolSkills.length > 0 || customSkills.length > 0) && (
              <View style={styles.section}>
                <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={handleSave}
                  disabled={saving || !dirty}
                  activeOpacity={0.7}
                >
                  {saving && <ActivityIndicator size="small" color={colors.primaryForeground} />}
                  <Text style={styles.saveBtnText}>保存</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </>
  );
}
