import { describe, expect, it } from 'vitest';

import {
  KY_APP_INSTALLATION_STATUSES,
  KY_APP_SYSTEM_STATUSES,
  canTransitionInstallationStatus,
  canTransitionSystemStatus,
} from './types.js';

describe('定制项目系统状态机（规范 §8.1、§3.7）', () => {
  it('draft→published→disabled→published/retired，retired 是终态', () => {
    expect(canTransitionSystemStatus('draft', 'published')).toBe(true);
    expect(canTransitionSystemStatus('published', 'disabled')).toBe(true);
    expect(canTransitionSystemStatus('disabled', 'published')).toBe(true);
    expect(canTransitionSystemStatus('published', 'retired')).toBe(true);
    expect(canTransitionSystemStatus('disabled', 'retired')).toBe(true);
    for (const status of KY_APP_SYSTEM_STATUSES) {
      expect(canTransitionSystemStatus('retired', status)).toBe(false);
    }
    expect(canTransitionSystemStatus('draft', 'disabled')).toBe(false);
    expect(canTransitionSystemStatus('draft', 'retired')).toBe(false);
  });

  it('安装实例 deleted 是吸收终态，enabled/disabled 可互转', () => {
    expect(canTransitionInstallationStatus('pending', 'enabled')).toBe(true);
    expect(canTransitionInstallationStatus('enabled', 'disabled')).toBe(true);
    expect(canTransitionInstallationStatus('disabled', 'enabled')).toBe(true);
    expect(canTransitionInstallationStatus('enabled', 'deleted')).toBe(true);
    for (const status of KY_APP_INSTALLATION_STATUSES) {
      expect(canTransitionInstallationStatus('deleted', status)).toBe(false);
    }
    expect(canTransitionInstallationStatus('enabled', 'pending')).toBe(false);
  });
});
