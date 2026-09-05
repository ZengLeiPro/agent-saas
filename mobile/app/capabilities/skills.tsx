/**
 * 能力中心 · 技能 —— 由 `app/settings/skills.tsx` 迁入（旧路由已删除并在 V1 清单记墓碑）。
 *
 * 信息结构对齐 Web `SkillSelector` embedded 模式：搜索 → 分组（系统 / 组织 / 自建）
 * → 每行「名称 + 描述 + 已启用开关」，自建技能额外提供编辑与删除。
 * 数据一律走 shared `skillsApi`（`useSkills` hook），不新增端点。
 *
 * 未开放个人通用 Agent 的租户不给成员自助开关，整页替换为 `ManagedCapabilityNotice`
 * （Web 同语义：企业专家的固有技能不受这里控制）。
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { deleteMySkill } from '@agent/shared';
import type { UserSkillInfo } from '@agent/shared';
import { CapabilityTabBar } from '../../src/components/capabilities/CapabilityTabBar';
import { ManagedCapabilityNotice } from '../../src/components/capabilities/ManagedCapabilityNotice';
import { Button, EmptyState, Input } from '../../src/components/ui';
import { EntityIcons } from '../../src/lib/icons';
import { useCapabilityContext } from '../../src/hooks/useCapabilityContext';
import { useSkills } from '../../src/hooks/useSkills';
import { radius, spacing, typography, useColors } from '../../src/theme';

function matches(skill: UserSkillInfo, query: string): boolean {
  if (!query) return true;
  const normalized = query.trim().toLocaleLowerCase();
  return [skill.name, skill.description, skill.id]
    .filter(Boolean)
    .some((value) => String(value).toLocaleLowerCase().includes(normalized));
}

export default function CapabilitySkillsScreen() {
  const colors = useColors();
  const { personalAgentEnabled } = useCapabilityContext();
  const {
    poolSkills,
    tenantSkills,
    customSkills,
    loading,
    saving,
    selections,
    dirty,
    toggleSkill,
    save,
    refresh,
  } = useSkills();
  const [query, setQuery] = useState('');
  const [workingId, setWorkingId] = useState<string | null>(null);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.background },
        content: { padding: spacing.lg, gap: spacing.lg },
        sectionTitle: { ...typography.caption, color: colors.mutedForeground },
        card: { backgroundColor: colors.card, borderRadius: radius.lg, overflow: 'hidden' },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
        },
        rowBorder: {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        rowText: { flex: 1 },
        name: { ...typography.bodySmall, color: colors.foreground, fontWeight: '500' },
        description: { ...typography.caption, color: colors.mutedForeground },
        center: { paddingVertical: spacing['4xl'], alignItems: 'center' },
      }),
    [colors],
  );

  const handleDelete = (skillId: string, name: string) => {
    Alert.alert('确认删除', `确定删除自建技能“${name}”吗？此操作不可撤销。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          setWorkingId(skillId);
          try {
            await deleteMySkill(skillId);
            await refresh();
          } catch (err) {
            Alert.alert('删除失败', err instanceof Error ? err.message : '未知错误');
          } finally {
            setWorkingId(null);
          }
        },
      },
    ]);
  };

  const groups: Array<{ title: string; skills: UserSkillInfo[]; deletable: boolean }> = [
    {
      title: '系统技能',
      skills: poolSkills.filter((skill) => matches(skill, query)),
      deletable: false,
    },
    {
      title: '组织技能',
      skills: tenantSkills.filter((skill) => matches(skill, query)),
      deletable: false,
    },
    {
      title: '自建技能',
      skills: customSkills.filter((skill) => matches(skill, query)),
      deletable: true,
    },
  ];
  const total = groups.reduce((sum, group) => sum + group.skills.length, 0);

  if (!personalAgentEnabled) {
    return (
      <View style={styles.root}>
        <CapabilityTabBar active="skills" personalAgentEnabled={personalAgentEnabled} />
        <ManagedCapabilityNotice kind="技能" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CapabilityTabBar active="skills" personalAgentEnabled={personalAgentEnabled} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.description}>
          选择通用 Agent 在新会话中可以使用的技能。企业专家的固有技能不受这里控制。
        </Text>
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="搜索技能名称或说明"
          testID="capability-skill-search"
        />

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : total === 0 ? (
          <EmptyState icon={EntityIcons.skill} title="没有匹配的技能" />
        ) : (
          groups.map((group) =>
            group.skills.length === 0 ? null : (
              <View key={group.title} style={{ gap: spacing.sm }}>
                <Text style={styles.sectionTitle}>{group.title}</Text>
                <View style={styles.card}>
                  {group.skills.map((skill, index) => (
                    <View
                      key={skill.id}
                      style={[styles.row, index < group.skills.length - 1 && styles.rowBorder]}
                    >
                      <View style={styles.rowText}>
                        <Text style={styles.name}>{skill.name || skill.id}</Text>
                        {skill.description ? (
                          <Text style={styles.description} numberOfLines={2}>
                            {skill.description}
                          </Text>
                        ) : null}
                      </View>
                      {group.deletable ? (
                        <Button
                          label="删除"
                          variant="link"
                          size="sm"
                          disabled={workingId === skill.id}
                          onPress={() => handleDelete(skill.id, skill.name || skill.id)}
                        />
                      ) : null}
                      <Switch
                        value={selections.has(skill.id)}
                        onValueChange={() => toggleSkill(skill.id)}
                        disabled={saving}
                        trackColor={{ false: colors.muted, true: colors.success }}
                        thumbColor={colors.card}
                        ios_backgroundColor={colors.muted}
                      />
                    </View>
                  ))}
                </View>
              </View>
            ),
          )
        )}

        {total > 0 ? (
          <Button
            label="保存"
            fullWidth
            loading={saving}
            disabled={!dirty}
            onPress={async () => {
              try {
                await save();
                Alert.alert('已保存', '技能配置已更新，新会话生效');
              } catch (err) {
                Alert.alert('保存失败', err instanceof Error ? err.message : '未知错误');
              }
            }}
            testID="capability-skill-save"
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
