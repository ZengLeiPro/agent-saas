import React, { createContext, useContext } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useColors, spacing, radius, typography, fontScale, fontWeight } from '../../theme';

/** 密度：default 用于内容卡，compact 用于列表内嵌小卡（对齐 Web CardDensity） */
export type CardDensity = 'default' | 'compact';

const CardDensityContext = createContext<CardDensity>('default');

function usePadding(): number {
  return useContext(CardDensityContext) === 'compact' ? spacing.md : spacing.lg;
}

export interface CardProps {
  children?: React.ReactNode;
  density?: CardDensity;
  /** 无内边距 + 裁剪溢出：给 ListRow 分组这种「行贴边」的卡用 */
  flush?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Card({ children, density = 'default', flush = false, style, testID }: CardProps) {
  const colors = useColors();
  return (
    <CardDensityContext.Provider value={density}>
      <View
        testID={testID}
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border },
          flush ? styles.flush : null,
          style,
        ]}
      >
        {children}
      </View>
    </CardDensityContext.Provider>
  );
}

export interface CardSlotProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function CardHeader({ children, style }: CardSlotProps) {
  const padding = usePadding();
  return (
    <View style={[{ padding, paddingBottom: spacing.sm, gap: spacing.xs }, style]}>{children}</View>
  );
}

export function CardTitle({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const colors = useColors();
  return (
    <Text
      style={[
        { ...fontScale.sm, fontWeight: fontWeight.medium, color: colors.cardForeground },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function CardDescription({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const colors = useColors();
  return (
    <Text style={[typography.bodySmall, { color: colors.mutedForeground }, style]}>{children}</Text>
  );
}

export function CardContent({ children, style }: CardSlotProps) {
  const padding = usePadding();
  return (
    <View style={[{ paddingHorizontal: padding, paddingBottom: padding }, style]}>{children}</View>
  );
}

export function CardFooter({ children, style }: CardSlotProps) {
  const padding = usePadding();
  return (
    <View
      style={[
        styles.footer,
        { paddingHorizontal: padding, paddingBottom: padding, gap: spacing.sm },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  flush: {
    overflow: 'hidden',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
