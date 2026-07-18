/**
 * 空会话推荐位
 *
 * 新会话空白态（当前会话没有任何消息）时，在消息区展示 3 张跨岗位精选场景卡
 * + 「查看全部场景」入口。点击卡片 = 把起手 prompt 预填进当前输入框
 * （当前会话本来就是空的，无需再新建会话），用户可编辑后自行发送。
 *
 * 仅桌面端接入（由 DesktopLayout 传入 MessageList 的 emptySlot），移动端不挂。
 */
import { ArrowRight } from "lucide-react";
import { buildScenarioPrompt } from "@agent/shared";
import type { ScenarioItem } from "@agent/shared";
import { useAuth } from "@/contexts/AuthContext";
import { ScenarioCard } from "./ScenarioCard";
import {
  matchRoleIdByPosition,
  pickRecommendedScenarios,
  useScenarioLibrary,
} from "./useScenarioLibrary";
import { matchIndustry, useIndustryFilter } from "./useIndustryFilter";

interface EmptySessionScenariosProps {
  /** 点推荐卡：入参为填充好槽位示例值的起手 prompt（上层直接预填当前输入框） */
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  /** 「查看全部场景」：跳转到场景库整页 */
  onViewAll: () => void;
}

export function EmptySessionScenarios({ onTryScenario, onViewAll }: EmptySessionScenariosProps) {
  const { library, loading, error } = useScenarioLibrary();
  const { user } = useAuth();
  const { activeIndustry } = useIndustryFilter();

  // 加载中/失败时保持空白态安静，不打扰用户（推荐位是锦上添花，不是硬依赖）
  if (loading || error || !library || library.scenarios.length === 0) return null;

  const industryFiltered = library.scenarios.filter((s) =>
    matchIndustry(s.industryFocus, activeIndustry),
  );
  const pool = industryFiltered.length > 0 ? industryFiltered : library.scenarios;

  // 用户配置了岗位且命中场景库岗位时，本岗位场景优先（至多 2 张 + 1 张跨岗位精选）
  const preferredRoleId = matchRoleIdByPosition(library.roles, user?.position);
  const recommended = pickRecommendedScenarios(pool, 3, preferredRoleId);

  return (
    <div className="mx-auto w-full max-w-2xl pt-[12vh]">
      <div className="mb-3 text-center text-sm text-muted-foreground">
        不知道从哪开始？试试这些任务模板——点一下就把起手话术填进输入框
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {recommended.map((scenario) => (
          <ScenarioCard
            key={scenario.id}
            scenario={scenario}
            compact
            onTry={(s) => onTryScenario(buildScenarioPrompt(s), s)}
          />
        ))}
      </div>
      <div className="mt-3 flex justify-center">
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1 text-sm text-link hover:underline"
        >
          查看全部模板
          <ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
