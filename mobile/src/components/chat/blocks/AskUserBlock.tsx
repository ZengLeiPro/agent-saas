/** 追问块：单/多选项、自定义回答输入与提交。 */
import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput } from 'react-native';
import { Circle, CircleDot, Square, SquareCheck } from 'lucide-react-native';
import type { AskUserAnswers, MessageItem } from '@agent/shared';
import { useColors, spacing, useChatTypography } from '../../../theme';
import { useMessageStyles } from './shared';

// --- Ask User Block ---
export function AskUserBlock({
  message,
  onResponse,
  disabled = false,
}: {
  message: MessageItem & { type: 'ask_user' };
  onResponse?: (interactionId: string, answers: AskUserAnswers) => Promise<void>;
  disabled?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

  const handleOptionSelect = useCallback(
    (q: { question: string; multiSelect: boolean }, optionLabel: string) => {
      setSelections((prev) => {
        const current = new Set(prev[q.question] ?? []);
        if (optionLabel === '__custom__') {
          if (current.has('__custom__')) {
            current.delete('__custom__');
          } else {
            if (!q.multiSelect) current.clear();
            current.add('__custom__');
          }
        } else {
          if (current.has(optionLabel)) {
            current.delete(optionLabel);
          } else {
            if (!q.multiSelect) current.clear();
            current.add(optionLabel);
          }
          current.delete('__custom__');
        }
        return { ...prev, [q.question]: current };
      });
    },
    [],
  );

  const handleSubmit = useCallback(() => {
    if (!onResponse) return;
    const answers: AskUserAnswers = {};
    for (const q of message.questions) {
      const selected = selections[q.question];
      if (selected?.has('__custom__')) {
        const labels = Array.from(selected).filter((label) => label !== '__custom__');
        const customValue = customInputs[q.question] ?? '';
        answers[q.question] = q.multiSelect
          ? [...labels, customValue].filter(Boolean)
          : customValue;
      } else {
        const labels = selected ? Array.from(selected) : [];
        answers[q.question] = q.multiSelect ? labels : (labels[0] ?? '');
      }
    }
    void onResponse(message.interactionId, answers);
  }, [onResponse, message, selections, customInputs]);

  const hasAnySelection = useMemo(
    () => Object.values(selections).some((s) => s.size > 0),
    [selections],
  );

  const isAnswered = message.status === 'answered';
  const isPending = message.status === 'pending' && !disabled;

  // Parse answered multi-select values back to Set for highlight
  const answeredSets = useMemo(() => {
    if (!isAnswered || !message.answers) return {} as Record<string, Set<string>>;
    const result: Record<string, Set<string>> = {};
    for (const [k, v] of Object.entries(message.answers)) {
      result[k] = new Set(Array.isArray(v) ? v : v ? v.split(', ') : []);
    }
    return result;
  }, [isAnswered, message.answers]);

  return (
    <View style={styles.askUserBlock}>
      {message.questions.map((q, qi) => {
        const selectedSet = isPending
          ? (selections[q.question] ?? new Set())
          : (answeredSets[q.question] ?? new Set());
        return (
          <View key={qi} style={styles.questionContainer}>
            <View style={{ marginBottom: spacing.sm }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: q.header && q.question ? 4 : 0,
                }}
              >
                <Text style={[styles.questionHeader, { marginBottom: 0, flex: 1 }]}>
                  {q.header || q.question}
                </Text>
                <Text style={{ ...typo.caption, color: colors.mutedForeground }}>
                  {q.multiSelect ? '多选' : '单选'}
                </Text>
              </View>
              {q.header && q.question ? (
                <Text style={{ ...typo.body, color: colors.foreground }}>{q.question}</Text>
              ) : null}
            </View>
            {q.options.map((opt, oi) => {
              const isSelected = selectedSet.has(opt.label);
              const OptionIcon = q.multiSelect
                ? isSelected
                  ? SquareCheck
                  : Square
                : isSelected
                  ? CircleDot
                  : Circle;
              return (
                <TouchableOpacity
                  key={oi}
                  style={[
                    styles.optionButton,
                    { flexDirection: 'row', alignItems: 'center', gap: 8 },
                    isSelected && styles.optionSelected,
                  ]}
                  accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityLabel={`${q.header || q.question}: ${opt.label}${opt.description ? `, ${opt.description}` : ''}`}
                  accessibilityState={{ checked: isSelected, disabled: !isPending }}
                  onPress={() => isPending && handleOptionSelect(q, opt.label)}
                  disabled={!isPending}
                >
                  <OptionIcon
                    size={18}
                    color={isSelected ? colors.primary : colors.mutedForeground}
                    strokeWidth={2}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optionLabel}>{opt.label}</Text>
                    {opt.description ? (
                      <Text style={styles.optionDesc}>{opt.description}</Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}
            {(() => {
              const answer = isAnswered ? message.answers?.[q.question] : '';
              const answerText = Array.isArray(answer) ? answer.join(', ') : (answer ?? '');
              const matchesOptions = q.options.some((opt) => selectedSet.has(opt.label));
              const isCustomAnswer = isAnswered && !matchesOptions && answerText.length > 0;

              if (!isPending && !isCustomAnswer) return null;

              const isCustomSelected = isPending ? selectedSet.has('__custom__') : true;
              const CustomOptionIcon = q.multiSelect
                ? isCustomSelected
                  ? SquareCheck
                  : Square
                : isCustomSelected
                  ? CircleDot
                  : Circle;
              return (
                <>
                  <TouchableOpacity
                    style={[
                      styles.optionButton,
                      { flexDirection: 'row', alignItems: 'center', gap: 8 },
                      isCustomSelected && styles.optionSelected,
                    ]}
                    accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                    accessibilityLabel={`${q.header || q.question}: 自定义回答`}
                    accessibilityState={{ checked: isCustomSelected, disabled: !isPending }}
                    onPress={() => isPending && handleOptionSelect(q, '__custom__')}
                    disabled={!isPending}
                  >
                    <CustomOptionIcon
                      size={18}
                      color={isCustomSelected ? colors.primary : colors.mutedForeground}
                      strokeWidth={2}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.optionLabel}>Other</Text>
                      <Text style={styles.optionDesc}>
                        {isCustomAnswer ? answerText : '输入自定义回答'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  {isPending && isCustomSelected && (
                    <TextInput
                      style={{
                        backgroundColor: colors.secondary,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        marginTop: 4,
                        color: colors.foreground,
                        ...typo.body,
                      }}
                      accessibilityLabel={`${q.header || q.question} 自定义回答`}
                      placeholder="请输入回答"
                      placeholderTextColor={colors.mutedForeground}
                      value={customInputs[q.question] ?? ''}
                      onChangeText={(text) =>
                        setCustomInputs((prev) => ({ ...prev, [q.question]: text }))
                      }
                    />
                  )}
                </>
              );
            })()}
          </View>
        );
      })}
      {isPending && onResponse && (
        <TouchableOpacity
          testID="ask-user-submit"
          style={[styles.submitButton, !hasAnySelection && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel="提交回答"
          onPress={handleSubmit}
          disabled={!hasAnySelection}
        >
          <Text style={styles.submitText}>提交</Text>
        </TouchableOpacity>
      )}
      {isAnswered && <Text style={[styles.statusBadge, styles.allowedBadge]}>已回答</Text>}
    </View>
  );
}
