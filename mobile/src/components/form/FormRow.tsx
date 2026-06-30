import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useColors } from '../../theme';

interface FormRowProps {
  label?: string;
  children?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  rightAccessory?: React.ReactNode;
  style?: ViewStyle;
  vertical?: boolean;
  required?: boolean;
}

export function FormRow({
  label,
  children,
  onPress,
  disabled,
  rightAccessory,
  style,
  vertical,
  required,
}: FormRowProps) {
  const colors = useColors();
  const Container: any = onPress ? Pressable : View;

  const body = (
    <View
      style={[
        styles.row,
        vertical ? styles.rowVertical : null,
        style,
        disabled ? { opacity: 0.5 } : null,
      ]}
    >
      {label ? (
        <Text
          style={[
            styles.label,
            { color: colors.foreground },
            vertical ? styles.labelVertical : null,
          ]}
          numberOfLines={vertical ? 0 : 1}
        >
          {label}
          {required ? <Text style={{ color: colors.destructive }}> *</Text> : null}
        </Text>
      ) : null}
      <View style={[styles.content, vertical ? styles.contentVertical : null]}>{children}</View>
      {rightAccessory}
    </View>
  );

  if (onPress) {
    return (
      <Container
        onPress={disabled ? undefined : onPress}
        android_ripple={{ color: colors.muted }}
      >
        {body}
      </Container>
    );
  }
  return body;
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowVertical: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  label: {
    fontSize: 16,
    fontWeight: '400',
    flexShrink: 0,
    marginRight: 12,
  },
  labelVertical: {
    marginRight: 0,
    marginBottom: 6,
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  contentVertical: {
    justifyContent: 'flex-start',
  },
});
