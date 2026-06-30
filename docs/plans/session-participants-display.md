# 会话参与者显示修复 + 群聊前瞻设计 — 实施规划

> **状态**: 已实施（待手动验证）
> **创建时间**: 2026-04-13
> **最后更新**: 2026-04-13

---

## 一、问题概述

当 admin 用户查看其他用户的消息会话时，消息头部（头像 + 名字）显示错误：

| 显示位置 | 错误表现 | 期望表现 |
|---------|---------|---------|
| Web 用户消息头像/名字 | 显示 admin 自己的头像和名字 | 显示会话所属用户的头像和名字 |
| Web Agent 头像/名字 | 显示 admin 的 Agent 配置 | 显示会话所属用户的 Agent 配置 |
| Mobile 用户消息头像/名字 | 显示 admin 自己的头像和名字 | 显示会话所属用户的头像和名字 |
| Mobile Agent 头像/名字 | 显示 admin 的 Agent 配置 | 显示会话所属用户的 Agent 配置 |

**补充场景**：Admin 查看回收站中的其他用户会话时，同样存在此问题。

---

## 二、背景知识（后续 AI 必读）

### 2.1 项目架构

- **后端**: Express + TypeScript，入口 `server/src/index.ts`
- **前端 Web**: React + Vite，目录 `web/src/`
- **移动端**: Expo SDK 55 + React Native，目录 `mobile/src/`
- **共享包**: `shared/src/`（`@agent/shared`），Web 和 Mobile 共用的 types、hooks、lib

### 2.2 当前数据模型

#### 会话所有权

每个会话在 `.meta.json` 中记录 `userId` 和 `username`。API 已在返回值中包含 `owner` 字段：

```typescript
// shared/src/types/session.ts
interface ApiSessionListItem {
  sessionId: string;
  owner?: { userId: string; username: string };  // 仅 admin 可见
  // ...
}

interface ApiSessionDetail {
  sessionId: string;
  owner?: { userId: string; username: string };  // 仅 admin 可见
  blocks: ApiTranscriptBlock[];
  // ...
}
```

#### 用户信息

```typescript
// server/src/data/users/types.ts
interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'user';
  realName?: string;
  avatar?: string;          // 'avatars/uuid.jpg'
  avatarVersion?: number;   // Date.now()，用于缓存控制
  // ...
}
```

#### Agent 配置

每个用户都有一个 Agent Profile，通过 `GET /api/agents/:username` 获取：

```typescript
// shared/src/types/agent.ts
interface AgentProfile {
  username: string;
  name: string;
  avatar?: string;          // emoji 或 "agent-avatars/xxx.jpg"
  avatarVersion?: number;
  realName?: string;        // 来自 userStore
  // ...
}
```

#### 消息类型

```typescript
// shared/src/types/message.ts
type MessageItem =
  | { id: string; type: "user"; content: string; ... }    // 用户消息
  | { id: string; type: "text"; content: string; owner?: string; ... }  // AI 回复（owner 仅用于文件路径）
  | { id: string; type: "thinking"; ... }
  | { id: string; type: "tool_use"; ... }
  // ...其他类型
```

**注意**: `MessageItem` 没有发送者身份字段。当前 1:1 模型下，`type === "user"` 即为人类消息，其他为 AI 消息，身份从 session owner 推导即可。群聊时需要在 `MessageItem` 上新增 `senderId` 字段，但 **本次不改动 `MessageItem` 类型**。

### 2.3 Bug 根因详解

#### 用户消息头像（web + mobile 同一模式）

**Web** `web/src/components/MessageList.tsx:254,354-361`：
```typescript
const { user } = useAuth();  // ← 返回当前登录用户（admin），不是会话 owner
// ...
<UserMessageHeader
  userId={user?.id}            // ← admin 的 ID
  realName={user?.realName}    // ← admin 的名字
  username={user?.username}    // ← admin 的用户名
  avatar={user?.avatar}        // ← admin 的头像
  avatarVersion={user?.avatarVersion}
  timestamp={userTimestamp}
/>
```

**Mobile** `mobile/src/components/chat/MessageList.tsx:427,464-471`：
```typescript
const { user } = useAuth();       // ← 同样是当前登录用户
const { agentProfile } = useChatAppState();
const userRef = useRef(user);
// ...
<UserMessageHeader
  userId={usr?.id}
  realName={usr?.realName}
  username={usr?.username}
  userAvatar={usr?.avatar}
  userAvatarVersion={usr?.avatarVersion}
  timestamp={timestamp}
/>
```

#### Agent 消息头像（web + mobile 同一模式）

**Web** `web/src/hooks/useChatAppState.ts:114-121`：
```typescript
const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
useEffect(() => {
  if (!user) { setAgentProfile(null); return; }
  // ownerFilter 来自 admin 下拉选择，不是实际 session owner
  const targetUser = (ownerFilter && ownerFilter !== '__others__') ? ownerFilter : user.username;
  fetchAgentProfile(targetUser)
    .then(setAgentProfile)
    .catch(() => setAgentProfile(null));
}, [user, ownerFilter]);  // ← 仅当 ownerFilter 变化时才重新 fetch
```

**关键路径断裂**：
- `loadSessionDetail()` 中已提取 `data.owner?.username`（`web/src/hooks/useSession.ts:197`）
- 但仅传给 `mapSessionDetailToMessages()` 用于 `file_download` 的 `owner` 字段
- `previewFileOwner`（`web/src/hooks/useChatAppState.ts:280-284`）也取了 session owner，但仅用于文件预览
- **从未用于更新消息显示的用户/Agent 身份**

### 2.4 现有数据流图

```
Admin 选择 viewAs=UserA → ownerFilter="UserA"
  ↓
agentProfile = fetchAgentProfile("UserA")  → UserA 的 Agent 配置 ✅（ownerFilter 匹配时）
                                            → 但若 ownerFilter="__all__" 则回退到 admin 的 Agent ❌
  ↓
Admin 点击 UserB 的会话 → loadSessionDetail(sessionId)
  ↓
API 返回 data.owner = { userId: "xxx", username: "UserB" }
  ↓
sessionOwner = data.owner.username  → 仅传给 mapSessionDetailToMessages → 仅影响 file_download
  ↓
MessageList 渲染：
  用户头像 ← useAuth() → admin 的信息 ❌
  Agent 头像 ← agentProfile → UserA 的 Agent（不是 UserB 的）❌
```

### 2.5 API 现状

#### `owner` 字段构造位置

**会话列表** `server/src/routes/sessions.ts:383-386`：
```typescript
let owner: { userId: string; username: string } | undefined;
if (isAdmin && meta) {
  owner = { userId: meta.userId, username: meta.username };
}
```

**会话详情** `server/src/routes/sessions.ts:629-632`：
```typescript
const isAdmin = req.user?.role === 'admin';
const owner = isAdmin && meta
  ? { userId: meta.userId, username: meta.username }
  : undefined;
```

两处都只返回 `userId` + `username`，**不包含** `realName`、`avatar`、`avatarVersion`。

#### userStore 在 sessions 路由中的可用性

`server/src/routes/sessions.ts:71`：`options.userStore?: UserStore`。已通过参数传入，可用。

`UserStore.findById(id)` 返回 `UserRecord`，包含 `realName`、`avatar`、`avatarVersion`。

### 2.6 Web 与 Mobile 的关键架构差异

| 方面 | Web | Mobile |
|------|-----|--------|
| agentProfile 来源 | `useChatAppState` 返回值 → props 逐层传递到 `MessageList` | `useChatAppState` context → `MessageList` 内部直接调用 `useChatAppState()` |
| MessageList 接收 agentProfile | 通过 props: `agentProfile={agentProfile}` | 通过 context: `const { agentProfile } = useChatAppState()` |
| MessageList 接收 user | 内部调用 `const { user } = useAuth()` | 内部调用 `const { user } = useAuth()` |
| loadSessionDetail 回调位置 | `useSession.ts` hook（独立文件） | `useSession.ts` hook（独立文件，结构类似） |
| 回收站预览 | `useChatAppState.ts:324-346` `previewTrashSession` 函数 | 无回收站功能 |

### 2.7 关于 `fetchAgentProfile` 的请求成本

`fetchAgentProfile(username)` 调用 `GET /api/agents/:username`，返回完整 `AgentProfileDetail`。此接口：
- 读取 `workspace-shared/.claude/agents/{username}.json`
- 读取 `workspace-shared/.claude/personas/{username}.md`
- 查询 `userStore.findByUsername(username)` 获取 `realName`
- 响应时间 < 10ms（本地文件读取）

因此在 `loadSessionDetail` 中额外调用一次不会有性能问题。

---

## 三、设计方案

### 3.1 核心思路

引入 `sessionParticipants` 状态，在加载会话详情时从 API 返回的 `owner` 信息和对应的 Agent Profile 构建。当 `sessionParticipants` 不为 null 时，MessageList 使用它替代 `useAuth()` 和全局 `agentProfile`。

### 3.2 新增共享类型

**文件**: `shared/src/types/session.ts`

```typescript
/** 丰富的 owner 信息（含显示所需的头像、名字） */
export interface SessionOwnerInfo {
  userId: string;
  username: string;
  realName?: string;
  avatar?: string;
  avatarVersion?: number;
}

/** 会话参与者身份信息（用于消息渲染） */
export interface SessionParticipants {
  /** 会话所属用户的完整显示信息 */
  owner: SessionOwnerInfo;
  /** 该用户的 Agent 配置 */
  agent: AgentProfile | null;
}
```

### 3.3 API 变更：丰富 owner 字段

**文件**: `server/src/routes/sessions.ts`

将 `owner` 从 `{ userId, username }` 丰富为 `SessionOwnerInfo`（含 `realName`、`avatar`、`avatarVersion`）。

**变更点 1 — 会话列表**（约第 383 行）：

```typescript
// BEFORE:
let owner: { userId: string; username: string } | undefined;
if (isAdmin && meta) {
  owner = { userId: meta.userId, username: meta.username };
}

// AFTER:
let owner: { userId: string; username: string; realName?: string; avatar?: string; avatarVersion?: number } | undefined;
if (isAdmin && meta) {
  const record = options.userStore?.findById(meta.userId);
  owner = {
    userId: meta.userId,
    username: meta.username,
    realName: record?.realName,
    avatar: record?.avatar,
    avatarVersion: record?.avatarVersion,
  };
}
```

**变更点 2 — 会话详情**（约第 630 行）：

```typescript
// BEFORE:
const owner = isAdmin && meta
  ? { userId: meta.userId, username: meta.username }
  : undefined;

// AFTER:
const owner = isAdmin && meta
  ? (() => {
      const record = options.userStore?.findById(meta.userId);
      return {
        userId: meta.userId,
        username: meta.username,
        realName: record?.realName,
        avatar: record?.avatar,
        avatarVersion: record?.avatarVersion,
      };
    })()
  : undefined;
```

**注意**：此 endpoint 中 `options` 需要通过闭包访问。检查当前代码结构：路由定义在 `createSessionRoutes(options)` 函数内部，`options` 可通过闭包直接访问。

**变更点 3 — 共享类型**：

`shared/src/types/session.ts` 中更新 `ApiSessionListItem` 和 `ApiSessionDetail` 的 `owner` 字段类型：

```typescript
// BEFORE:
owner?: { userId: string; username: string };

// AFTER:
owner?: SessionOwnerInfo;
```

### 3.4 前端状态变更（Web）

#### 3.4.1 `useChatAppState.ts` — 新增 `sessionParticipants` 状态

**文件**: `web/src/hooks/useChatAppState.ts`

**Step 1**: 在 `ChatAppState` interface 中新增（约第 84 行 `agentProfile` 后面）：

```typescript
sessionParticipants: SessionParticipants | null;
```

**Step 2**: 在 hook 函数体中新增状态声明（约第 114 行 `agentProfile` 声明附近）：

```typescript
const [sessionParticipants, setSessionParticipants] = useState<SessionParticipants | null>(null);
```

**Step 3**: 新增 ref 以在闭包中访问最新值（在其他 ref 声明附近）：

```typescript
const sessionParticipantsRef = useRef(sessionParticipants);
sessionParticipantsRef.current = sessionParticipants;
```

**Step 4**: 在 `loadSessionDetail` 成功回调中设置 `sessionParticipants`。

当前 `useSession.ts` 的 `loadSessionDetail` 是一个独立 hook，它的回调通过 `SessionCallbacks` 接口触发。我们不直接改 `useSession.ts`，而是在 `useChatAppState.ts` 中监听 sessionId 变化。

但更准确的方案是：**扩展 `SessionCallbacks` 接口**，新增一个 `onSessionOwnerResolved` 回调，让 `useSession.ts` 在加载详情后调用它。

**然而**，仔细分析后发现更简洁的方式是：在 `useChatAppState.ts` 中利用现有的 `previewFileOwner`（已从 session list 解析出 owner）来驱动 `sessionParticipants` 的加载。但这个值只有 `username`，缺少 `realName/avatar/avatarVersion`。

**最终方案**：直接在 `useSession.ts` 的 `loadSessionDetail` 回调中返回 `data.owner`，然后由 `useChatAppState.ts` 消费。

具体实现路径如下：

**在 `useSession.ts` 中**：

1. 在 `SessionState` interface 新增：
```typescript
/** 当前加载的会话 owner 信息（仅 admin 查看他人会话时有值） */
sessionOwner: SessionOwnerInfo | null;
```

2. 在 hook 中新增状态：
```typescript
const [sessionOwner, setSessionOwner] = useState<SessionOwnerInfo | null>(null);
```

3. 在 `loadSessionDetail` 中，加载完毕后设置 owner：
```typescript
// 在 response.ok 分支内，setSessionId(id) 后面：
setSessionOwner(data.owner ?? null);
```

4. 在 `newSession` 中清空：
```typescript
setSessionOwner(null);
```

5. 返回值中包含 `sessionOwner`。

**在 `useChatAppState.ts` 中**：

1. 监听 `session.sessionOwner` 变化，异步加载对应的 Agent Profile：

```typescript
useEffect(() => {
  const owner = session.sessionOwner;
  if (!owner || owner.username === user?.username) {
    setSessionParticipants(null);
    return;
  }
  // 查看他人会话：加载该用户的 Agent Profile
  let cancelled = false;
  fetchAgentProfile(owner.username)
    .then(agent => {
      if (!cancelled) {
        setSessionParticipants({ owner, agent });
      }
    })
    .catch(() => {
      if (!cancelled) {
        // Agent 获取失败仍设置 owner 信息（头像/名字可用），agent 为 null
        setSessionParticipants({ owner, agent: null });
      }
    });
  return () => { cancelled = true; };
}, [session.sessionOwner, user?.username]);
```

2. 在 `newSessionWithUrl` 中额外清空：
```typescript
// 已由 session.newSession() → setSessionOwner(null) → useEffect 触发 setSessionParticipants(null) 自动完成
```

3. 在回收站预览 `previewTrashSession` 中也需要处理：
```typescript
// 在 previewTrashSession 中，加载成功后手动设置 sessionParticipants
if (data.owner && data.owner.username !== user?.username) {
  try {
    const agent = await fetchAgentProfile(data.owner.username);
    setSessionParticipants({ owner: data.owner, agent });
  } catch {
    setSessionParticipants({ owner: data.owner, agent: null });
  }
} else {
  setSessionParticipants(null);
}
```

4. 在返回值中包含 `sessionParticipants`。

#### 3.4.2 `MessageList.tsx`（Web）— 使用 `sessionParticipants`

**文件**: `web/src/components/MessageList.tsx`

**Step 1**: `MessageListProps` interface 新增：
```typescript
sessionParticipants?: SessionParticipants | null;
```

**Step 2**: 解构新 prop：
```typescript
export const MessageList = memo(function MessageList({
  // ...existing props...
  agentProfile,
  sessionParticipants,
}: MessageListProps) {
```

**Step 3**: 替换用户显示逻辑（约第 254 行）：

```typescript
// BEFORE:
const { user } = useAuth();

// AFTER:
const { user } = useAuth();
const displayUser = sessionParticipants?.owner ?? user;
const displayAgent = sessionParticipants?.agent ?? agentProfile;
```

**Step 4**: 替换 UserMessageHeader 调用（约第 354 行）：

```typescript
// BEFORE:
<UserMessageHeader
  userId={user?.id}
  realName={user?.realName}
  username={user?.username}
  avatar={user?.avatar}
  avatarVersion={user?.avatarVersion}
  timestamp={userTimestamp}
/>

// AFTER:
<UserMessageHeader
  userId={'userId' in (displayUser ?? {}) ? (displayUser as any).userId : (displayUser as any)?.id}
  realName={displayUser?.realName}
  username={displayUser?.username}
  avatar={displayUser?.avatar}
  avatarVersion={displayUser?.avatarVersion}
  timestamp={userTimestamp}
/>
```

**类型兼容说明**：`AuthUser` 使用 `id` 字段，`SessionOwnerInfo` 使用 `userId` 字段。`UserMessageHeader` 的 `userId` 仅用于 `UserAvatar` 组件的 URL 构造。需要统一处理。

**更优方案**：修改 `displayUser` 的构造方式，直接映射为统一格式：

```typescript
const { user } = useAuth();
const displayUser = useMemo(() => {
  const owner = sessionParticipants?.owner;
  if (owner) {
    return { id: owner.userId, realName: owner.realName, username: owner.username, avatar: owner.avatar, avatarVersion: owner.avatarVersion };
  }
  return user ? { id: user.id, realName: user.realName, username: user.username, avatar: user.avatar, avatarVersion: user.avatarVersion } : null;
}, [sessionParticipants?.owner, user]);
const displayAgent = sessionParticipants?.agent ?? agentProfile;
```

然后 UserMessageHeader 调用保持不变：
```typescript
<UserMessageHeader
  userId={displayUser?.id}
  realName={displayUser?.realName}
  username={displayUser?.username}
  avatar={displayUser?.avatar}
  avatarVersion={displayUser?.avatarVersion}
  timestamp={userTimestamp}
/>
```

**Step 5**: 替换 AiMessageHeader 调用（约第 279 行和第 330 行，有两处）：

```typescript
// BEFORE:
<AiMessageHeader agentProfile={agentProfile} timestamp={timestamp} />

// AFTER:
<AiMessageHeader agentProfile={displayAgent} timestamp={timestamp} />
```

**注意**：有两处调用 AiMessageHeader，分别在第 279 行（AI bubble group 内）和第 330 行（loading indicator 处），都需要替换。

#### 3.4.3 `ChatTabContent.tsx` — 传递新 prop

**文件**: `web/src/components/chat/ChatTabContent.tsx`

**Step 1**: `ChatTabContentProps` interface 新增：
```typescript
sessionParticipants?: SessionParticipants | null;
```

**Step 2**: 在 `ChatTabContent` 组件解构中添加 `sessionParticipants`。

**Step 3**: 传递给 `MessageList`：
```typescript
<MessageList
  // ...existing props...
  agentProfile={agentProfile}
  sessionParticipants={sessionParticipants}
/>
```

#### 3.4.4 Desktop/Mobile Layout — 传递新 prop

**文件**: `web/src/layouts/DesktopLayout.tsx` 和 `web/src/layouts/MobileLayout.tsx`

两个布局文件都需要从 `useChatAppState()` 解构 `sessionParticipants`，并传递给 `ChatTabContent`。

**DesktopLayout.tsx**（约第 235 行）：
```typescript
<ChatTabContent
  // ...existing props...
  agentProfile={agentProfile}
  sessionParticipants={sessionParticipants}
/>
```

**MobileLayout.tsx**（约第 256 行）：同上。

### 3.5 前端状态变更（Mobile）

#### 3.5.1 `useChatAppState.ts`（Mobile）

**文件**: `mobile/src/hooks/useChatAppState.ts`

与 Web 端镜像改动：

**Step 1**: `ChatAppState` interface 新增：
```typescript
sessionParticipants: SessionParticipants | null;
```

**Step 2**: hook 内新增状态 + useEffect（与 Web 端逻辑完全相同）：
```typescript
const [sessionParticipants, setSessionParticipants] = useState<SessionParticipants | null>(null);

useEffect(() => {
  const owner = session.sessionOwner;
  if (!owner || owner.username === user?.username) {
    setSessionParticipants(null);
    return;
  }
  let cancelled = false;
  fetchAgentProfile(owner.username)
    .then(agent => {
      if (!cancelled) setSessionParticipants({ owner, agent });
    })
    .catch(() => {
      if (!cancelled) setSessionParticipants({ owner, agent: null });
    });
  return () => { cancelled = true; };
}, [session.sessionOwner, user?.username]);
```

**Step 3**: 返回值中包含 `sessionParticipants`。

#### 3.5.2 `useSession.ts`（Mobile）

**文件**: `mobile/src/hooks/useSession.ts`

与 Web 端 `useSession.ts` 镜像改动：

**Step 1**: `SessionState` interface 新增 `sessionOwner: SessionOwnerInfo | null`。

**Step 2**: hook 内新增 `const [sessionOwner, setSessionOwner] = useState<SessionOwnerInfo | null>(null);`

**Step 3**: `loadSessionDetail` 中设置 `setSessionOwner(data.owner ?? null);`（约第 179-181 行之后）。

**Step 4**: `newSession` 中清空 `setSessionOwner(null);`

**Step 5**: 返回值包含 `sessionOwner`。

#### 3.5.3 `MessageList.tsx`（Mobile）

**文件**: `mobile/src/components/chat/MessageList.tsx`

**Step 1**: 在 `renderItem` 回调中（约第 427 行），替换 user/agent 来源：

```typescript
// BEFORE:
const { user } = useAuth();
const { agentProfile } = useChatAppState();
const userRef = useRef(user);
userRef.current = user;
const agentRef = useRef(agentProfile);
agentRef.current = agentProfile;

// AFTER:
const { user } = useAuth();
const { agentProfile, sessionParticipants } = useChatAppState();

const displayUser = useMemo(() => {
  const owner = sessionParticipants?.owner;
  if (owner) {
    return { id: owner.userId, realName: owner.realName, username: owner.username, avatar: owner.avatar, avatarVersion: owner.avatarVersion } as AuthUser;
  }
  return user;
}, [sessionParticipants?.owner, user]);
const displayAgent = sessionParticipants?.agent ?? agentProfile;

const userRef = useRef(displayUser);
userRef.current = displayUser;
const agentRef = useRef(displayAgent);
agentRef.current = displayAgent;
```

**Step 2**: `renderItem` 内部（约第 434 行），Agent 信息已通过 `agentRef.current` 传递，无需额外改动。

**Step 3**: User 消息渲染部分（约第 464 行），`usr` 变量引用 `userRef.current`，现在已指向 `displayUser`，也无需额外改动。

### 3.6 类型导出变更

**文件**: `shared/src/types/session.ts`

新增并导出 `SessionOwnerInfo` 和 `SessionParticipants` 类型。

**文件**: `shared/src/index.ts`

在 session 相关导出中新增：
```typescript
export type { SessionOwnerInfo, SessionParticipants } from './types/session';
```

### 3.7 状态切换矩阵

| 场景 | `session.sessionOwner` | `sessionParticipants` | 用户头像 | Agent 头像 |
|------|----------------------|----------------------|---------|-----------|
| 新会话（无 sessionId） | `null` | `null` | `useAuth()` | `agentProfile`（ownerFilter 驱动） |
| 加载自己的会话 | `null`（API 不返回 owner）或 `{ username: "admin" }` | `null`（useEffect 判断 `owner.username === user.username`） | `useAuth()` | `agentProfile`（ownerFilter 驱动） |
| admin 加载 UserA 的会话 | `{ userId, username: "UserA", realName, avatar, avatarVersion }` | `{ owner: {...}, agent: UserA 的 AgentProfile }` | owner 信息 | sessionParticipants.agent |
| admin 切换到 UserB 的会话 | 更新为 UserB 的 | 更新为 UserB 的 | UserB 信息 | UserB 的 Agent |
| admin 切回新会话 | `null` | `null` | `useAuth()` | `agentProfile` |
| admin 回收站预览 UserA 会话 | N/A（不经过 useSession） | 手动设置 | owner 信息 | sessionParticipants.agent |
| 普通用户查看自己的会话 | `null`（非 admin 不返回 owner） | `null` | `useAuth()` | `agentProfile` |

---

## 四、分步实施计划

### Phase 1: 后端 API 丰富 owner 信息

**目标**：API 返回的 `owner` 字段包含 `realName`、`avatar`、`avatarVersion`。

**文件清单**：
- `shared/src/types/session.ts` — 新增 `SessionOwnerInfo`、`SessionParticipants` 类型；更新 `ApiSessionListItem.owner` 和 `ApiSessionDetail.owner` 类型
- `shared/src/index.ts` — 导出新类型
- `server/src/routes/sessions.ts` — 两处 `owner` 构造逻辑加入 userStore 查询

**验证方法**：
```bash
# TypeScript 编译
pnpm -C shared exec tsc --noEmit
pnpm -C server exec tsc --noEmit

# 手动测试 API（需启动 dev server）
# 以 admin 身份调用 GET /api/sessions?viewAs=__all__，检查 owner 字段
# 以 admin 身份调用 GET /api/sessions/:id（他人会话），检查 owner 字段
```

### Phase 2: Web 端 useSession 暴露 sessionOwner

**目标**：`useSession` hook 在加载会话详情后暴露 `sessionOwner` 状态。

**文件清单**：
- `web/src/hooks/useSession.ts` — `SessionState` 新增 `sessionOwner`；hook 内新增状态 + 赋值逻辑

**验证方法**：
```bash
pnpm -C web exec tsc --noEmit
```

### Phase 3: Web 端 useChatAppState 新增 sessionParticipants

**目标**：`useChatAppState` 根据 `session.sessionOwner` 加载对应的 Agent Profile，构建 `sessionParticipants`。

**文件清单**：
- `web/src/hooks/useChatAppState.ts` — `ChatAppState` 新增 `sessionParticipants`；hook 内新增状态 + useEffect + 回收站预览处理

**验证方法**：
```bash
pnpm -C web exec tsc --noEmit
```

### Phase 4: Web 端 MessageList 使用 sessionParticipants

**目标**：MessageList 根据 `sessionParticipants` 显示正确的用户/Agent 信息。

**文件清单**：
- `web/src/components/MessageList.tsx` — 新增 `sessionParticipants` prop；构造 `displayUser` / `displayAgent`；替换 UserMessageHeader 和 AiMessageHeader 调用
- `web/src/components/chat/ChatTabContent.tsx` — 新增 `sessionParticipants` prop 传递
- `web/src/layouts/DesktopLayout.tsx` — 解构并传递 `sessionParticipants`
- `web/src/layouts/MobileLayout.tsx` — 解构并传递 `sessionParticipants`

**验证方法**：
```bash
pnpm -C web exec tsc --noEmit
# 浏览器测试：
# 1. admin 登录 → viewAs=__all__ → 点击其他用户的会话 → 检查用户头像/名字 + Agent 头像/名字
# 2. admin 登录 → viewAs=UserA → 点击 UserA 的会话 → 检查显示
# 3. admin 登录 → 查看自己的会话 → 检查显示（不应变化）
# 4. admin 登录 → 回收站 → 预览他人会话 → 检查显示
# 5. 切换会话 → 头像应即时切换
# 6. 新建会话 → 应显示 admin 自己的信息
```

### Phase 5: Mobile 端镜像实现

**目标**：Mobile 端实现与 Web 端相同的修复。

**文件清单**：
- `mobile/src/hooks/useSession.ts` — 镜像 Web 端 Phase 2 改动
- `mobile/src/hooks/useChatAppState.ts` — 镜像 Web 端 Phase 3 改动（**不含回收站预览**，mobile 无此功能）
- `mobile/src/components/chat/MessageList.tsx` — 镜像 Web 端 Phase 4 改动（通过 context 而非 props）

**验证方法**：
```bash
pnpm -C mobile exec tsc --noEmit
# 模拟器/真机测试：admin 登录 → 切换用户 → 点击他人会话 → 检查头像/名字
```

### Phase 6: 编译验证 + 提交

**目标**：全项目编译通过，提交代码。

**验证方法**：
```bash
pnpm -C shared exec tsc --noEmit
pnpm -C server exec tsc --noEmit
pnpm -C web exec tsc --noEmit
pnpm -C mobile exec tsc --noEmit
```

---

## 五、详细 Checklist

每完成一个子项，将 `[ ]` 改为 `[x]`，并在行末标注完成时间。

### Phase 1: 后端 API

- [x] 1.1 在 `shared/src/types/session.ts` 中新增 `SessionOwnerInfo` interface（含 `userId`, `username`, `realName?`, `avatar?`, `avatarVersion?`）
- [x] 1.2 在 `shared/src/types/session.ts` 中新增 `SessionParticipants` interface（含 `owner: SessionOwnerInfo`, `agent: AgentProfile | null`）
- [x] 1.3 更新 `ApiSessionListItem.owner` 类型为 `SessionOwnerInfo`（替换原有的 `{ userId: string; username: string }`）
- [x] 1.4 更新 `ApiSessionDetail.owner` 类型为 `SessionOwnerInfo`（替换原有的 `{ userId: string; username: string }`）
- [x] 1.5 在 `shared/src/index.ts` 中导出 `SessionOwnerInfo` 和 `SessionParticipants`
- [x] 1.6 修改 `server/src/routes/sessions.ts` 会话列表的 `owner` 构造（约第 383 行），从 `userStore.findById` 补充 `realName/avatar/avatarVersion`
- [x] 1.7 修改 `server/src/routes/sessions.ts` 会话详情的 `owner` 构造（约第 630 行），同上
- [x] 1.8 运行 `pnpm -C shared exec tsc --noEmit` 通过
- [x] 1.9 运行 `pnpm -C server exec tsc --noEmit` 通过

### Phase 2: Web useSession

- [x] 2.1 在 `web/src/hooks/useSession.ts` 的 `SessionState` interface 中新增 `sessionOwner: SessionOwnerInfo | null`（需从 `@agent/shared` 导入 `SessionOwnerInfo`）
- [x] 2.2 在 hook 函数体中新增 `const [sessionOwner, setSessionOwner] = useState<SessionOwnerInfo | null>(null);`
- [x] 2.3 在 `loadSessionDetail` 的 response.ok 分支中，`setSessionId(id)` 后面添加 `setSessionOwner(data.owner ?? null);`
- [x] 2.4 在 `newSession` 函数中添加 `setSessionOwner(null);`
- [x] 2.5 在 hook 返回值中包含 `sessionOwner`
- [x] 2.6 运行 `pnpm -C web exec tsc --noEmit` 通过

### Phase 3: Web useChatAppState

- [x] 3.1 在 `web/src/hooks/useChatAppState.ts` 的 `ChatAppState` interface 中新增 `sessionParticipants: SessionParticipants | null`（需从 `@agent/shared` 导入 `SessionParticipants`）
- [x] 3.2 在 hook 函数体中新增 `const [sessionParticipants, setSessionParticipants] = useState<SessionParticipants | null>(null);`
- [x] 3.3 新增 useEffect 监听 `session.sessionOwner` 变化（详见 3.4.1 设计），加载 Agent Profile 并设置 `sessionParticipants`
- [x] 3.4 在 `previewTrashSession` 函数中，加载成功后设置 `sessionParticipants`（参见 3.4.1 的回收站预览段落）
- [x] 3.5 在 `previewTrashSession` 的 else 分支（退出预览）中清空 `setSessionParticipants(null);`
- [x] 3.6 在 hook 返回值中包含 `sessionParticipants`
- [x] 3.7 运行 `pnpm -C web exec tsc --noEmit` 通过

### Phase 4: Web MessageList + Layout

- [x] 4.1 在 `web/src/components/MessageList.tsx` 的 `MessageListProps` 中新增 `sessionParticipants?: SessionParticipants | null`（导入类型）
- [x] 4.2 在组件函数签名中解构 `sessionParticipants`
- [x] 4.3 在组件内构造 `displayUser`（useMemo，基于 `sessionParticipants?.owner ?? user` 映射为统一格式）
- [x] 4.4 在组件内构造 `displayAgent`（`sessionParticipants?.agent ?? agentProfile`）
- [x] 4.5 将 **所有** `UserMessageHeader` 调用中的 `user?.xxx` 替换为 `displayUser?.xxx`（仅一处，约第 354 行）
- [x] 4.6 将 **所有** `AiMessageHeader` 调用中的 `agentProfile` 替换为 `displayAgent`（两处：约第 279 行和第 330 行）
- [x] 4.7 在 `web/src/components/chat/ChatTabContent.tsx` 的 `ChatTabContentProps` 中新增 `sessionParticipants?: SessionParticipants | null`
- [x] 4.8 在 `ChatTabContent` 组件中解构并传递给 `MessageList`
- [x] 4.9 在 `web/src/layouts/DesktopLayout.tsx` 中从 `useChatAppState()` 解构 `sessionParticipants`，传递给 `ChatTabContent`
- [x] 4.10 在 `web/src/layouts/MobileLayout.tsx` 中同上
- [x] 4.11 运行 `pnpm -C web exec tsc --noEmit` 通过
- [ ] 4.12 浏览器手动验证：admin 查看他人会话 → 用户头像/名字正确
- [ ] 4.13 浏览器手动验证：admin 查看他人会话 → Agent 头像/名字正确
- [ ] 4.14 浏览器手动验证：admin 查看自己的会话 → 显示不变
- [ ] 4.15 浏览器手动验证：切换不同用户会话 → 头像即时切换
- [ ] 4.16 浏览器手动验证：新建会话 → 显示 admin 自己的信息
- [ ] 4.17 浏览器手动验证：回收站预览他人会话 → 头像/名字正确

### Phase 5: Mobile 端

- [x] 5.1 在 `mobile/src/hooks/useSession.ts` 的 `SessionState` interface 中新增 `sessionOwner: SessionOwnerInfo | null`（从 `@agent/shared` 导入）
- [x] 5.2 在 hook 中新增状态 + 在 `loadSessionDetail` 中设置 + 在 `newSession` 中清空 + 返回值包含
- [x] 5.3 在 `mobile/src/hooks/useChatAppState.ts` 的 `ChatAppState` interface 中新增 `sessionParticipants: SessionParticipants | null`
- [x] 5.4 在 hook 中新增状态 + useEffect（与 web 端相同逻辑，不含回收站预览）
- [x] 5.5 在 hook 返回值中包含 `sessionParticipants`
- [x] 5.6 在 `mobile/src/components/chat/MessageList.tsx` 中：从 `useChatAppState()` 解构 `sessionParticipants`；构造 `displayUser` + `displayAgent`（参见 3.5.3 设计）
- [x] 5.7 运行 `pnpm -C mobile exec tsc --noEmit` 通过

### Phase 6: 最终验证

- [x] 6.1 全项目编译通过：`pnpm -C shared exec tsc --noEmit && pnpm -C server exec tsc --noEmit && pnpm -C web exec tsc --noEmit && pnpm -C mobile exec tsc --noEmit`
- [ ] 6.2 提交代码（遵循 Git 操作规范，不要 push）

---

## 六、边界情况与风险

### 6.1 非 admin 用户

非 admin 用户调用 API 时 `owner` 字段不会返回（服务端有 `isAdmin` 检查）。此时 `session.sessionOwner` 始终为 `null`，`sessionParticipants` 始终为 `null`，显示逻辑回退到 `useAuth()`，行为与当前完全一致。**无影响**。

### 6.2 用户已被删除或禁用

如果会话的 owner 在 userStore 中找不到（`findById` 返回 `undefined`），API 返回的 `owner` 中 `realName/avatar/avatarVersion` 为 `undefined`，前端将显示 `username` 兜底（`UserMessageHeader` 已有 `realName || username || '我'` 的 fallback）。**可接受**。

### 6.3 Agent Profile 不存在

如果某用户没有自定义 Agent Profile（首次使用的用户），`fetchAgentProfile` 可能失败或返回默认值。catch 分支将 `agent` 设为 `null`，`displayAgent` 回退到全局 `agentProfile`（`sessionParticipants?.agent ?? agentProfile`）。如果全局 agentProfile 也不匹配，AiMessageHeader 使用 `agentProfile?.name || 'AI'` 兜底。**可接受**。

### 6.4 Cron / 钉钉会话

这些会话也有 owner（meta 中的 userId/username）。admin 查看时同样会显示对应用户的头像/名字。**无特殊处理需要**。

### 6.5 WS 实时流

admin 在 web 端查看他人的活跃流（实时回复）时，`sessionParticipants` 在 `loadSessionDetail` 时已设置。WS 流式事件不改变 session owner，所以头像在流式输出期间保持正确。**无影响**。

### 6.6 `previewFileOwner` 不受影响

`previewFileOwner` 仍保持原有逻辑（从 session list 或 explicit 值取 username），不受本次改动影响。文件下载路径解析功能不变。

### 6.7 回收站预览的特殊性

回收站预览不通过 `useSession.loadSessionDetail` 流程，而是在 `useChatAppState.previewTrashSession` 中直接调用 API。因此需要在这个函数内单独处理 `sessionParticipants` 的设置和清理。退出预览时（id 为 null 或 null 参数），必须清空 `sessionParticipants`。

### 6.8 `ownerFilter` 与 `sessionParticipants` 的关系

- `ownerFilter` 控制**会话列表的过滤视角**和**新会话的 Agent Profile**
- `sessionParticipants` 控制**当前查看的历史会话的消息显示**
- 两者独立，不冲突。`ownerFilter` 变化会触发 `agentProfile` 重新加载，但如果 `sessionParticipants` 不为 null，`displayAgent` 会优先使用 `sessionParticipants.agent`

---

## 七、群聊前瞻

本次设计为未来群聊预留了如下扩展点：

### 7.1 当前设计已完成的基础

1. **消息显示与 `useAuth()` 解耦**：不再假设"用户消息 = 当前登录用户发的"
2. **Agent 显示与 `ownerFilter` 解耦**：不再假设"Agent = 当前筛选用户的 Agent"
3. **参与者信息由 session 承载**：`SessionParticipants` 是 session 级别的，不是全局的
4. **`SessionOwnerInfo` 可复用**：其字段集合（userId, username, realName, avatar, avatarVersion）与群聊中的"参与者"完全一致

### 7.2 群聊时需要的进一步改动

```typescript
// SessionParticipants 扩展
interface SessionParticipants {
  owner: SessionOwnerInfo;          // 会话创建者
  agent: AgentProfile | null;       // 主 Agent
  // 群聊新增 ↓
  members?: SessionOwnerInfo[];     // 所有人类参与者
  agents?: AgentProfile[];          // 多 Agent 场景
}

// MessageItem 扩展 — 群聊时每条消息需标识发送者
type MessageItem =
  | { id: string; type: "user"; content: string; senderId?: string; ... }
  // senderId 指向 members 中某个 userId
```

### 7.3 迁移路径

1. **现有 JSONL 不需要迁移** — 1:1 会话的参与者信息从 session meta 动态推导
2. **群聊会话在创建时原生写入 `senderId`** — 新格式，自描述
3. **渲染逻辑**：从 `displayUser`（单人固定值）扩展为 `participants.get(msg.senderId)`（查表），改动集中在 MessageList

---

## 八、禁止事项

1. **不修改 `MessageItem` 类型** — 本次不加 `senderId`，留给群聊
2. **不修改 JSONL 存储格式** — 无数据迁移
3. **不新增 API endpoint** — 复用现有 `GET /api/sessions` 和 `GET /api/agents/:username`
4. **不新增 React Context** — 在 `useChatAppState` 中管理，不引入 `SessionParticipantsContext`
5. **不修改 `useAuth()` 或 `AuthContext`** — 它只负责登录态
6. **不重启生产服务** — 按 CLAUDE.md 规范
7. **不自行 `git push`** — 按 CLAUDE.md 规范

---

## 九、文件变更全景

| 文件路径 | 改动类型 | 改动描述 |
|---------|---------|---------|
| `shared/src/types/session.ts` | 新增+修改 | 新增 `SessionOwnerInfo`、`SessionParticipants`；修改 `owner` 字段类型 |
| `shared/src/index.ts` | 修改 | 导出新类型 |
| `server/src/routes/sessions.ts` | 修改 | 两处 `owner` 构造补充 userStore 查询 |
| `web/src/hooks/useSession.ts` | 修改 | 新增 `sessionOwner` 状态 |
| `web/src/hooks/useChatAppState.ts` | 修改 | 新增 `sessionParticipants` 状态 + useEffect + 回收站处理 |
| `web/src/components/MessageList.tsx` | 修改 | 新增 prop；构造 displayUser/displayAgent；替换渲染 |
| `web/src/components/chat/ChatTabContent.tsx` | 修改 | 新增 prop 传递 |
| `web/src/layouts/DesktopLayout.tsx` | 修改 | 解构+传递 sessionParticipants |
| `web/src/layouts/MobileLayout.tsx` | 修改 | 解构+传递 sessionParticipants |
| `mobile/src/hooks/useSession.ts` | 修改 | 新增 `sessionOwner` 状态 |
| `mobile/src/hooks/useChatAppState.ts` | 修改 | 新增 `sessionParticipants` 状态 + useEffect |
| `mobile/src/components/chat/MessageList.tsx` | 修改 | 构造 displayUser/displayAgent；替换渲染 |
