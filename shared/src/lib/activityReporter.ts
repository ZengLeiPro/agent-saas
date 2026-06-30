import { authFetch } from './authFetch';

export interface ActivityLocation {
  latitude: number;
  longitude: number;
}

/** 客户端可上报的活动事件 */
export type ActivityEvent =
  | 'app_foreground' | 'app_background'
  | 'page_viewed'
  | 'agent_profile_viewed' | 'agent_persona_viewed' | 'agent_memory_viewed';

export function reportActivity(
  event: ActivityEvent,
  options?: { location?: ActivityLocation; detail?: string },
): void {
  authFetch('/api/auth/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...options }),
  }).catch(() => {});
}
