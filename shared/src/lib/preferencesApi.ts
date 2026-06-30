import type { UserPreferences } from '../types/auth';
import { authFetch } from './authFetch';

export async function saveUserPreferences(
  preferences: UserPreferences,
): Promise<UserPreferences | null> {
  const res = await authFetch('/api/auth/me/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { preferences?: UserPreferences };
  return data.preferences ?? {};
}
