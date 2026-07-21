import { useCallback, useState } from "react";
import {
  INDUSTRY_ALL,
  useIndustryFilter,
} from "./useIndustryFilter";
import {
  OUTCOME_ALL,
  ROLE_ALL,
  VERTICAL_ALL,
  BUSINESS_MODEL_ALL,
  MATURITY_ALL,
  type BusinessModelFilterValue,
  type MaturityFilterValue,
  type OutcomeFilterValue,
  type RoleFilterValue,
  type VerticalFilterValue,
} from "./workflowUi";

export function useScenarioFilters() {
  const { activeIndustry, setActiveIndustry } = useIndustryFilter();
  const [activeOutcome, setActiveOutcome] = useState<OutcomeFilterValue>(OUTCOME_ALL);
  const [activeRole, setActiveRole] = useState<RoleFilterValue>(ROLE_ALL);
  const [activeVertical, setActiveVertical] = useState<VerticalFilterValue>(VERTICAL_ALL);
  const [activeBusinessModel, setActiveBusinessModel] = useState<BusinessModelFilterValue>(BUSINESS_MODEL_ALL);
  const [activeMaturity, setActiveMaturity] = useState<MaturityFilterValue>(MATURITY_ALL);

  const clearFilters = useCallback(() => {
    setActiveOutcome(OUTCOME_ALL);
    setActiveRole(ROLE_ALL);
    setActiveIndustry(INDUSTRY_ALL);
    setActiveVertical(VERTICAL_ALL);
    setActiveBusinessModel(BUSINESS_MODEL_ALL);
    setActiveMaturity(MATURITY_ALL);
  }, [setActiveIndustry]);

  return {
    activeOutcome,
    setActiveOutcome,
    activeRole,
    setActiveRole,
    activeIndustry,
    setActiveIndustry,
    activeVertical,
    setActiveVertical,
    activeBusinessModel,
    setActiveBusinessModel,
    activeMaturity,
    setActiveMaturity,
    clearFilters,
  };
}
