# 会话分组后端化实施计划

## 目标

将会话分组数据从前端 localStorage 迁移到后端 JSON 文件持久化。同时将当前的两套模型（manual groups + cron overlays）统一为一套 `SessionGroup` 模型。

## 当前状况

### 前端分组相关文件（待替换/大幅改造）

| 文件 | 当前职责 |
|------|---------|
| `web/src/hooks/useManualGroups.ts` | 手动分组的 localStorage CRUD |
| `web/src/hooks/useCronGroupOverlays.ts` | Cron 覆盖层的 localStorage CRUD |
| `web/src/hooks/useGroupedSessions.ts` | 将两套数据合并为统一的 `SessionListEntry[]`（216 行复杂逻辑） |
| `web/src/components/DesktopSessionSidebar.tsx` | 桌面端侧边栏，调用上述 hooks，处理分组操作 |
| `web/src/components/MobileSessionList.tsx` | 移动端会话列表，镜像桌面端的分组操作 |
| `web/src/components/chat/AddToGroupDialog.tsx` | "添加到分组"弹窗 |
| `web/src/components/chat/AddSessionsToGroupDialog.tsx` | "批量添加会话到分组"弹窗 |
| `web/src/types/sessionGroup.ts` | `SessionGroup` 和 `SessionListEntry` 类型定义 |

### 后端现有存储模式（参考模板）

项目使用纯 JSON 文件存储，零数据库依赖：

- **UserStore** (`server/src/data/users/store.ts`)：class 模式，构造函数同步 load，方法内 async persist。这是我们要模仿的模板。
- **CronStore** (`server/src/cron/store.ts`)：函数式，原子写入（`.tmp` + `rename`）。
- 所有路径通过 `config.json` 配置，支持相对路径（相对 server/）和 `~` 扩展。

### 后端路由注册模式

- `server/src/app/routes.ts`：在 `registerRoutes()` 中调用 `app.use('/api', createXxxRouter(options))`
- `server/src/routes/index.ts`：统一导出所有路由创建函数
- `server/src/app/runtime.ts`：在 `createRuntime()` 中初始化所有 store/service，传入 `AppRuntime`

---

## 统一数据模型

### `SessionGroup` 定义

```ts
interface SessionGroup {
  id: string;              // 手动组 = UUID，cron 组 = "cron:{cronJobId}"
  userId: string;          // 所属用户
  name: string;            // 显示名称
  kind: "manual" | "cron"; // 分组来源
  cronJobId?: string;      // kind=cron 时关联的 cronJobId
  sessionIds: string[];    // 成员会话 ID 列表（有序）
  createdAt: number;       // 创建时间戳 ms
  updatedAt: number;       // 最后修改时间戳 ms
}
```

### 存储文件格式

```json
{
  "version": 1,
  "groups": [
    {
      "id": "cron:abc-123",
      "userId": "user-uuid",
      "name": "每日报告",
      "kind": "cron",
      "cronJobId": "abc-123",
      "sessionIds": ["sid-1", "sid-2"],
      "createdAt": 1708700000000,
      "updatedAt": 1708700000000
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "userId": "user-uuid",
      "name": "我的项目",
      "kind": "manual",
      "sessionIds": ["sid-3", "sid-4"],
      "createdAt": 1708700000000,
      "updatedAt": 1708700000000
    }
  ]
}
```

默认文件路径：`./data/groups.json`（相对 server/ 目录）。

### 与旧模型的映射

- 旧 `ManualGroupStore` 中的每个 `groupKey -> {name, sessionIds, createdAt}` -> 一条 `SessionGroup`，`kind: "manual"`，`id` 复用旧 `groupKey`
- 旧 `CronGroupOverlay` 不需要迁移——后端化后 cron 分组由执行器自动维护完整的 `sessionIds`，不再需要 overlay 概念

---

## 实施步骤

### 第一步：后端 GroupStore

**新建 `server/src/data/groups/store.ts`**

参照 `UserStore` 的 class 模式：

```ts
export class GroupStore {
  private groups: SessionGroup[] = [];
  private filePath: string;

  constructor(filePath: string)         // 同步 load
  private load(): void                  // readFileSync + JSON.parse
  private async persist(): Promise<void> // 原子写入（.tmp + rename）

  // 查询
  findById(id: string): SessionGroup | undefined;
  listByUserId(userId: string): SessionGroup[];
  listAll(): SessionGroup[];
  findByCronJobId(cronJobId: string): SessionGroup | undefined;

  // 写入
  async create(input: CreateGroupInput): Promise<SessionGroup>;
  async update(id: string, patch: UpdateGroupInput): Promise<SessionGroup | undefined>;
  async delete(id: string): Promise<boolean>;
  async addSessions(groupId: string, sessionIds: string[], userId: string): Promise<SessionGroup | undefined>;
  async removeSessions(groupId: string, sessionIds: string[]): Promise<SessionGroup | undefined>;
  async removeSessionFromAllGroups(sessionId: string): Promise<void>;  // 级联清理
}
```

关键行为：
- `addSessions`：添加前先从该用户的其他分组中移除这些 session（一个 session 只属于一个分组）。如果目标分组不属于该 userId，拒绝操作。
- `removeSessions`：移除后如果分组为空，不自动删除（让用户决定）。但 kind=cron 的空分组可以自动删除。
- `removeSessionFromAllGroups`：会话被删除时调用，遍历所有分组移除该 sessionId。
- persist 使用原子写入：写 `.tmp` 文件再 `rename`（参照 `cron/store.ts` 第 49-51 行的模式）。

**新建 `server/src/data/groups/types.ts`**

```ts
export interface SessionGroup {
  id: string;
  userId: string;
  name: string;
  kind: "manual" | "cron";
  cronJobId?: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GroupsStoreFile {
  version: number;
  groups: SessionGroup[];
}

export interface CreateGroupInput {
  name: string;
  kind?: "manual" | "cron";   // 默认 "manual"
  cronJobId?: string;
  sessionIds?: string[];
  userId: string;
}

export interface UpdateGroupInput {
  name?: string;
  sessionIds?: string[];       // 整体替换（用于排序场景）
}
```

**新建 `server/src/data/groups/index.ts`**

导出 store 和 types。

### 第二步：后端 Groups API 路由

**新建 `server/src/routes/groups.ts`**

```ts
export function createGroupsRouter(groupStore: GroupStore): Router
```

端点设计：

```
GET    /api/groups                   # 获取当前用户的分组
POST   /api/groups                   # 创建分组
PATCH  /api/groups/:id               # 更新分组（改名、替换 sessionIds）
DELETE /api/groups/:id               # 删除分组
POST   /api/groups/:id/sessions      # 批量添加会话到分组
DELETE /api/groups/:id/sessions      # 批量移除会话
```

权限规则：
- 所有端点需要认证（通过 `req.user`）
- `GET /api/groups`：admin 返回所有分组（或可加 `?userId=xxx`），普通用户只返回自己的
- 写操作：只能操作自己的分组（admin 可操作任何人的）
- `POST /api/groups`：`userId` 从 `req.user.sub` 获取（不由客户端传入）

**注意**：如果 auth 未启用（`req.user` 为 undefined），使用默认 userId `"anonymous"`。这样无认证模式下也能正常工作。

### 第三步：注册路由与初始化 GroupStore

**修改 `server/src/app/runtime.ts`**

在 `createRuntime()` 中：
- import `GroupStore`
- 初始化 `groupStore`，文件路径默认 `resolve(processCwd, './data/groups.json')`
- 将 `groupStore` 加入 `AppRuntime` interface

```ts
// 在 AppRuntime interface 中添加：
groupStore?: GroupStore;

// 在 createRuntime() 中添加（放在 userStore 初始化之后）：
import { GroupStore } from '../data/groups/store.js';

const groupsFilePath = resolve(processCwd, './data/groups.json');
const groupStore = new GroupStore(groupsFilePath);
```

**修改 `server/src/app/routes.ts`**

在 `registerRoutes()` 中注册 groups 路由：

```ts
import { createGroupsRouter } from '../routes/groups.js';

// 在 registerRoutes() 中添加（userStore 注册之后）：
if (runtime.groupStore) {
  app.use('/api', createGroupsRouter(runtime.groupStore));
}
```

**修改 `server/src/routes/index.ts`**

添加导出：
```ts
export { createGroupsRouter } from './groups.js';
```

### 第四步：Cron 执行器集成

**修改 `server/src/cron/service.ts`**

在 `CronServiceDeps` interface 中添加可选回调：

```ts
onSessionCreated?: (jobId: string, jobName: string, sessionId: string, owner?: string) => Promise<void>;
```

在 `executeJobInternal()` 方法中，执行成功（`status === "ok"` 且有 `sessionId`）后调用此回调。

**修改 `server/src/cron/bootstrap.ts`**

`CreateCronRuntimeOptions` 添加可选 `groupStore?: GroupStore`。

在 `createCronRuntime()` 中，构造 `CronService` 时传入 `onSessionCreated`：

```ts
onSessionCreated: groupStore ? async (jobId, jobName, sessionId, owner) => {
  const cronGroupId = `cron:${jobId}`;
  const existing = groupStore.findByCronJobId(jobId);
  if (existing) {
    await groupStore.addSessions(cronGroupId, [sessionId], existing.userId);
  } else if (owner) {
    await groupStore.create({
      name: jobName,
      kind: "cron",
      cronJobId: jobId,
      sessionIds: [sessionId],
      userId: owner,
    });
  }
} : undefined,
```

**修改 `server/src/app/runtime.ts`**

在 `createCronRuntime()` 调用中传入 `groupStore`。

### 第五步：会话删除级联清理

**修改 `server/src/routes/sessions.ts`**

`createSessionsRouter` 的 options 新增可选 `groupStore?: GroupStore`。

在 `DELETE /api/sessions/:sessionId` 路由中，删除成功后：

```ts
if (options.groupStore) {
  await options.groupStore.removeSessionFromAllGroups(sessionId);
}
```

**修改 `server/src/app/routes.ts`**

传递 `groupStore` 给 `createSessionsRouter`。

### 第六步：Cron 任务删除联动

**修改 `server/src/routes/cron.ts`**

`createCronRouter` 新增可选参数 `groupStore?: GroupStore`。

在 `DELETE /api/cron/jobs/:id` 路由中，删除成功后：

```ts
if (groupStore) {
  const group = groupStore.findByCronJobId(jobId);
  if (group) {
    // 降级为手动组（保留历史会话的组织关系）
    await groupStore.update(group.id, { kind: "manual", cronJobId: undefined });
  }
}
```

注意：`UpdateGroupInput` 需要扩展支持 `kind` 和 `cronJobId` 字段（内部使用，不暴露给 API）。或者在 GroupStore 上新增一个 `detachFromCron(cronJobId: string)` 方法。

### 第七步：前端改造 - API 层

**新建 `web/src/lib/groupsApi.ts`**

```ts
import { authFetch } from "@/lib/authFetch";

export interface ApiSessionGroup {
  id: string;
  userId: string;
  name: string;
  kind: "manual" | "cron";
  cronJobId?: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export async function fetchGroups(): Promise<ApiSessionGroup[]> {
  const res = await authFetch("/api/groups");
  if (!res.ok) return [];
  const data = await res.json();
  return data.groups ?? [];
}

export async function createGroup(name: string): Promise<ApiSessionGroup | null> {
  const res = await authFetch("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
  });
  return res.ok;
}

export async function updateGroup(groupId: string, patch: { name?: string }): Promise<ApiSessionGroup | null> {
  const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function addSessionsToGroup(groupId: string, sessionIds: string[]): Promise<ApiSessionGroup | null> {
  const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionIds }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.group ?? null;
}

export async function removeSessionsFromGroup(groupId: string, sessionIds: string[]): Promise<ApiSessionGroup | null> {
  const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}/sessions`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionIds }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.group ?? null;
}
```

### 第八步：前端改造 - useGroups hook

**新建 `web/src/hooks/useGroups.ts`**

替代 `useManualGroups` + `useCronGroupOverlays`，直接与后端 API 交互：

```ts
import { useState, useCallback, useEffect } from "react";
import type { ApiSessionGroup } from "@/lib/groupsApi";
import * as api from "@/lib/groupsApi";

export function useGroups() {
  const [groups, setGroups] = useState<ApiSessionGroup[]>([]);
  const [loading, setLoading] = useState(false);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.fetchGroups();
      setGroups(data);
    } finally {
      setLoading(false);
    }
  }, []);

  // 初始加载
  useEffect(() => { void loadGroups(); }, [loadGroups]);

  const createGroup = useCallback(async (name: string): Promise<string | null> => {
    const group = await api.createGroup(name);
    if (group) {
      setGroups(prev => [...prev, group]);
      return group.id;
    }
    return null;
  }, []);

  const addSessionsToGroup = useCallback(async (groupId: string, sessionIds: string[]) => {
    const updated = await api.addSessionsToGroup(groupId, sessionIds);
    if (updated) {
      // 后端已处理跨组移动，重新加载所有分组以获取最新状态
      await loadGroups();
    }
  }, [loadGroups]);

  const removeSessionsFromGroup = useCallback(async (groupId: string, sessionIds: string[]) => {
    const updated = await api.removeSessionsFromGroup(groupId, sessionIds);
    if (updated) {
      setGroups(prev => prev.map(g => g.id === groupId ? updated : g).filter(g => g.sessionIds.length > 0 || g.kind === "cron"));
    }
  }, []);

  const deleteGroup = useCallback(async (groupId: string) => {
    const ok = await api.deleteGroup(groupId);
    if (ok) {
      setGroups(prev => prev.filter(g => g.id !== groupId));
    }
  }, []);

  const renameGroup = useCallback(async (groupId: string, name: string) => {
    const updated = await api.updateGroup(groupId, { name });
    if (updated) {
      setGroups(prev => prev.map(g => g.id === groupId ? updated : g));
    }
  }, []);

  return {
    groups,
    loading,
    loadGroups,
    createGroup,
    addSessionsToGroup,
    removeSessionsFromGroup,
    deleteGroup,
    renameGroup,
  };
}
```

### 第九步：前端改造 - useGroupedSessions 简化

**重写 `web/src/hooks/useGroupedSessions.ts`**

从 216 行简化到约 60 行。不再需要 `ManualGroupStore`、`CronGroupOverlayStore` 参数。

新签名：

```ts
export function useGroupedSessions(
  sessions: ChatSessionIndexItem[],
  searchQuery: string,
  groups: ApiSessionGroup[],    // 后端返回的统一分组数据
): SessionListEntry[]
```

逻辑：

```ts
return useMemo(() => {
  // 搜索模式：展平
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    return sessions
      .filter(s => s.title.toLowerCase().includes(q))
      .map(s => ({ type: "session", session: s }));
  }

  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  const consumed = new Set<string>();
  const entries: SessionListEntry[] = [];

  // 处理所有后端分组
  for (const group of groups) {
    const children = group.sessionIds
      .map(sid => sessionMap.get(sid))
      .filter((s): s is ChatSessionIndexItem => s !== undefined);

    if (children.length === 0) continue;

    children.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const c of children) consumed.add(c.id);

    entries.push({
      type: "group",
      group: {
        groupKey: group.id,
        name: group.name,
        kind: group.kind,
        children,
        latestUpdatedAt: children[0].updatedAt,
        count: children.length,
      },
    });
  }

  // 未分组会话
  for (const s of sessions) {
    if (!consumed.has(s.id)) {
      entries.push({ type: "session", session: s });
    }
  }

  // 混合排序
  entries.sort((a, b) => {
    const timeA = a.type === "session" ? a.session.updatedAt : a.group.latestUpdatedAt;
    const timeB = b.type === "session" ? b.session.updatedAt : b.group.latestUpdatedAt;
    return timeB - timeA;
  });

  return entries;
}, [sessions, searchQuery, groups]);
```

注意：不再需要"单会话 cron 组扁平化"逻辑，因为后端的 cron 分组在创建时就已确定包含哪些会话。如果 cron 分组只有 1 个 session，仍然显示为分组（后端决定何时创建分组）。

### 第十步：前端改造 - Sidebar 组件

**改造 `web/src/components/DesktopSessionSidebar.tsx`**

主要变更：
1. 移除 `useManualGroups()` 和 `useCronGroupOverlays()` 调用
2. 添加 `useGroups()` hook
3. `useGroupedSessions(sessions, query, groups.groups)` —— 传入后端分组数据
4. 所有分组操作改为调用 `groups.xxx()` 异步 API 方法（原来是同步 localStorage 操作）
5. `handleAddToExistingGroup`：直接调用 `groups.addSessionsToGroup(groupKey, [sessionId])`，后端处理跨组清理
6. `handleCreateGroupAndAdd`：调用 `groups.createGroup(name)` 获取新 groupId，再 `groups.addSessionsToGroup(groupId, [sessionId])`
7. `handleRemoveFromGroup`：调用 `groups.removeSessionsFromGroup(expandedGroup.groupKey, [sessionId])`
8. `handleAddSessionsToGroup`：调用 `groups.addSessionsToGroup(expandedGroup.groupKey, sessionIds)`
9. 移除 stale cleanup useEffect（后端会话删除时自动清理）
10. 移除 `isInManualGroup` / `isInGroup` 的区分——统一为"在任何分组中都可移出"

**镜像改造 `web/src/components/MobileSessionList.tsx`**

与 Desktop 完全相同的逻辑变更。

### 第十一步：前端改造 - AddToGroupDialog

**改造 `web/src/components/chat/AddToGroupDialog.tsx`**

无需大改。`allGroups` 的来源从前端计算改为后端数据，但 props interface 不变（`SessionGroup[]`）。

### 第十二步：清理旧文件

**删除**：
- `web/src/hooks/useManualGroups.ts`
- `web/src/hooks/useCronGroupOverlays.ts`

确认无其他文件引用这两个 hook 后删除。

### 第十三步：类型调整

**修改 `web/src/types/sessionGroup.ts`**

当前定义不变（`SessionGroup` 和 `SessionListEntry`），但确认前端的 `SessionGroup.groupKey` 对应后端的 `id` 字段。

---

## 重要注意事项

### 1. 异步操作与 UX

旧代码中分组操作是同步的（localStorage 立即写入），新代码是异步的（API 调用）。需要：
- 操作期间可以做乐观更新（先更新本地状态，API 失败再回滚）
- 或简单方案：API 完成后 `loadGroups()` 刷新（可能有短暂延迟，但逻辑简单）
- 建议先用简单方案，后续如有性能需求再加乐观更新

### 2. 无认证模式兼容

如果 `config.auth.enabled = false`，`req.user` 为 undefined。Groups API 需要兼容这种情况：
- userId 使用 `req.user?.sub ?? "anonymous"`
- `GET /api/groups` 返回所有分组（无需权限过滤）

### 3. Cron 执行器的 owner

`CronJob` 有 `owner` 字段（userId），cron 分组的 `userId` 应与之一致。如果 cron job 没有 owner（历史数据），使用 `"system"` 作为 userId。

### 4. 会话隔离与分组隔离一致

确保普通用户只能看到/操作自己的分组。admin 看全部（与 sessions API 行为一致）。

### 5. 分组为空时的处理

- 手动分组清空：不自动删除，让用户显式删除
- cron 分组清空：不自动删除（cron 可能后续还会产生新会话）
- 前端 `useGroupedSessions` 跳过 `children.length === 0` 的分组即可

### 6. 编译验证

每步完成后运行：
```bash
cd server && npx tsc --noEmit
cd web && npx tsc --noEmit
```

---

## 文件变更清单

### 后端（新建）
- `server/src/data/groups/types.ts`
- `server/src/data/groups/store.ts`
- `server/src/data/groups/index.ts`
- `server/src/routes/groups.ts`

### 后端（修改）
- `server/src/app/runtime.ts` — 初始化 GroupStore，加入 AppRuntime
- `server/src/app/routes.ts` — 注册 groups 路由
- `server/src/routes/index.ts` — 导出 createGroupsRouter
- `server/src/routes/sessions.ts` — 删除会话时级联清理分组
- `server/src/cron/service.ts` — 添加 onSessionCreated 回调
- `server/src/cron/bootstrap.ts` — 传入 groupStore 和 onSessionCreated
- `server/src/routes/cron.ts` — 删除 cron 任务时降级分组

### 前端（新建）
- `web/src/lib/groupsApi.ts`
- `web/src/hooks/useGroups.ts`

### 前端（重写）
- `web/src/hooks/useGroupedSessions.ts` — 从 216 行简化到 ~60 行

### 前端（改造）
- `web/src/components/DesktopSessionSidebar.tsx` — 用 useGroups 替代旧 hooks
- `web/src/components/MobileSessionList.tsx` — 同上
- `web/src/components/chat/AddToGroupDialog.tsx` — 微调（如有需要）

### 前端（删除）
- `web/src/hooks/useManualGroups.ts`
- `web/src/hooks/useCronGroupOverlays.ts`
