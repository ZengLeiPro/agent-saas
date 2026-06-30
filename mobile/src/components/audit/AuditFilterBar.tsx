import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useColors, spacing, typography, radius } from '../../theme';

const CATEGORIES = [
  { value: '', label: '全部' },
  { value: 'login', label: '登录' },
  { value: 'activity', label: '活动' },
  { value: 'session', label: '会话' },
  { value: 'group', label: '分组' },
  { value: 'cron', label: '任务' },
  { value: 'user', label: '用户' },
  { value: 'file', label: '文件' },
  { value: 'agent', label: 'Agent' },
];

const CHANNELS = [
  { value: '', label: '全部渠道' },
  { value: 'web', label: '网页端' },
  { value: 'mobile', label: '移动端' },
  { value: 'dingtalk', label: '钉钉' },
];

interface User {
  id: string;
  username: string;
  realName?: string;
}

interface AuditFilterBarProps {
  category: string;
  onCategoryChange: (value: string) => void;
  channel: string;
  onChannelChange: (value: string) => void;
  selectedUsernames: string[];
  onUsernamesChange: (value: string[]) => void;
  users: User[];
  showUserFilter: boolean;
}

export function AuditFilterBar({
  category,
  onCategoryChange,
  channel,
  onChannelChange,
  selectedUsernames,
  onUsernamesChange,
  users,
  showUserFilter,
}: AuditFilterBarProps) {
  const colors = useColors();

  const styles = useMemo(() => StyleSheet.create({
    container: { gap: spacing.xs, paddingBottom: spacing.sm },
    pillBar: { flexDirection: 'row', paddingHorizontal: spacing.md, gap: spacing.xs },
    pill: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.md,
      backgroundColor: colors.secondary,
    },
    pillActive: { backgroundColor: colors.primary },
    pillText: { ...typography.caption, color: colors.foreground, fontWeight: '500' },
    pillTextActive: { color: colors.primaryForeground },
  }), [colors]);

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillBar}>
        {CATEGORIES.map((c) => (
          <TouchableOpacity
            key={c.value || '_all_'}
            style={[styles.pill, category === c.value && styles.pillActive]}
            onPress={() => onCategoryChange(c.value)}
          >
            <Text style={[styles.pillText, category === c.value && styles.pillTextActive]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillBar}>
        {CHANNELS.map((c) => (
          <TouchableOpacity
            key={c.value || '_all_'}
            style={[styles.pill, channel === c.value && styles.pillActive]}
            onPress={() => onChannelChange(c.value)}
          >
            <Text style={[styles.pillText, channel === c.value && styles.pillTextActive]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
        {showUserFilter && (
          <>
            <View style={{ width: 1, backgroundColor: colors.border, marginHorizontal: spacing.xs }} />
            <TouchableOpacity
              style={[styles.pill, selectedUsernames.length === 0 && styles.pillActive]}
              onPress={() => onUsernamesChange([])}
            >
              <Text style={[styles.pillText, selectedUsernames.length === 0 && styles.pillTextActive]}>全部用户</Text>
            </TouchableOpacity>
            {users.map((u) => {
              const isSelected = selectedUsernames.includes(u.username);
              return (
                <TouchableOpacity
                  key={u.id}
                  style={[styles.pill, isSelected && styles.pillActive]}
                  onPress={() => onUsernamesChange(
                    isSelected
                      ? selectedUsernames.filter(n => n !== u.username)
                      : [...selectedUsernames, u.username]
                  )}
                >
                  <Text style={[styles.pillText, isSelected && styles.pillTextActive]}>
                    {u.realName || u.username}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}
