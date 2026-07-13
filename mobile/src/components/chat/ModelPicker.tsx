import React, { useMemo, useState, useCallback, useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import type { ModelList } from '@agent/shared';
import { useColors, typography } from '../../theme';
import { hapticLight } from '../../lib/haptics';
import {
  DropdownMenu,
  type DropdownSection,
  type DrillDownPage,
} from '../overlays/DropdownMenu';

// ── Public types ─────────────────────────────────────────────────────

export interface PickerExtraAction {
  id: string;
  label: string;
}

export interface PickerExtraSection {
  id: string;
  actions: PickerExtraAction[];
}

// ── Props ────────────────────────────────────────────────────────────

interface ModelPickerProps {
  modelList: ModelList;
  selectedModel: string | null;
  onModelChange: (ref: string) => void;
  sessionId?: string | null;
  /** Extra action sections prepended to the menu (e.g. rename, group, compact) */
  extraSections?: PickerExtraSection[];
  onExtraAction?: (actionId: string) => void;
  /** Drill-down sub-pages keyed by action ID */
  drillDowns?: Record<string, DrillDownPage>;
  onDrillDownSelect?: (parentId: string, childId: string) => void;
  /** Custom trigger content — when provided, replaces the default trigger UI */
  children?: (modelLabel: string | null) => React.ReactElement;
}

// ── Component ────────────────────────────────────────────────────────

export function ModelPicker({
  modelList,
  selectedModel,
  onModelChange,
  sessionId,
  extraSections,
  onExtraAction,
  drillDowns,
  onDrillDownSelect,
  children,
}: ModelPickerProps) {
  const colors = useColors();
  const [visible, setVisible] = useState(false);
  const [anchorTop, setAnchorTop] = useState(0);
  const triggerRef = useRef<View>(null);

  // ── Derived data ──

  const selectedModelLabel = (() => {
    if (!selectedModel) return null;
    const slashIdx = selectedModel.indexOf('/');
    if (slashIdx < 0) return null;
    const groupId = selectedModel.slice(0, slashIdx);
    const modelId = selectedModel.slice(slashIdx + 1);
    const group = modelList.groups.find(g => g.id === groupId);
    return group?.models.find(m => m.id === modelId)?.name ?? null;
  })();

  // Lock to current group when session has started
  const lockedGroupId = useMemo(() => {
    if (!sessionId || sessionId === 'new' || !selectedModel || modelList.allowCrossGroupSwitch) {
      return null;
    }
    const slashIdx = selectedModel.indexOf('/');
    return slashIdx >= 0 ? selectedModel.slice(0, slashIdx) : null;
  }, [sessionId, selectedModel, modelList.allowCrossGroupSwitch]);

  // ── Build sections for DropdownMenu ──

  const sections = useMemo<DropdownSection[]>(() => {
    const result: DropdownSection[] = [];

    // Extra action sections
    if (extraSections?.length) {
      for (const es of extraSections) {
        result.push({
          id: es.id,
          actions: es.actions.map(a => ({ id: a.id, label: a.label })),
        });
      }
    }

    const visibleGroups = modelList.groups.filter(g => !lockedGroupId || g.id === lockedGroupId);

    if (modelList.showGroupNames) {
      for (const group of visibleGroups) {
        result.push({
          id: `_models:${group.id}`,
          label: group.name,
          actions: group.models.map(model => {
            const ref = `${group.id}/${model.id}`;
            return {
              id: ref,
              label: model.name,
              checked: selectedModel === ref,
            };
          }),
        });
      }
      return result;
    }

    // Model list section
    const modelActions = visibleGroups.flatMap(group =>
      group.models.map(model => {
        const ref = `${group.id}/${model.id}`;
        return {
          id: ref,
          label: model.name,
          checked: selectedModel === ref,
        };
      }),
    );

    result.push({
      id: '_models',
      label: '模型',
      actions: modelActions,
    });

    return result;
  }, [modelList, selectedModel, lockedGroupId, extraSections]);

  // ── Handlers ──

  const handleOpen = useCallback(() => {
    hapticLight();
    triggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setAnchorTop(y + h);
      setVisible(true);
    });
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  const handleSelect = useCallback((actionId: string) => {
    // Model refs always contain "/"
    if (actionId.includes('/')) {
      onModelChange(actionId);
    } else {
      onExtraAction?.(actionId);
    }
  }, [onModelChange, onExtraAction]);

  // ── Render ──

  return (
    <>
      <Pressable ref={triggerRef} onPress={handleOpen}>
        {children ? children(selectedModelLabel) : (
          <View style={defaultStyles.trigger}>
            <Text style={[defaultStyles.triggerText, { color: colors.mutedForeground }]} numberOfLines={1}>
              {selectedModelLabel ?? '模型'}
            </Text>
            <ChevronDown size={12} color={colors.mutedForeground} strokeWidth={2} />
          </View>
        )}
      </Pressable>

      <DropdownMenu
        visible={visible}
        onClose={handleClose}
        sections={sections}
        onSelect={handleSelect}
        drillDowns={drillDowns}
        onDrillDownSelect={onDrillDownSelect}
        anchorTop={anchorTop}
      />
    </>
  );
}

// ── Default trigger styles ───────────────────────────────────────────

const defaultStyles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 4,
    maxWidth: 140,
  },
  triggerText: {
    ...typography.caption,
    fontSize: 14,
  },
});
