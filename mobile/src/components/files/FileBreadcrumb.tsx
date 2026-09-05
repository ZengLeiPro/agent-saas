/**
 * 面包屑 —— 对齐 Web `FileBrowser/Breadcrumb.tsx`：
 * Home 图标 + chevron 分隔 + 末段加粗；根段（`assets`）显示为「文件」。
 * 点中间段回到对应层级；移动端是 Stack 路由，回退由调用方决定是 pop 还是 push。
 */
import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, House } from 'lucide-react-native';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import { ICON_SIZE } from '../../lib/icons';

export interface BreadcrumbSegment {
  /** 展示文案（根段为「文件」） */
  label: string;
  /** 该段对应的完整路径 */
  path: string;
  isRoot: boolean;
  isLast: boolean;
}

/** 纯函数：把 `assets/a/b` 拆成面包屑段（根段展示为「文件」） */
export function buildBreadcrumbSegments(
  currentPath: string,
  rootLabel = '文件',
): BreadcrumbSegment[] {
  const parts = currentPath.split('/').filter(Boolean);
  if (parts.length === 0) return [];
  return parts.map((segment, index) => ({
    label: index === 0 ? rootLabel : segment,
    path: parts.slice(0, index + 1).join('/'),
    isRoot: index === 0,
    isLast: index === parts.length - 1,
  }));
}

export interface FileBreadcrumbProps {
  currentPath: string;
  rootLabel?: string;
  onNavigate: (path: string) => void;
}

export function FileBreadcrumb({ currentPath, rootLabel, onNavigate }: FileBreadcrumbProps) {
  const colors = useColors();
  const segments = useMemo(
    () => buildBreadcrumbSegments(currentPath, rootLabel),
    [currentPath, rootLabel],
  );

  if (segments.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.bar, { borderBottomColor: colors.border }]}
      contentContainerStyle={styles.content}
      accessibilityLabel="文件路径"
    >
      {segments.map((segment, index) => (
        <View key={segment.path} style={styles.segment}>
          {index > 0 ? (
            <ChevronRight size={ICON_SIZE.inline} color={colors.mutedForeground} strokeWidth={2} />
          ) : null}
          <Pressable
            disabled={segment.isLast}
            onPress={() => onNavigate(segment.path)}
            style={styles.chip}
            accessibilityRole="button"
            accessibilityLabel={segment.label}
          >
            {segment.isRoot ? (
              <House size={ICON_SIZE.inline} color={colors.mutedForeground} strokeWidth={2} />
            ) : null}
            <Text
              style={[
                styles.label,
                segment.isLast
                  ? { color: colors.foreground, fontWeight: fontWeight.semibold }
                  : { color: colors.mutedForeground },
              ]}
              numberOfLines={1}
            >
              {segment.label}
            </Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.md,
  },
  label: {
    ...fontScale.sm,
  },
});
