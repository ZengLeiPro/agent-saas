/**
 * 业务步骤墙钟耗时目录：MessageList 从完整投影建一次，主卡按 planId 取。
 * 与 Web `useBusinessStepDetail` 的 timingByPlanId 同源（shared catalog）。
 */
import React, { createContext, useContext } from 'react';
import type { BusinessStepTodoTiming } from '@agent/shared';

export type BusinessStepTimingByPlanId = ReadonlyMap<
  string,
  ReadonlyMap<string, BusinessStepTodoTiming>
>;

const EMPTY: BusinessStepTimingByPlanId = new Map();

const BusinessStepTimingContext = createContext<BusinessStepTimingByPlanId>(EMPTY);

export function BusinessStepTimingProvider({
  value,
  children,
}: {
  value: BusinessStepTimingByPlanId;
  children: React.ReactNode;
}) {
  return (
    <BusinessStepTimingContext.Provider value={value}>
      {children}
    </BusinessStepTimingContext.Provider>
  );
}

export function useBusinessStepPlanTiming(
  planId: string,
): ReadonlyMap<string, BusinessStepTodoTiming> | undefined {
  return useContext(BusinessStepTimingContext).get(planId);
}
