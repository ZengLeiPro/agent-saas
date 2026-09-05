import { describe, expect, it } from 'vitest';
import {
  LEGACY_FALLBACK_REASON,
  resolveScenarioLibraryOutcome,
  scenarioLibraryEndpoint,
  wantsWorkflowLibraryV3,
} from './scenarioLibraryMode';

describe('工作流目录版本选择', () => {
  it('只有显式 v3 才请求 v3 目录（其余 fail closed 到 legacy）', () => {
    expect(wantsWorkflowLibraryV3('v3')).toBe(true);
    expect(wantsWorkflowLibraryV3('v2')).toBe(false);
    expect(wantsWorkflowLibraryV3('v1')).toBe(false);
    expect(wantsWorkflowLibraryV3(undefined)).toBe(false);
    expect(wantsWorkflowLibraryV3(null)).toBe(false);
    expect(wantsWorkflowLibraryV3('V3')).toBe(false);
  });

  it('端点由版本唯一决定', () => {
    expect(scenarioLibraryEndpoint(true)).toBe('/api/scenarios/v3');
    expect(scenarioLibraryEndpoint(false)).toBe('/api/scenarios');
  });

  it('v3 拿到 → v3；v3 拿不到 → legacy-fallback 且必须给出回落理由', () => {
    expect(resolveScenarioLibraryOutcome({ wantsV3: true, v3Loaded: true })).toEqual({
      mode: 'v3',
      fallbackReason: null,
    });
    expect(resolveScenarioLibraryOutcome({ wantsV3: true, v3Loaded: false })).toEqual({
      mode: 'legacy-fallback',
      fallbackReason: LEGACY_FALLBACK_REASON,
    });
  });

  it('不想要 v3 时是纯 legacy，不产生误导性的回落提示', () => {
    expect(resolveScenarioLibraryOutcome({ wantsV3: false, v3Loaded: false })).toEqual({
      mode: 'legacy',
      fallbackReason: null,
    });
  });
});
