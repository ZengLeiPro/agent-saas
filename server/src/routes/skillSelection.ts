import type { Router } from 'express';
import { z } from 'zod';
import { auditLog } from '../data/login-logs/index.js';
import { SkillSelectionVersionConflictError, type SkillConfigStore } from '../data/skills/store.js';
import type { UserStore } from '../data/users/store.js';
import type { UserRecord } from '../data/users/types.js';
import { serverLogger } from '../utils/logger.js';

const skillSelectionSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

interface SkillSelectionRouteDeps {
  skillConfigStore: SkillConfigStore;
  userStore: UserStore;
  safeName(name: string): string | null;
  getSelectableSkillIdsForUser(user: UserRecord): Promise<Set<string>>;
}

export function isSkillSelectionPreferenceWrite(method: string, path: string): boolean {
  return method === 'PUT' && /^\/me\/skills\/[^/]+\/selection$/.test(path);
}

/** Register the versioned single-skill preference update endpoint. */
export function registerSkillSelectionRoute(router: Router, deps: SkillSelectionRouteDeps): void {
  const { skillConfigStore, userStore, safeName, getSelectableSkillIdsForUser } = deps;
  router.put('/me/skills/:skillId/selection', async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    const parsed = skillSelectionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid selection', details: parsed.error.format() });

    const allowed = await getSelectableSkillIdsForUser(user);
    if (!allowed.has(skillId)) {
      return res.status(403).json({
        error: `技能“${skillId}”未向当前用户开放，无法修改选择`,
        code: 'SKILL_NOT_SELECTABLE',
      });
    }
    try {
      const selection = await skillConfigStore.updateUserSkillSelection(
        username,
        skillId,
        parsed.data.enabled,
        parsed.data.expectedVersion,
      );
      auditLog(req, 'skill_user_selections_updated', `${username}/${skillId}: ${parsed.data.enabled ? 'enabled' : 'disabled'}`);
      return res.json({
        ok: true,
        skillId,
        selected: parsed.data.enabled,
        selectionVersion: selection.revision,
      });
    } catch (error) {
      if (error instanceof SkillSelectionVersionConflictError) {
        return res.status(409).json({
          error: '技能选择已在其他页面更新，已同步服务端最新状态，请重试',
          code: 'SKILL_SELECTION_VERSION_CONFLICT',
          current: {
            skillId,
            selected: error.selectedSkills.includes(skillId),
            selectionVersion: error.revision,
          },
        });
      }
      serverLogger.error(`PUT /me/skills/${skillId}/selection error: ${error}`);
      return res.status(500).json({ error: '更新技能选择失败' });
    }
  });
}

/** Preserve unversioned compatibility writes used by upload/delete flows and older test doubles. */
export async function setUserSkillSelected(
  store: SkillConfigStore,
  username: string,
  skillId: string,
  enabled: boolean,
): Promise<void> {
  if (typeof store.setUserSkillSelected === 'function') {
    await store.setUserSkillSelected(username, skillId, enabled);
    return;
  }
  const current = store.getUserSelectedSkills(username);
  const next = enabled
    ? [...new Set([...current, skillId])]
    : current.filter(id => id !== skillId);
  await store.setUserSelectedSkills(username, next);
}

/** Build the shared selection fields without changing legacy stores that expose no revision. */
export function userSkillSelectionState(store: SkillConfigStore, username: string) {
  const selected = new Set(store.getUserSelectedSkills(username));
  const selectionVersion = typeof store.getUserSelectionRevision === 'function'
    ? store.getUserSelectionRevision(username)
    : undefined;
  return (skillId: string) => ({
    selected: selected.has(skillId),
    ...(selectionVersion === undefined ? {} : { selectionVersion }),
  });
}
