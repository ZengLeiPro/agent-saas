import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SquarePen, Play, Pause } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCronJobs, useRunHistory } from '../../src/hooks/useCronJobs';
import { RunHistory } from '../../src/components/cron/RunHistory';
import { useColors, spacing, typography, radius, type ThemeColors } from '../../src/theme';
import { glassFree } from '../../src/lib/headerItems';

export default function JobDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const router = useRouter();
  const { jobs, runJob, toggleJob } = useCronJobs();
  const { entries, loading: historyLoading } = useRunHistory(jobId ?? null);

  const job = useMemo(() => jobs.find(j => j.id === jobId), [jobs, jobId]);

  const styles = useMemo(() => createStyles(colors), [colors]);

  if (!job) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: '任务详情' }} />
        <View style={styles.center}>
          <Text style={styles.emptyText}>任务未找到</Text>
        </View>
      </View>
    );
  }

  const handleRun = () => {
    Alert.alert('立即执行', `确定要立即执行"${job.name}"吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '执行', onPress: () => void runJob(job.id) },
    ]);
  };

  const scheduleText = (() => {
    const s = job.schedule;
    if (s.kind === 'every') {
      const totalSec = Math.round(s.everyMs / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const sec = totalSec % 60;
      const parts: string[] = [];
      if (h) parts.push(`${h}小时`);
      if (m) parts.push(`${m}分钟`);
      if (sec) parts.push(`${sec}秒`);
      return `每隔 ${parts.join(' ')}`;
    }
    if (s.kind === 'cron') return `Cron: ${s.expr}`;
    if (s.kind === 'at') return `定时: ${new Date(s.atMs).toLocaleString()}`;
    return '未知';
  })();

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: job.name,
          headerRight: () => (
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/cron-form', params: { jobId: job.id, jobJson: JSON.stringify(job) } })}
              activeOpacity={0.7}
            >
              <SquarePen size={22} color={colors.primary} strokeWidth={2} />
            </TouchableOpacity>
          ),
          unstable_headerRightItems: () => [glassFree(
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/cron-form', params: { jobId: job.id, jobJson: JSON.stringify(job) } })}
              activeOpacity={0.7}
            >
              <SquarePen size={22} color={colors.primary} strokeWidth={2} />
            </TouchableOpacity>
          )],
        }}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom }}>
        {/* Job Info */}
        <View style={styles.section}>
          <View style={styles.card}>
            <Row label="状态" value={job.enabled ? '已启用' : '已禁用'} styles={styles} />
            <Row label="调度" value={scheduleText} styles={styles} />
            {job.payload.kind === 'agentTurn' && (
              <>
                <Row label="提示词" value={job.payload.message} styles={styles} />
                {job.payload.model && <Row label="模型" value={job.payload.model} styles={styles} />}
              </>
            )}
            {job.state.nextRunAtMs && (
              <Row label="下次执行" value={new Date(job.state.nextRunAtMs).toLocaleString()} last styles={styles} />
            )}
          </View>
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionBtn} onPress={handleRun}>
            <Play size={16} color={colors.primaryForeground} strokeWidth={2} />
            <Text style={styles.actionText}>立即执行</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.actionSecondary]}
            onPress={() => void toggleJob(job)}
          >
            {job.enabled ? (
              <Pause size={16} color={colors.foreground} strokeWidth={2} />
            ) : (
              <Play size={16} color={colors.foreground} strokeWidth={2} />
            )}
            <Text style={[styles.actionText, styles.actionTextSecondary]}>
              {job.enabled ? '禁用' : '启用'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Run History */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>运行历史</Text>
          <RunHistory entries={entries} loading={historyLoading} />
        </View>
      </ScrollView>
    </View>
  );
}

function Row({ label, value, last, styles }: { label: string; value: string; last?: boolean; styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={3}>{value}</Text>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    emptyText: {
      ...typography.body,
      color: colors.mutedForeground,
    },
    section: {
      padding: spacing.md,
    },
    sectionTitle: {
      ...typography.caption,
      color: colors.mutedForeground,
      textTransform: 'uppercase',
      marginBottom: spacing.sm,
      marginLeft: spacing.xs,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    rowBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowLabel: {
      ...typography.body,
      color: colors.foreground,
      marginRight: spacing.md,
    },
    rowValue: {
      ...typography.body,
      color: colors.mutedForeground,
      flex: 1,
      textAlign: 'right',
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.md,
    },
    actionBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      backgroundColor: colors.primary,
      paddingVertical: 12,
      borderRadius: radius.lg,
    },
    actionSecondary: {
      backgroundColor: colors.secondary,
    },
    actionText: {
      ...typography.subtitle,
      color: colors.primaryForeground,
    },
    actionTextSecondary: {
      color: colors.foreground,
    },
  });
}
