import { beforeEach, describe, expect, it } from 'vitest';

import { markAnalysisHistoryEntry } from './analysisHistory';
import { readPersonalSettingsHistoryState, settingsHistoryState } from './managementHistory';

describe('settingsHistoryState', () => {
  beforeEach(() => window.history.replaceState({}, '', '/tenant-admin/overview'));

  it('从分析工作区进入设置时保留分析返回链', () => {
    markAnalysisHistoryEntry('/capabilities', 1);

    const state = settingsHistoryState({ source: '/tenant-admin/overview', depth: 1 });

    expect(state).toMatchObject({
      analysisWorkspace: { source: '/capabilities', depth: 1 },
    });
    expect(readPersonalSettingsHistoryState(state)).toEqual({
      source: '/tenant-admin/overview',
      depth: 1,
    });
  });
});
