/**
 * 场景库行业筛选状态：URL ?industry=<x> ↔ localStorage ↔ 用户资料 industryHint 三源合流。
 *
 * 读取优先级：URL > localStorage > user.preferences.industryHint > "all"
 * 写入策略：只有用户主动 select 才同时写 URL + localStorage；从 URL 初始化不回写 localStorage
 * （避免分享链接污染本地偏好）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { IndustryType } from "@agent/shared";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { useAuth } from "@/contexts/AuthContext";

export const INDUSTRY_ALL = "all" as const;
export type IndustryFilterValue = IndustryType | typeof INDUSTRY_ALL;

const STORAGE_KEY = "ky.scenarios.industry";
const VALID: IndustryType[] = [
  "manufacturing",
  "trade",
  "retail",
  "service",
  "export",
  "ecommerce",
];

function isIndustry(v: string | null | undefined): v is IndustryType {
  return !!v && (VALID as string[]).includes(v);
}

function readStorage(): IndustryType | null {
  try {
    const v = typeof window === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return isIndustry(v) ? v : null;
  } catch {
    return null;
  }
}

export function useIndustryFilter(): {
  activeIndustry: IndustryFilterValue;
  setActiveIndustry: (next: IndustryFilterValue) => void;
} {
  const { user } = useAuth();
  const url = useAdminUrlQuery();
  const urlIndustry = url.get("industry");

  const initial = useMemo<IndustryFilterValue>(() => {
    if (isIndustry(urlIndustry)) return urlIndustry;
    const stored = readStorage();
    if (stored) return stored;
    const hint = user?.preferences?.industryHint;
    if (isIndustry(hint)) return hint;
    return INDUSTRY_ALL;
    // 仅首次 mount 计算；后续用 setActiveIndustry 显式变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [activeIndustry, setActiveIndustryState] = useState<IndustryFilterValue>(initial);

  // 首次挂载时如果 URL 与 initial 一致就不需要 sync；如果初值来自 storage / preferences，
  // 把它反映到 URL 便于分享。
  useEffect(() => {
    if (activeIndustry !== INDUSTRY_ALL && urlIndustry !== activeIndustry) {
      url.set("industry", activeIndustry);
    }
    // 仅在 mount 时同步一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setActiveIndustry = useCallback(
    (next: IndustryFilterValue) => {
      setActiveIndustryState(next);
      if (next === INDUSTRY_ALL) {
        url.set("industry", null);
        try {
          if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      } else {
        url.set("industry", next);
        try {
          if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* ignore */
        }
      }
    },
    [url],
  );

  return { activeIndustry, setActiveIndustry };
}

/**
 * 场景是否命中当前行业筛选。
 * 关键语义：industryFocus 未填 = 全行业通用（任何 industry 都命中）。
 */
export function matchIndustry(
  scenarioIndustryFocus: readonly string[] | undefined,
  active: IndustryFilterValue,
): boolean {
  if (active === INDUSTRY_ALL) return true;
  if (!scenarioIndustryFocus || scenarioIndustryFocus.length === 0) return true;
  return scenarioIndustryFocus.includes(active);
}
