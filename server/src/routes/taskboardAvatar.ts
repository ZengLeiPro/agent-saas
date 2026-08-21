import type { UserStore } from '../data/users/store.js';
import { buildAvatarUrl } from './authAvatar.js';
import type {
  TaskBoardDirectoryUser,
  TaskBoardExecutionStartResult,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import type { TaskboardIdentity, TaskboardPage } from '../taskboard/types.js';

export function listTaskboardDirectoryUsers(
  userStore: Pick<UserStore, 'listAll'>,
  tenantId: string,
): TaskBoardDirectoryUser[] {
  return userStore.listAll()
    .filter((user) => user.tenantId === tenantId)
    .sort((left, right) => {
      const leftLabel = left.realName?.trim() || left.username;
      const rightLabel = right.realName?.trim() || right.username;
      return leftLabel.localeCompare(rightLabel, 'zh-CN')
        || left.username.localeCompare(right.username, 'zh-CN');
    })
    .map((user): TaskBoardDirectoryUser => ({
      id: user.id,
      username: user.username,
      ...(user.realName?.trim() ? { realName: user.realName.trim() } : {}),
      ...(user.avatar ? { avatar: buildAvatarUrl(user.id, user.avatar, user.avatarVersion) } : {}),
      ...(user.avatarVersion ? { avatarVersion: user.avatarVersion } : {}),
      ...(user.disabled ? { disabled: true } : {}),
    }));
}

export function withCreatorAvatarVersion(
  userStore: Pick<UserStore, 'findById'> | undefined,
  identity: TaskboardIdentity,
  task: TaskBoardTask,
): TaskBoardTask {
  if (!userStore || !task.creatorUserId) return task;
  const creator = userStore.findById(task.creatorUserId);
  if (!creator || creator.tenantId !== identity.tenantId || !creator.avatarVersion) return task;
  return { ...task, creatorAvatarVersion: creator.avatarVersion };
}

export function withCreatorAvatarVersions(
  userStore: Pick<UserStore, 'findById'> | undefined,
  identity: TaskboardIdentity,
  tasks: TaskBoardTask[],
): TaskBoardTask[] {
  return tasks.map((task) => withCreatorAvatarVersion(userStore, identity, task));
}

export function withCreatorAvatarVersionsPage(
  userStore: Pick<UserStore, 'findById'> | undefined,
  identity: TaskboardIdentity,
  page: TaskboardPage<TaskBoardTask>,
): TaskboardPage<TaskBoardTask> {
  return { ...page, items: withCreatorAvatarVersions(userStore, identity, page.items) };
}

export function withCreatorAvatarVersionInExecution(
  userStore: Pick<UserStore, 'findById'> | undefined,
  identity: TaskboardIdentity,
  execution: TaskBoardExecutionStartResult,
): TaskBoardExecutionStartResult {
  return { ...execution, task: withCreatorAvatarVersion(userStore, identity, execution.task) };
}
