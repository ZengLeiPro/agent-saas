import React, { useState, useCallback, useEffect } from 'react';
import { Modal, View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, spacing, radius, typography, type ThemeColors } from '../../theme';
import { hapticLight } from '../../lib/haptics';

// ── Types ────────────────────────────────────────────────────────────

export interface DropdownAction {
  id: string;
  label: string;
  checked?: boolean;
}

export interface DropdownSection {
  id: string;
  /** Optional section header label (e.g. "模型") */
  label?: string;
  actions: DropdownAction[];
}

export interface DrillDownPage {
  title: string;
  items: { id: string; label: string }[];
  /** Show a separator after the first item (e.g. "新建分组" vs existing groups) */
  separatorAfterFirst?: boolean;
}

export interface DropdownMenuProps {
  visible: boolean;
  onClose: () => void;
  sections: DropdownSection[];
  onSelect: (actionId: string) => void;
  /** Drill-down sub-pages keyed by action ID */
  drillDowns?: Record<string, DrillDownPage>;
  onDrillDownSelect?: (parentId: string, childId: string) => void;
  /** Y position (absolute screen coords) where the dropdown top edge anchors */
  anchorTop: number;
  /** Horizontal alignment: 'center' (default), 'right', or 'left' */
  align?: 'center' | 'right' | 'left';
  /** Margin from screen edge when align is 'right' or 'left' (default: 16) */
  alignOffset?: number;
  /** Direction the menu expands: 'down' (default) anchors top edge, 'up' anchors bottom edge */
  direction?: 'down' | 'up';
}

// ── Component ────────────────────────────────────────────────────────

export function DropdownMenu({
  visible,
  onClose,
  sections,
  onSelect,
  drillDowns,
  onDrillDownSelect,
  anchorTop,
  align = 'center',
  alignOffset = 16,
  direction = 'down',
}: DropdownMenuProps) {
  const colors = useColors();
  const { height: screenHeight } = useWindowDimensions();
  const maxHeight = Math.round(screenHeight * (2 / 3));
  const styles = useStyles(colors);

  // Drill-down state: which action's sub-page is showing
  const [drillDownId, setDrillDownId] = useState<string | null>(null);

  // Reset drill-down when menu closes
  useEffect(() => {
    if (!visible) setDrillDownId(null);
  }, [visible]);

  const handleActionPress = useCallback((actionId: string) => {
    hapticLight();
    // Check if this action has a drill-down
    if (drillDowns?.[actionId]) {
      setDrillDownId(actionId);
      return;
    }
    onSelect(actionId);
    onClose();
  }, [drillDowns, onSelect, onClose]);

  const handleDrillDownItemPress = useCallback((childId: string) => {
    hapticLight();
    if (drillDownId) {
      onDrillDownSelect?.(drillDownId, childId);
    }
    onClose();
  }, [drillDownId, onDrillDownSelect, onClose]);

  const handleBack = useCallback(() => {
    hapticLight();
    setDrillDownId(null);
  }, []);

  if (!visible) return null;

  const activeDrillDown = drillDownId ? drillDowns?.[drillDownId] : null;

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={onClose} />

      {/* Dropdown card */}
      <View
        style={[
          styles.cardWrap,
          direction === 'up'
            ? { bottom: screenHeight - anchorTop + 4 }
            : { top: anchorTop + 4 },
          align === 'right'
            ? { alignItems: 'flex-end', paddingRight: alignOffset }
            : align === 'left'
              ? { alignItems: 'flex-start', paddingLeft: alignOffset }
              : { alignItems: 'center' },
        ]}
        pointerEvents="box-none"
      >
        <View style={styles.card}>
          {activeDrillDown ? (
            /* ── Drill-down page ── */
            <View>
              <Pressable style={styles.drillHeader} onPress={handleBack}>
                <Ionicons name="chevron-back" size={16} color={colors.mutedForeground} />
                <Text style={[styles.drillTitle, { color: colors.foreground }]}>
                  {activeDrillDown.title}
                </Text>
              </Pressable>
              <View style={styles.separator} />
              <ScrollView style={{ maxHeight: maxHeight - 44 }} bounces={false}>
                {activeDrillDown.items.map((item, idx) => (
                  <React.Fragment key={item.id}>
                    {activeDrillDown.separatorAfterFirst && idx === 1 && (
                      <View style={styles.separator} />
                    )}
                    <Pressable
                      style={({ pressed }) => [styles.actionItem, pressed && { backgroundColor: colors.accent }]}
                      onPress={() => handleDrillDownItemPress(item.id)}
                    >
                      <Text style={[styles.actionLabel, { color: colors.foreground }]}>{item.label}</Text>
                    </Pressable>
                  </React.Fragment>
                ))}
              </ScrollView>
            </View>
          ) : (
            /* ── Main menu ── */
            <ScrollView style={{ maxHeight: maxHeight }} bounces={false}>
              {sections.map((section, sIdx) => (
                <React.Fragment key={section.id}>
                  {sIdx > 0 && <View style={styles.separator} />}
                  {section.label && (
                    <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                      {section.label}
                    </Text>
                  )}
                  {section.actions.map((action) => {
                    const hasDrillDown = !!drillDowns?.[action.id];
                    const hasCheck = action.checked !== undefined;

                    return (
                      <Pressable
                        key={action.id}
                        style={({ pressed }) => [
                          hasCheck ? styles.modelItem : styles.actionItem,
                          pressed && { backgroundColor: colors.accent },
                        ]}
                        onPress={() => handleActionPress(action.id)}
                      >
                        <Text
                          style={[
                            hasCheck ? styles.modelLabel : styles.actionLabel,
                            { color: colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {action.label}
                        </Text>
                        {hasDrillDown && (
                          <Ionicons name="chevron-forward" size={12} color={colors.mutedForeground} />
                        )}
                        {hasCheck && (
                          <View style={styles.checkSlot}>
                            {action.checked && (
                              <Ionicons name="checkmark" size={16} color={colors.foreground} />
                            )}
                          </View>
                        )}
                      </Pressable>
                    );
                  })}
                </React.Fragment>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

function useStyles(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.15)',
    },
    cardWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      paddingVertical: spacing.xs,
      minWidth: 160,
      maxWidth: '65%',
      // Shadow
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.15,
      shadowRadius: 24,
      elevation: 12,
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginHorizontal: spacing.lg,
      marginVertical: spacing.xs,
    },
    sectionLabel: {
      ...typography.caption,
      fontWeight: '500',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: 2,
    },
    // Action items (no check slot)
    actionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 13,
      paddingHorizontal: spacing.lg,
    },
    actionLabel: {
      fontSize: 16,
      lineHeight: 22,
    },
    // Model items (with check slot)
    modelItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 13,
      paddingHorizontal: spacing.lg,
      gap: spacing.lg,
    },
    modelLabel: {
      fontSize: 16,
      lineHeight: 22,
      flex: 1,
    },
    checkSlot: {
      width: 20,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    // Drill-down header
    drillHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingVertical: 10,
      paddingHorizontal: spacing.md,
    },
    drillTitle: {
      fontSize: 16,
      fontWeight: '500',
      lineHeight: 22,
    },
  }), [colors]);
}
