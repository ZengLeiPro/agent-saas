/**
 * 企业专家会话空态 —— 对齐 Web `web/src/components/experts/ExpertWelcome.tsx`。
 *
 * 取专家 `starterPrompts` 的前 3 条渲染成「常用起手任务」，点一条把原文
 * 预填进输入框（不自动发送）；专家没有配置起手任务时回落到 Web 同一句兜底。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MessageSquareText } from 'lucide-react-native';
import type { OrgAgentSummary } from '@agent/shared';
import { SuggestionCard } from './SuggestionCard';
import { useColors, spacing, typography } from '../../theme';

/** 与 Web 一致：最多展示 3 条起手任务 */
const MAX_STARTER_PROMPTS = 3;
/** 专家未配置起手任务时的兜底文案，与 Web 同一句 */
const FALLBACK_PROMPT = '你能帮我做什么？';

export interface ExpertWelcomeProps {
  expert: OrgAgentSummary;
  onPrefill: (prompt: string) => void;
}

export function ExpertWelcome({ expert, onPrefill }: ExpertWelcomeProps) {
  const colors = useColors();

  const prompts = useMemo(
    () =>
      (expert.starterPrompts.length > 0 ? expert.starterPrompts : [FALLBACK_PROMPT]).slice(
        0,
        MAX_STARTER_PROMPTS,
      ),
    [expert.starterPrompts],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { paddingHorizontal: spacing.md, paddingTop: spacing.lg, gap: spacing.sm },
        heading: {
          ...typography.meta,
          color: colors.mutedForeground,
          fontWeight: '500',
          marginBottom: spacing.xs,
        },
      }),
    [colors],
  );

  return (
    <View style={styles.wrap} testID="expert-welcome">
      <Text style={styles.heading}>常用起手任务</Text>
      {prompts.map((prompt, index) => (
        <SuggestionCard
          key={`${index}:${prompt}`}
          testID={`expert-starter-${index}`}
          title={prompt}
          action="直接试"
          tone="success"
          icon={MessageSquareText}
          onPress={() => onPrefill(prompt)}
        />
      ))}
    </View>
  );
}
