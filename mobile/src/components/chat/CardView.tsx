import type { CardActionViewModel, CardViewModel } from '@agent/shared';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, useChatTypography, useColors } from '../../theme';

export interface CardViewProps {
  model: CardViewModel;
  onAction?: (action: CardActionViewModel) => void;
  onOptionChange?: (questionId: string, optionId: string) => void;
}

/** Thin React Native renderer; Shared owns labels, statuses, action selectors, and a11y semantics. */
export function CardView({ model, onAction, onOptionChange }: CardViewProps) {
  const colors = useColors();
  const typo = useChatTypography();
  const [expanded, setExpanded] = useState(model.accessibility.expanded);
  const expandAction = model.actions.find((action) => action.kind === 'expand');
  const actionLockRef = useRef<string | null>(null);
  const [lockedActionId, setLockedActionId] = useState<string | null>(null);
  useEffect(() => {
    if (model.status === 'failed' || model.status === 'rejected' || model.status === 'expired' || model.status === 'resolved') {
      actionLockRef.current = null;
      setLockedActionId(null);
    }
  }, [model.status]);
  const invokeAction = (action: CardActionViewModel) => {
    if (action.disabled || actionLockRef.current) return;
    actionLockRef.current = action.id;
    setLockedActionId(action.id);
    onAction?.(action);
  };
  const styles = StyleSheet.create({
    root: { borderColor: colors.border, backgroundColor: colors.card, borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm },
    heading: { ...typo.body, color: colors.foreground, fontWeight: '600' },
    muted: { ...typo.caption, color: colors.mutedForeground },
    detail: { ...typo.caption, color: colors.foreground, backgroundColor: colors.muted, padding: spacing.sm, borderRadius: radius.md },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    action: { borderColor: colors.border, backgroundColor: colors.background, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    actionDisabled: { opacity: 0.5 },
    actionText: { ...typo.caption, color: colors.foreground },
    failure: { ...typo.caption, color: colors.destructive },
  });

  return (
    <View
      style={styles.root}
      accessibilityRole="summary"
      accessibilityLabel={model.accessibility.heading}
      accessibilityState={{ busy: model.accessibility.busy, disabled: model.accessibility.disabled, expanded }}
      testID={model.id}
    >
      <Text style={styles.heading} accessibilityRole="header">{model.title}</Text>
      {model.subtitle ? <Text style={styles.muted}>{model.subtitle}</Text> : null}
      {model.inputSummary ? <Text style={styles.muted}>{model.inputSummary}</Text> : null}
      {model.outputSummary ? <Text style={styles.muted}>{model.outputSummary}</Text> : null}
      {expandAction ? (
        <Pressable
          style={[styles.action, expandAction.disabled && styles.actionDisabled]}
          accessibilityRole="button"
          accessibilityLabel={expandAction.label}
          accessibilityState={{ expanded, disabled: expandAction.disabled, busy: expandAction.busy }}
          disabled={expandAction.disabled}
          onPress={() => { setExpanded((value) => !value); onAction?.(expandAction); }}
        >
          <Text style={styles.actionText}>{expanded ? '收起' : '展开'}</Text>
        </Pressable>
      ) : null}
      {expanded && model.detail ? <Text selectable style={styles.detail}>{model.detail.text}</Text> : null}
      {model.questions?.map((question) => (
        <View key={question.id} accessibilityRole="radiogroup" accessibilityLabel={question.label} style={{ gap: spacing.xs }}>
          <Text style={styles.heading}>{question.header || question.label}</Text>
          {question.header && question.label ? <Text style={styles.muted}>{question.label}</Text> : null}
          <View style={styles.row}>
            {question.options.map((option) => (
              <Pressable
                key={option.id}
                style={[styles.action, option.disabled && styles.actionDisabled]}
                accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
                accessibilityLabel={option.label}
                accessibilityState={{ disabled: option.disabled, checked: option.selected ?? false }}
                disabled={option.disabled}
                onPress={() => onOptionChange?.(question.id, option.id)}
              >
                <Text style={styles.actionText}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
      <View style={styles.row}>
        {model.actions.filter((action) => action.kind !== 'expand' && action.visible).map((action) => (
          <Pressable
            key={action.id}
            style={[styles.action, (action.disabled || lockedActionId !== null) && styles.actionDisabled]}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ disabled: action.disabled || lockedActionId !== null, busy: action.busy || lockedActionId === action.id }}
            disabled={action.disabled || lockedActionId !== null}
            onPress={() => invokeAction(action)}
          >
            <Text style={styles.actionText}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
      {model.outcome ? (
        <Text
          style={model.outcome.status === 'failed' ? styles.failure : styles.muted}
          accessibilityRole={model.outcome.status === 'failed' ? 'alert' : 'text'}
          accessibilityLiveRegion={model.outcome.live === 'assertive' ? 'assertive' : 'polite'}
        >
          {model.outcome.label}{model.outcome.reason ? `：${model.outcome.reason}` : ''}
        </Text>
      ) : null}
    </View>
  );
}
