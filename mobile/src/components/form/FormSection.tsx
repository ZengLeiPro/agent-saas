import React, { Children, isValidElement, cloneElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme';

interface FormSectionProps {
  header?: string;
  footer?: string;
  children: React.ReactNode;
  required?: boolean;
}

export function FormSection({ header, footer, children, required }: FormSectionProps) {
  const colors = useColors();
  const items = Children.toArray(children).filter((c) => c != null);

  return (
    <View style={styles.wrapper}>
      {header ? (
        <Text style={[styles.header, { color: colors.mutedForeground }]}>
          {header.toUpperCase()}
          {required ? <Text style={{ color: colors.destructive }}> *</Text> : null}
        </Text>
      ) : null}
      <View
        style={[
          styles.card,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
          },
        ]}
      >
        {items.map((child, idx) => {
          const showSeparator = idx < items.length - 1;
          return (
            <View key={idx}>
              {isValidElement(child) ? child : <View>{child}</View>}
              {showSeparator ? (
                <View style={[styles.separator, { backgroundColor: colors.border }]} />
              ) : null}
            </View>
          );
        })}
      </View>
      {footer ? (
        <Text style={[styles.footer, { color: colors.mutedForeground }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: 24,
  },
  header: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  footer: {
    fontSize: 12,
    paddingHorizontal: 20,
    marginTop: 8,
    lineHeight: 16,
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
});
