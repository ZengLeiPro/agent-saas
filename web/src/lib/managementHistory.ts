import { analysisHistoryStateForNavigation } from './analysisHistory';
import { parseGovernanceUrl } from './governanceNavigation';
import { managementPageForRoute } from './managementNavigation';

const SETTINGS_HISTORY_KEY = '__personalSettingsV2';
export interface PersonalSettingsHistoryState {
  source: string;
  depth: number;
}

export function readPersonalSettingsHistoryState(
  state: unknown = window.history.state,
): PersonalSettingsHistoryState | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[SETTINGS_HISTORY_KEY];
  if (!value || typeof value !== 'object') return null;
  const { source, depth } = value as Partial<PersonalSettingsHistoryState>;
  return typeof source === 'string' &&
    source.startsWith('/') &&
    Number.isInteger(depth) &&
    (depth ?? 0) > 0
    ? { source, depth: depth! }
    : null;
}

export function settingsHistoryState(
  navigation?: PersonalSettingsHistoryState,
): Record<string, unknown> {
  return navigation ? { [SETTINGS_HISTORY_KEY]: navigation } : {};
}

/** 设置中的详情、页签和筛选与侧栏共享来源；只按实际 push 累计返回层数。 */
export function managementHistoryStateForNavigation(
  mode: 'push' | 'replace',
  href: string,
): Record<string, unknown> {
  const parsed = parseGovernanceUrl(href);
  const isSettings =
    parsed.kind === 'route' &&
    (parsed.route.area === 'settings' ||
      managementPageForRoute(parsed.route)?.surface === 'config');
  const current = readPersonalSettingsHistoryState();
  if (isSettings && current) {
    return settingsHistoryState({
      source: current.source,
      depth: current.depth + (mode === 'push' ? 1 : 0),
    });
  }
  return analysisHistoryStateForNavigation(mode, href);
}
