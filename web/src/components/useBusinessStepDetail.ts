import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type { RenderItem } from './types';
import {
  buildBusinessStepCatalog,
  businessStepSelectionKey,
  findBusinessStepDetail,
  type BusinessStepFollowMode,
  type BusinessStepSelection,
} from './businessStepViewModel';

export type BusinessStepDetailMode = 'desktop' | 'mobile';

export function useBusinessStepDetail({
  groupedMessages,
  sessionId,
  detailMode,
  detailHost,
  panelOpen,
  onPanelOpenChange,
  scrollContainerRef,
}: {
  groupedMessages: RenderItem[];
  sessionId?: string | null;
  detailMode?: BusinessStepDetailMode;
  detailHost?: HTMLElement | null;
  panelOpen?: boolean;
  onPanelOpenChange?: (open: boolean) => void;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const catalog = useMemo(() => buildBusinessStepCatalog(groupedMessages), [groupedMessages]);
  const [selection, setSelection] = useState<BusinessStepSelection | null>(null);
  const [followMode, setFollowMode] = useState<BusinessStepFollowMode>('fixed');
  const mobileScrollTopRef = useRef<number | null>(null);
  const previousSessionIdRef = useRef(sessionId);
  const previousPanelOpenRef = useRef(panelOpen);
  const selectedPlan = selection ? (catalog.planById.get(selection.planId) ?? null) : null;
  const selectedDetail = findBusinessStepDetail(catalog, selection);
  const detailsOpen = panelOpen ?? !!selection;
  const selectedKey = selection ? businessStepSelectionKey(selection) : null;

  const restoreTriggerFocus = useCallback(
    (selectionKey: string | null) => {
      if (!selectionKey) return;
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        const rows =
          container?.querySelectorAll<HTMLElement>('[data-business-step-select-key]') ?? [];
        for (const row of rows) {
          if (row.dataset.businessStepSelectKey !== selectionKey) continue;
          row.focus({ preventScroll: true });
          return;
        }
        container?.focus({ preventScroll: true });
      });
    },
    [scrollContainerRef],
  );

  const clearSelection = useCallback(
    (notify = true, restoreFocus = true) => {
      const selectionKey = selection ? businessStepSelectionKey(selection) : null;
      setSelection(null);
      setFollowMode('fixed');
      if (detailMode === 'mobile' && mobileScrollTopRef.current !== null) {
        const scrollTop = mobileScrollTopRef.current;
        mobileScrollTopRef.current = null;
        requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: scrollTop }));
      }
      if (restoreFocus) restoreTriggerFocus(selectionKey);
      if (notify) onPanelOpenChange?.(false);
    },
    [detailMode, onPanelOpenChange, restoreTriggerFocus, scrollContainerRef, selection],
  );

  const selectStep = useCallback(
    (nextSelection: BusinessStepSelection) => {
      const plan = catalog.planById.get(nextSelection.planId);
      const nextFollowMode: BusinessStepFollowMode =
        plan?.currentTodoKey === nextSelection.todoKey ? 'follow' : 'fixed';
      if (detailMode === 'mobile' && !detailsOpen) {
        mobileScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? null;
      }
      setSelection(nextSelection);
      setFollowMode(nextFollowMode);
      onPanelOpenChange?.(true);
    },
    [catalog.planById, detailMode, detailsOpen, onPanelOpenChange, scrollContainerRef],
  );

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    setSelection(null);
    setFollowMode('fixed');
    mobileScrollTopRef.current = null;
    onPanelOpenChange?.(false);
  }, [onPanelOpenChange, sessionId]);

  useEffect(() => {
    const previousOpen = previousPanelOpenRef.current;
    previousPanelOpenRef.current = panelOpen;
    if (previousOpen === true && panelOpen === false && selection) {
      clearSelection(false, false);
    }
  }, [clearSelection, panelOpen, selection]);

  useEffect(() => {
    if (!selection || followMode !== 'follow') return;
    const plan = catalog.planById.get(selection.planId);
    if (!plan?.currentTodoKey) {
      setFollowMode('fixed');
      return;
    }
    if (plan.currentTodoKey !== selection.todoKey) {
      setSelection({ ...selection, todoKey: plan.currentTodoKey });
    }
  }, [catalog.planById, followMode, selection]);

  useEffect(() => {
    if (!selection || !selectedPlan) return;
    if (selection.generationId === selectedPlan.event.generationId) return;
    setSelection({ ...selection, generationId: selectedPlan.event.generationId });
  }, [selectedPlan, selection]);

  useEffect(() => {
    if (!selection || selectedDetail) return;
    const replacementPlans = catalog.plans.filter((plan) =>
      plan.details.some((detail) => detail.todoKey === selection.todoKey)
      && (selection.runId ? plan.event.runId === selection.runId : !plan.event.runId)
      && (!selection.generationId || plan.event.generationId === selection.generationId));
    const replacementPlan = replacementPlans.length === 1 ? replacementPlans[0] : null;
    // 有 runId 也必须按 reset 划分的计划世代唯一匹配；legacy 无 runId 则沿用
    // todoKey 唯一候选。任何歧义都关闭详情，不能默认跳到最后一个计划。
    if (replacementPlan) {
      setSelection({ ...selection, planId: replacementPlan.event.id });
      return;
    }
    clearSelection();
  }, [catalog.plans, clearSelection, selectedDetail, selection]);

  useLayoutEffect(() => {
    if (!detailsOpen || detailMode !== 'desktop' || !selectedKey) return;
    const frame = requestAnimationFrame(() => {
      const rows =
        scrollContainerRef.current?.querySelectorAll<HTMLElement>(
          '[data-business-step-select-key]',
        ) ?? [];
      for (const row of rows) {
        if (row.dataset.businessStepSelectKey !== selectedKey) continue;
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        break;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [detailHost, detailMode, detailsOpen, scrollContainerRef, selectedKey]);

  const selectRelative = useCallback(
    (offset: -1 | 1) => {
      if (!selection || !selectedPlan) return;
      const index = selectedPlan.details.findIndex(
        (detail) => detail.todoKey === selection.todoKey,
      );
      const next = selectedPlan.details[index + offset];
      if (next) selectStep({ ...selection, todoKey: next.todoKey });
    },
    [selectStep, selectedPlan, selection],
  );

  const returnToCurrent = useCallback(() => {
    if (!selection || !selectedPlan?.currentTodoKey) return;
    setSelection({ ...selection, todoKey: selectedPlan.currentTodoKey });
    setFollowMode('follow');
  }, [selectedPlan, selection]);

  return {
    catalog,
    selection,
    followMode,
    selectedPlan,
    selectedDetail,
    detailsOpen,
    selectStep,
    clearSelection,
    selectRelative,
    returnToCurrent,
  };
}
