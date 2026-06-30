import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useColors, useTheme } from '../../theme';
import { FormRow } from './FormRow';

interface FormDateTimeRowProps {
  label: string;
  value: Date;
  onChange: (date: Date) => void;
  mode?: 'date' | 'time' | 'datetime';
  disabled?: boolean;
  minimumDate?: Date;
  maximumDate?: Date;
}

function formatDate(d: Date, mode: 'date' | 'time' | 'datetime'): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (mode === 'date') return date;
  if (mode === 'time') return time;
  return `${date} ${time}`;
}

export function FormDateTimeRow({
  label,
  value,
  onChange,
  mode = 'datetime',
  disabled,
  minimumDate,
  maximumDate,
}: FormDateTimeRowProps) {
  const colors = useColors();
  const { isDark } = useTheme();
  const [androidStep, setAndroidStep] = useState<'idle' | 'date' | 'time'>('idle');
  const [androidDraft, setAndroidDraft] = useState<Date>(value);
  const [iosVisible, setIosVisible] = useState(false);

  const display = formatDate(value, mode);

  const openPicker = () => {
    if (disabled) return;
    if (Platform.OS === 'android') {
      setAndroidDraft(value);
      setAndroidStep(mode === 'time' ? 'time' : 'date');
    } else {
      setIosVisible(true);
    }
  };

  return (
    <>
      <FormRow label={label} disabled={disabled} onPress={openPicker}>
        <View style={styles.valueWrap}>
          <Text style={[styles.value, { color: colors.mutedForeground }]} numberOfLines={1}>
            {display}
          </Text>
        </View>
      </FormRow>

      {Platform.OS === 'ios' && iosVisible ? (
        <Modal
          transparent
          visible={iosVisible}
          animationType="fade"
          onRequestClose={() => setIosVisible(false)}
        >
          <View style={[styles.iosBackdrop, { backgroundColor: colors.overlay }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setIosVisible(false)} />
            <View style={[styles.iosSheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <DateTimePicker
                value={value}
                mode={mode === 'datetime' ? 'datetime' : mode}
                display="spinner"
                minimumDate={minimumDate}
                maximumDate={maximumDate}
                onChange={(_, d) => {
                  if (d) onChange(d);
                }}
                themeVariant={isDark ? 'dark' : 'light'}
              />
              <Pressable
                onPress={() => setIosVisible(false)}
                style={[styles.iosDone, { borderTopColor: colors.border }]}
              >
                <Text style={[styles.iosDoneText, { color: colors.primary }]}>完成</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}

      {Platform.OS === 'android' && androidStep === 'date' ? (
        <DateTimePicker
          value={androidDraft}
          mode="date"
          display="default"
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          onChange={(event, d) => {
            if (event.type === 'dismissed') {
              setAndroidStep('idle');
              return;
            }
            if (!d) {
              setAndroidStep('idle');
              return;
            }
            const next = new Date(androidDraft);
            next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
            setAndroidDraft(next);
            if (mode === 'datetime') {
              setAndroidStep('time');
            } else {
              setAndroidStep('idle');
              onChange(next);
            }
          }}
        />
      ) : null}

      {Platform.OS === 'android' && androidStep === 'time' ? (
        <DateTimePicker
          value={androidDraft}
          mode="time"
          display="default"
          is24Hour
          onChange={(event, d) => {
            setAndroidStep('idle');
            if (event.type === 'dismissed' || !d) return;
            const next = new Date(androidDraft);
            next.setHours(d.getHours(), d.getMinutes(), 0, 0);
            onChange(next);
          }}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  valueWrap: {
    flex: 1,
    alignItems: 'flex-end',
  },
  value: {
    fontSize: 16,
  },
  iosBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  iosSheet: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  iosDone: {
    paddingVertical: 14,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  iosDoneText: {
    fontSize: 17,
    fontWeight: '600',
  },
});
