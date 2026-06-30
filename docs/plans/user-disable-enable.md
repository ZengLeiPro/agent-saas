# 用户禁用/启用功能 — 实施规划

> **状态**: 待实施
> **创建时间**: 2026-03-11
> **最后更新**: 2026-03-11

---

## 一、功能概述

在用户管理模块新增"禁用"和"启用"功能。管理员可以禁用任意用户（不能禁用自己），被禁用的用户：

- **无法登录**（登录接口返回 403）
- **已有 JWT 令牌立即失效**（所有 API 请求返回 403）
- **WebSocket 连接立即断开**（活跃流同步中止）
- **钉钉消息静默忽略**（不回复、不报错）
- **数据完整保留**（会话、工作目录均不删除，仅禁止访问）

启用后恢复正常，用户需重新登录获取令牌。

---

## 二、背景知识（后续 AI 必读）

### 2.1 项目架构

- **后端**: Express + TypeScript，入口 `server/src/index.ts`
- **前端 Web**: React + Vite，目录 `web/src/`
- **移动端**: Expo SDK 55 + React Native，目录 `mobile/src/`
- **共享包**: `shared/src/`（`@agent/shared`），Web 和 Mobile 共用的 types、hooks、lib
- **用户数据**: JSON 文件 `server/data/users.json`，内存缓存 + 文件持久化

### 2.2 核心文件清单

| 职责 | 文件路径 |
|------|---------|
| 共享用户类型 | `shared/src/types/user.ts` |
| 共享认证类型 | `shared/src/types/auth.ts` |
| 共享类型导出 | `shared/src/types/index.ts` |
| 服务端用户类型 | `server/src/data/users/types.ts` |
| 用户存储 (CRUD) | `server/src/data/users/store.ts` |
| 认证路由 | `server/src/routes/auth.ts` |
| 认证中间件 | `server/src/auth/middleware.ts` |
| JWT 类型 | `server/src/auth/types.ts` |
| WebSocket 服务器 | `server/src/channels/web/wsServer.ts` |
| Web Channel | `server/src/channels/web/channel.ts` |
| Dispatch 中间件 | `server/src/engine/dispatch.ts` |
| 钉钉预处理器 | `server/src/channels/dingtalk/pipeline/preprocessor.ts` |
| Web 用户管理入口 | `web/src/components/UserManager/index.tsx` |
| Web 用户表格 | `web/src/components/UserManager/UserTable.tsx` |
| Web 用户表单 | `web/src/components/UserManager/UserFormDialog.tsx` |
| Web 用户 hooks | `web/src/components/UserManager/hooks.ts` |
| Web 用户类型导出 | `web/src/components/UserManager/types.ts` |
| Web 认证上下文 | `web/src/contexts/AuthContext.tsx` |
| Mobile 认证上下文 | `mobile/src/contexts/AuthContext.tsx` |
| Mobile 用户列表 | `mobile/src/components/UserManager/UserList.tsx` |
| Mobile 用户表单 | `mobile/app/user-form.tsx` |
| Mobile 用户 hooks | `mobile/src/hooks/useUsers.ts` |

### 2.3 用户数据模型（当前）

```typescript
// server/src/data/users/types.ts
interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'user';
  realName?: string;
  avatar?: string;
  dingtalkStaffId?: string;
  permissions?: UserPermissions;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}
```

### 2.4 认证流程（当前）

1. **登录**: POST `/api/auth/login` → `userStore.verifyPassword()` → 签发 JWT（含 sub/username/role）
2. **中间件**: `createAuthMiddleware()` 验证 JWT 签名和过期时间 → 附加 `req.user`（JwtPayload）
3. **WebSocket**: 连接时从 query param 提取 token → `jwt.verify()` → 附加 `WsUser`
4. **钉钉**: webhook 提取 `senderId` → `userStore.findByDingtalkStaffId()` → 构建 `UserIdentity`

**关键**: 当前中间件仅校验 JWT 有效性，**不会查询 UserStore**。这意味着即使用户被删除，其 JWT 在过期前仍然有效。禁用功能需要改变这一行为。

### 2.5 重要约束

- **禁止自行重启生产服务**（详见 CLAUDE.md "生产服务保护"节）
- 修改代码后只提交，不要执行 deploy/restart
- `pnpm dev` 可用于本地开发验证
- TypeScript 严格模式，所有修改必须通过 `tsc --noEmit` 检查

---

## 三、详细设计方案

### 3.1 数据模型变更

#### 3.1.1 `shared/src/types/user.ts` — 共享接口

```typescript
// 在 UserInfo 接口中新增：
export interface UserInfo {
  // ...existing fields...
  disabled?: boolean;          // true = 已禁用（undefined/false = 正常）
  disabledAt?: string;         // 禁用时间 ISO 8601
  disabledBy?: string;         // 禁用操作者 userId
}

// 在 UpdateUserInput 接口中新增：
export interface UpdateUserInput {
  // ...existing fields...
  disabled?: boolean;          // 设为 true 禁用，false 启用
}
```

#### 3.1.2 `shared/src/types/auth.ts` — 认证用户接口

```typescript
export interface AuthUser {
  // ...existing fields...
  disabled?: boolean;          // 供前端判断（实际不会收到，因为禁用用户无法通过认证）
}
```

> **注意**: AuthUser 的 disabled 字段主要是类型完整性考虑。实际上被禁用的用户根本无法通过认证获取自己的信息。但在 `/api/auth/users` 管理员列表中需要此字段。

#### 3.1.3 `server/src/data/users/types.ts` — 服务端存储类型

```typescript
export interface UserRecord {
  // ...existing fields...
  disabled?: boolean;
  disabledAt?: string;
  disabledBy?: string;
}

// UserInfo 同步新增 disabled/disabledAt/disabledBy
```

#### 3.1.4 `server/src/data/users/store.ts` — UpdateUserInput

```typescript
export interface UpdateUserInput {
  // ...existing fields...
  disabled?: boolean;
}
```

### 3.2 UserStore 方法变更

在 `server/src/data/users/store.ts` 的 `UserStore` 类中：

#### 3.2.1 新增 `setDisabled()` 方法

```typescript
async setDisabled(id: string, disabled: boolean, operatorId: string): Promise<UserInfo> {
  const user = this.findById(id);
  if (!user) throw new Error('User not found');

  // 不能禁用自己
  if (id === operatorId) {
    throw new Error('Cannot disable yourself');
  }

  // 不能禁用最后一个活跃的 admin
  if (disabled && user.role === 'admin') {
    const activeAdminCount = this.users.filter(u => u.role === 'admin' && !u.disabled).length;
    if (activeAdminCount <= 1) {
      throw new Error('Cannot disable the last active admin');
    }
  }

  user.disabled = disabled || undefined;        // false 时清除字段
  user.disabledAt = disabled ? new Date().toISOString() : undefined;
  user.disabledBy = disabled ? operatorId : undefined;
  user.updatedAt = new Date().toISOString();
  await this.persist();

  const { passwordHash, ...info } = user;
  return info;
}
```

#### 3.2.2 修改 `update()` 方法

在 `update()` 中处理 `disabled` 字段（当通过 PATCH 传入时）：

```typescript
if (input.disabled !== undefined) {
  // 委托给 setDisabled（但 update 没有 operatorId，所以 disabled 字段只通过专用端点处理）
  // 或者：在 update 方法中直接处理
  user.disabled = input.disabled || undefined;
  if (input.disabled) {
    user.disabledAt = new Date().toISOString();
    // disabledBy 需要从路由层传入
  } else {
    user.disabledAt = undefined;
    user.disabledBy = undefined;
  }
}
```

**设计决策**: 禁用/启用操作使用独立的 API 端点 `PATCH /api/auth/users/:id/status`，而不是复用通用 PATCH 端点。原因：
1. 禁用需要额外的安全校验（不能禁用自己、最后一个 admin）
2. 禁用后需要触发连接清理（WebSocket 断开、活跃流中止）
3. 语义更清晰，审计日志更精确

#### 3.2.3 修改 `adminCount()` 方法

现有 `adminCount()` 需感知禁用状态（用于"不能删除/降级最后一个 admin"保护）：

```typescript
// 新增：统计活跃 admin 数量
activeAdminCount(): number {
  return this.users.filter(u => u.role === 'admin' && !u.disabled).length;
}
```

同时需修改 `update()` 和 `delete()` 中的 admin 保护逻辑，使用 `activeAdminCount()` 替代 `adminCount()`。

#### 3.2.4 修改 `listAll()` 方法

无需修改 —— `listAll()` 已经用 `{ passwordHash, ...rest }` 解构，新字段会自动包含在输出中。

### 3.3 认证中间件变更

#### 3.3.1 `server/src/auth/middleware.ts` — 注入禁用检查

**核心变更**: `createAuthMiddleware` 需要接收 `UserStore` 实例，在 JWT 验证通过后查询用户是否被禁用。

```typescript
export function createAuthMiddleware(jwtSecret: string, userStore?: UserStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isPublicRoute(req)) {
      next();
      return;
    }

    // ...existing token extraction and JWT verification...

    try {
      const payload = jwt.verify(token, jwtSecret) as JwtPayload;

      // 新增：查询用户禁用状态
      if (userStore) {
        const record = userStore.findById(payload.sub);
        if (!record || record.disabled) {
          res.status(403).json({ error: '账号已被禁用', code: 'USER_DISABLED' });
          return;
        }
      }

      req.user = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
```

**注意事项**:
- `userStore` 参数设为可选，保持向后兼容
- 用户不存在（被删除）也返回 403，而非 401（避免暴露用户是否存在）
- 返回特定 `code: 'USER_DISABLED'`，前端可据此显示友好提示
- `findById()` 是内存查找（O(n)，n=用户数），性能影响可忽略

**传参改造**: 需要在 `createAuthMiddleware` 的调用处（`server/src/app/runtime.ts` 或路由注册处）传入 `userStore`。

找到 `createAuthMiddleware` 的调用位置：

```bash
# 需要确认（探索阶段已确认在 runtime.ts 或 routes.ts）
```

#### 3.3.2 WebSocket 连接认证 — `server/src/channels/web/wsServer.ts`

**变更 `authenticate()` 方法**：需要接收 `UserStore`，在 JWT 验证后检查禁用状态。

```typescript
// WsServerConfig 新增
export interface WsServerConfig {
  jwtSecret?: string;
  pingIntervalMs?: number;
  userStore?: UserStore;  // 新增
}

// authenticate() 方法修改
private authenticate(request: IncomingMessage): WsUser | undefined {
  if (!this.config.jwtSecret) return undefined;
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    if (!token) return undefined;
    const decoded = jwt.verify(token, this.config.jwtSecret) as { sub: string; username: string; role: string };

    // 新增：禁用检查
    if (this.config.userStore) {
      const record = this.config.userStore.findById(decoded.sub);
      if (!record || record.disabled) return undefined;
    }

    return {
      sub: decoded.sub,
      username: decoded.username,
      role: decoded.role as 'admin' | 'user',
    };
  } catch {
    return undefined;
  }
}
```

#### 3.3.3 禁用后主动断开连接 — WsServer 新增方法

```typescript
/** 断开指定用户的所有 WS 连接（禁用用户时调用） */
disconnectUser(userId: string, reason?: string): void {
  const clients = this.clientsByUser.get(userId);
  if (!clients) return;
  const code = 4003; // Custom close code: forbidden
  const msg = reason || 'Account disabled';
  for (const client of clients) {
    client.ws.close(code, msg);
  }
  // clients 会在 ws.on('close') 回调中自动清理
}
```

### 3.4 登录端点变更

#### 3.4.1 `server/src/routes/auth.ts` — POST `/api/auth/login`

在 `verifyPassword` 成功后、签发 JWT 前，检查 disabled 状态：

```typescript
const user = await userStore.verifyPassword(username, password);
if (!user) {
  // ...existing: 记录登录失败日志...
  res.status(401).json({ error: '用户名或密码错误' });
  return;
}

// 新增：禁用检查
if (user.disabled) {
  appendLoginLog({
    timestamp: new Date().toISOString(),
    event: 'login_fail',
    username: user.username,
    userId: user.id,
    ip, userAgent, channel,
    failReason: 'account_disabled',
  }, loginLogFilePath).catch(() => {});
  res.status(403).json({ error: '账号已被禁用', code: 'USER_DISABLED' });
  return;
}

// ...existing: 签发 JWT...
```

#### 3.4.2 新增 API 端点：`PATCH /api/auth/users/:id/status`

```typescript
// PATCH /api/auth/users/:id/status (admin only)
router.patch('/users/:id/status', requireAdmin, async (req, res) => {
  try {
    const { disabled } = req.body;
    if (typeof disabled !== 'boolean') {
      res.status(400).json({ error: 'disabled 必须是布尔值' });
      return;
    }

    const user = await userStore.setDisabled(req.params.id, disabled, req.user!.sub);

    const action = disabled ? 'user_disabled' : 'user_enabled';
    auditLog(req, action, user.username);

    // 禁用时：通知 WebChannel 断开该用户连接
    if (disabled && onUserDisabled) {
      onUserDisabled(req.params.id);
    }

    res.json({ ...user, avatar: avatarUrl(user.id, user.avatar) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'User not found') {
      res.status(404).json({ error: '用户不存在' });
    } else if (msg === 'Cannot disable yourself') {
      res.status(400).json({ error: '不能禁用自己' });
    } else if (msg === 'Cannot disable the last active admin') {
      res.status(400).json({ error: '不能禁用最后一个活跃管理员' });
    } else {
      res.status(400).json({ error: msg });
    }
  }
});
```

**回调机制**: `onUserDisabled` 是一个回调函数，由 `AuthRouterDeps` 传入，用于通知 WebChannel 断开用户连接。

```typescript
// AuthRouterDeps 新增
export interface AuthRouterDeps {
  // ...existing...
  onUserDisabled?: (userId: string) => void;
}
```

#### 3.4.3 修改 GET `/api/auth/users` — 返回禁用状态

无需改动 —— `userStore.listAll()` 已自动包含新字段。但需要确认 `resolveCreatedBy` 格式化和 `disabledBy` 字段也需要解析为用户名：

```typescript
// 在 users 映射中新增 disabledBy 解析
const usersWithStats = await Promise.all(users.map(async (u) => ({
  ...u,
  disabledBy: u.disabledBy ? resolveCreatedBy(u.disabledBy) : undefined,

})));
```

#### 3.4.4 修改 GET `/api/auth/me` — 禁用检查

此端点在中间件层已被拦截（403），无需额外修改。但为了前端启动时的预加载逻辑，需确保 403 被正确传播。

### 3.5 钉钉渠道变更

#### 3.5.1 `server/src/channels/dingtalk/pipeline/preprocessor.ts`

在 `prepare()` 方法中，用户解析后检查 disabled 状态：

```typescript
let user: UserIdentity | undefined;
if (this.userStore && source.senderId) {
  const record = this.userStore.findByDingtalkStaffId(source.senderId);
  if (record) {
    // 新增：如果用户被禁用，不构建 user identity（等同于未关联用户）
    if (record.disabled) {
      return null;  // 返回 null 表示消息应被忽略
    }
    user = { /* ...existing... */ };
  }
}
```

**设计变更**: `prepare()` 返回类型从 `PreparedDingtalkMessage` 改为 `PreparedDingtalkMessage | null`。返回 null 时 `processMessage()` 直接静默返回。

需要同步修改 `processMessage()` 调用处：

```typescript
// DingtalkChannel.processMessage()
async processMessage(ctx: DingtalkMessageContext, robotId?: string): Promise<void> {
  // ...existing reset/model command checks...

  prepared = await this.preprocessor.prepare(ctx, robotId);
  if (!prepared) {
    // 用户被禁用或其他原因，静默忽略
    return;
  }

  // ...existing dispatch logic...
}
```

### 3.6 WebChannel 连接清理

#### 3.6.1 `server/src/channels/web/channel.ts` — 新增 `disconnectUser()` 方法

```typescript
/** 禁用用户时调用：断开 WS 连接 + 中止活跃流 */
disconnectUser(userId: string): void {
  // 1. 中止所有活跃的 Agent 流
  for (const [streamId, entry] of this.activeStreams) {
    if (entry.userId === userId) {
      entry.controller.abort();
      chatLogger.info(`Aborted stream ${streamId} for disabled user ${userId}`);
    }
  }

  // 2. 断开 WS 连接
  this.wsServer?.disconnectUser(userId, 'Account disabled');
}
```

此方法由 `authRouter` 的 `onUserDisabled` 回调触发。

### 3.7 前端变更 — Web

#### 3.7.1 `web/src/components/UserManager/UserTable.tsx` — 表格展示

需要的变更：
1. **状态列**: 在"角色"列旁显示禁用状态（Badge）
2. **禁用/启用按钮**: 在操作列添加禁用/启用按钮
3. **视觉区分**: 被禁用的用户行降低不透明度

```tsx
// 新增 props
interface UserTableProps {
  // ...existing...
  onToggleDisabled: (user: UserInfo) => void;  // 新增
}

// 表格行中：
<TableRow key={user.id} className={user.disabled ? "opacity-50" : ""}>
  {/* ...用户名列... */}
  <TableCell>
    <div className="flex items-center gap-1.5">
      <Badge variant={user.role === "admin" ? "default" : "secondary"}>
        {user.role === "admin" ? "管理员" : "用户"}
      </Badge>
      {user.disabled && (
        <Badge variant="outline" className="text-destructive border-destructive">
          已禁用
        </Badge>
      )}
    </div>
  </TableCell>
  {/* ...操作列中新增... */}
  {user.id !== currentUserId && (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => onToggleDisabled(user)}
      title={user.disabled ? "启用" : "禁用"}
    >
      {user.disabled ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
    </Button>
  )}
</TableRow>
```

引入 `lucide-react` 的 `UserCheck` 和 `UserX` 图标。

#### 3.7.2 `web/src/components/UserManager/hooks.ts` — 新增 API 调用

```typescript
const toggleUserDisabled = async (id: string, disabled: boolean) => {
  const res = await authFetch(`${API_BASE}/users/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "操作失败");
  }
  await refresh();
};

// 在 return 中新增 toggleUserDisabled
return { users, loading, error, refresh, createUser, updateUser, deleteUser, toggleUserDisabled };
```

#### 3.7.3 `web/src/components/UserManager/index.tsx` — 禁用确认弹窗

在 UserManager 组件中新增禁用/启用的确认交互：

```tsx
// 新增状态
const [disableTarget, setDisableTarget] = useState<UserInfo | null>(null);

// 处理禁用/启用
const handleToggleDisabled = async () => {
  if (!disableTarget) return;
  try {
    await toggleUserDisabled(disableTarget.id, !disableTarget.disabled);
    setDisableTarget(null);
  } catch (err) {
    // 显示错误
  }
};

// 传递给 UserTable
<UserTable onToggleDisabled={(user) => setDisableTarget(user)} ... />

// 确认弹窗（使用 AlertDialog 或复用 DeleteUserDialog 模式）
// 禁用时：标题"禁用用户"，描述"禁用后，xxx 将无法登录和使用所有功能。确定继续？"
// 启用时：直接执行，无需确认（或轻量确认）
```

#### 3.7.4 `web/src/contexts/AuthContext.tsx` — 处理 403 USER_DISABLED

当前 `setOnUnauthorized` 仅处理 401。需要在 `authFetch` 层面处理 403 + `code: 'USER_DISABLED'`：

**方案**: 在 `shared/src/lib/authFetch.ts` 中扩展，当收到 403 且 code 为 `USER_DISABLED` 时，触发与 401 相同的 logout 流程。

或者更简单：在 Web 的 `AuthContext` 中，让 `setOnUnauthorized` 同时覆盖 403 USER_DISABLED 响应。

需要查看 `authFetch` 的实现来确定最佳方案。实际上，中间件对已禁用用户返回 403，`authFetch` 中已有 `onUnauthorized` 回调处理 401。最简洁的方案是：

```typescript
// shared/src/lib/authFetch.ts 中
// 将 403 + USER_DISABLED 也视为未授权
if (response.status === 401 || response.status === 403) {
  // 尝试解析 body 检查 code
  const clone = response.clone();
  try {
    const body = await clone.json();
    if (response.status === 401 || body.code === 'USER_DISABLED') {
      onUnauthorizedCallback?.();
    }
  } catch {
    if (response.status === 401) {
      onUnauthorizedCallback?.();
    }
  }
}
```

**更简洁的方案**: 直接让禁用用户返回 401（而非 403），错误消息区分即可。这样无需修改 authFetch。但语义上 403 更准确（认证成功但被禁止）。

**最终决策**: 保持 403 返回码，在 `authFetch` 中增加对 403 的处理。

### 3.8 前端变更 — Mobile

#### 3.8.1 `mobile/src/hooks/useUsers.ts` — 新增 API 调用

```typescript
const toggleUserDisabled = useCallback(async (id: string, disabled: boolean) => {
  const res = await authFetch(`/api/auth/users/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || 'Failed to toggle user status');
  }
  await refresh();
}, [refresh]);

return { users, loading, error, refresh, createUser, updateUser, deleteUser, toggleUserDisabled };
```

#### 3.8.2 `mobile/src/components/UserManager/UserList.tsx` — 列表展示

1. **视觉区分**: 禁用用户行降低不透明度
2. **状态标签**: 在角色 Badge 旁显示"已禁用"
3. **滑动操作**: 新增禁用/启用滑动按钮

```tsx
// Props 新增
interface Props {
  // ...existing...
  onToggleDisabled: (id: string, disabled: boolean) => Promise<void>;
}

// renderItem 中：
// 1. 行不透明度
<Pressable style={[styles.row, item.disabled && { opacity: 0.5 }, pressed && styles.rowPressed]}>

// 2. 角色旁显示状态
{item.disabled && (
  <View style={[styles.roleBadge, { backgroundColor: colors.destructive + '20' }]}>
    <Text style={[styles.roleText, { color: colors.destructive }]}>已禁用</Text>
  </View>
)}

// 3. 滑动操作新增
const actions: SwipeAction[] = [
  {
    key: 'edit',
    label: '编辑',
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    onPress: () => onEdit(item),
  },
  // 新增禁用/启用
  ...(!isSelf ? [{
    key: 'toggle',
    label: item.disabled ? '启用' : '禁用',
    backgroundColor: item.disabled ? '#22c55e' : '#f97316',
    color: '#fff',
    onPress: () => {
      if (item.disabled) {
        void onToggleDisabled(item.id, false);
      } else {
        Alert.alert('禁用用户', `确定要禁用用户 "${item.username}" 吗？`, [
          { text: '取消', style: 'cancel' },
          { text: '禁用', style: 'destructive', onPress: () => void onToggleDisabled(item.id, true) },
        ]);
      }
    },
  }] : []),
  // ...existing delete action...
];
```

#### 3.8.3 Mobile 认证处理

与 Web 相同，需要在 `authFetch` 中处理 403 USER_DISABLED 响应，触发 logout。

### 3.9 authFetch 共享层变更

#### 3.9.1 `shared/src/lib/authFetch.ts` — 统一处理 403 USER_DISABLED

需要先阅读此文件的当前实现（探索阶段已确认其结构），然后在响应拦截逻辑中增加：

```typescript
// 现有逻辑：401 → onUnauthorizedCallback?.()
// 新增：403 且 code=USER_DISABLED → 同样触发 onUnauthorizedCallback
if (response.status === 403) {
  try {
    const cloned = response.clone();
    const body = await cloned.json();
    if (body.code === 'USER_DISABLED') {
      onUnauthorizedCallback?.();
    }
  } catch { /* ignore parse errors */ }
}
```

### 3.10 LoginLog 类型扩展

#### 3.10.1 `server/src/data/login-logs/index.ts`

`LoginEvent` 类型可能需要新增 `user_disabled` 和 `user_enabled` 事件类型（如果尚未通过 `auditLog` 覆盖）。

检查 `auditLog` 函数签名 — 它接受任意 `event: string`，所以只需在调用处使用新事件名即可。

---

## 四、实施步骤（分阶段 Checklist）

### 阶段 1：数据模型与存储层

- [ ] **1.1** 修改 `shared/src/types/user.ts` — UserInfo 新增 `disabled?`, `disabledAt?`, `disabledBy?` 字段
- [ ] **1.2** 修改 `shared/src/types/user.ts` — UpdateUserInput 新增 `disabled?` 字段
- [ ] **1.3** 修改 `server/src/data/users/types.ts` — UserRecord 新增 `disabled?`, `disabledAt?`, `disabledBy?` 字段
- [ ] **1.4** 修改 `server/src/data/users/types.ts` — 服务端 UserInfo 新增 `disabled?`, `disabledAt?`, `disabledBy?` 字段
- [ ] **1.5** 修改 `server/src/data/users/store.ts` — UpdateUserInput 新增 `disabled?` 字段
- [ ] **1.6** 修改 `server/src/data/users/store.ts` — 新增 `setDisabled()` 方法
- [ ] **1.7** 修改 `server/src/data/users/store.ts` — 新增 `activeAdminCount()` 方法
- [ ] **1.8** 修改 `server/src/data/users/store.ts` — `update()` 和 `delete()` 中的 admin 保护改用 `activeAdminCount()`
- [ ] **1.9** TypeScript 编译检查：`cd server && npx tsc --noEmit`

### 阶段 2：认证层（中间件 + 登录 + WebSocket）

- [ ] **2.1** 修改 `server/src/auth/middleware.ts` — `createAuthMiddleware` 接收 `UserStore`，JWT 验证后检查 disabled
- [ ] **2.2** 找到 `createAuthMiddleware` 的调用处，传入 `userStore` 实例
- [ ] **2.3** 修改 `server/src/channels/web/wsServer.ts` — `WsServerConfig` 新增 `userStore`，`authenticate()` 中检查 disabled
- [ ] **2.4** 修改 `server/src/channels/web/wsServer.ts` — 新增 `disconnectUser()` 方法
- [ ] **2.5** 找到 `WsServer` 构造处，传入 `userStore` 实例
- [ ] **2.6** 修改 `server/src/routes/auth.ts` — 登录端点增加 disabled 检查，记录 `account_disabled` 失败原因
- [ ] **2.7** TypeScript 编译检查

### 阶段 3：禁用/启用 API 端点 + 连接清理

- [ ] **3.1** 修改 `server/src/routes/auth.ts` — `AuthRouterDeps` 新增 `onUserDisabled?` 回调
- [ ] **3.2** 修改 `server/src/routes/auth.ts` — 新增 `PATCH /users/:id/status` 端点
- [ ] **3.3** 修改 `server/src/routes/auth.ts` — GET `/users` 中 `disabledBy` 解析为用户名
- [ ] **3.4** 修改 `server/src/channels/web/channel.ts` — 新增 `disconnectUser()` 方法
- [ ] **3.5** 在 channel/router 注册处将 `webChannel.disconnectUser` 作为 `onUserDisabled` 回调传入 authRouter
- [ ] **3.6** TypeScript 编译检查

### 阶段 4：钉钉渠道

- [ ] **4.1** 修改 `server/src/channels/dingtalk/pipeline/preprocessor.ts` — `prepare()` 返回 null 表示用户被禁用
- [ ] **4.2** 修改 `server/src/channels/dingtalk/pipeline/types.ts` — 如需调整返回类型
- [ ] **4.3** 修改 `server/src/channels/dingtalk/channel.ts` — `processMessage()` 处理 null 返回值
- [ ] **4.4** TypeScript 编译检查

### 阶段 5：共享 authFetch 层

- [ ] **5.1** 阅读 `shared/src/lib/authFetch.ts` 当前实现
- [ ] **5.2** 修改 `shared/src/lib/authFetch.ts` — 403 + USER_DISABLED 时触发 onUnauthorized 回调
- [ ] **5.3** TypeScript 编译检查：`cd shared && npx tsc --noEmit`

### 阶段 6：Web 前端

- [ ] **6.1** 修改 `web/src/components/UserManager/hooks.ts` — 新增 `toggleUserDisabled` 方法
- [ ] **6.2** 修改 `web/src/components/UserManager/UserTable.tsx` — 显示禁用状态 + 操作按钮
- [ ] **6.3** 修改 `web/src/components/UserManager/index.tsx` — 禁用确认弹窗 + 调用 toggleUserDisabled
- [ ] **6.4** TypeScript 编译检查：`cd web && npx tsc --noEmit`

### 阶段 7：Mobile 端

- [ ] **7.1** 修改 `mobile/src/hooks/useUsers.ts` — 新增 `toggleUserDisabled` 方法
- [ ] **7.2** 修改 `mobile/src/components/UserManager/UserList.tsx` — 显示禁用状态 + 滑动操作
- [ ] **7.3** 修改 `mobile/src/components/UserManager/index.tsx` — 传递 onToggleDisabled prop
- [ ] **7.4** TypeScript 编译检查：`cd mobile && npx tsc --noEmit`

### 阶段 8：全局验证与收尾

- [ ] **8.1** 全局 TypeScript 编译检查（根目录 `pnpm typecheck` 或各子项目分别检查）
- [ ] **8.2** 本地启动 `pnpm dev` 验证以下场景：
  - 管理员禁用普通用户 → 用户立即被踢出
  - 禁用后用户尝试登录 → 提示"账号已被禁用"
  - 禁用后用户已有 token 调用 API → 返回 403
  - 管理员启用用户 → 用户可正常登录
  - 不能禁用自己
  - 不能禁用最后一个活跃管理员
  - 用户列表正确显示禁用状态
- [ ] **8.3** 提交代码（不要重启生产服务）

---

## 五、关键代码变更详表

### 5.1 `shared/src/types/user.ts`

```diff
 export interface UserInfo {
   id: string;
   username: string;
   role: 'admin' | 'user';
   realName?: string;
   avatar?: string;
   createdAt: string;
   createdBy: string;
   updatedAt: string;
   dingtalkStaffId?: string;
   permissions?: UserPermissions;
 +  disabled?: boolean;
+  disabledAt?: string;
+  disabledBy?: string;
 }

 export interface UpdateUserInput {
   password?: string;
   role?: 'admin' | 'user';
   realName?: string;
   dingtalkStaffId?: string;
   permissions?: UserPermissions;
 +  disabled?: boolean;
 }
```

### 5.2 `server/src/data/users/types.ts`

```diff
 export interface UserRecord {
   id: string;
   username: string;
   passwordHash: string;
   role: UserRole;
   realName?: string;
   avatar?: string;
   dingtalkStaffId?: string;
   permissions?: UserPermissions;
    createdAt: string;
   createdBy: string;
   updatedAt: string;
+  disabled?: boolean;
+  disabledAt?: string;
+  disabledBy?: string;
 }

 export interface UserInfo {
   id: string;
   username: string;
   role: UserRole;
   realName?: string;
   avatar?: string;
   dingtalkStaffId?: string;
   permissions?: UserPermissions;
    createdAt: string;
   createdBy: string;
   updatedAt: string;
+  disabled?: boolean;
+  disabledAt?: string;
+  disabledBy?: string;
 }
```

### 5.3 `server/src/data/users/store.ts`

```diff
 export interface UpdateUserInput {
   password?: string;
   role?: UserRole;
   realName?: string;
   avatar?: string;
   dingtalkStaffId?: string;
   permissions?: UserPermissions;
 +  disabled?: boolean;
 }

 export class UserStore {
   // ...existing...

+  activeAdminCount(): number {
+    return this.users.filter(u => u.role === 'admin' && !u.disabled).length;
+  }
+
+  async setDisabled(id: string, disabled: boolean, operatorId: string): Promise<UserInfo> {
+    const user = this.findById(id);
+    if (!user) throw new Error('User not found');
+    if (id === operatorId) throw new Error('Cannot disable yourself');
+    if (disabled && user.role === 'admin' && this.activeAdminCount() <= 1) {
+      throw new Error('Cannot disable the last active admin');
+    }
+    user.disabled = disabled || undefined;
+    user.disabledAt = disabled ? new Date().toISOString() : undefined;
+    user.disabledBy = disabled ? operatorId : undefined;
+    user.updatedAt = new Date().toISOString();
+    await this.persist();
+    const { passwordHash, ...info } = user;
+    return info;
+  }

   async update(id: string, input: UpdateUserInput): Promise<UserInfo> {
     const user = this.findById(id);
     if (!user) throw new Error('User not found');
-    if (input.role && input.role !== 'admin' && user.role === 'admin' && this.adminCount() <= 1) {
+    if (input.role && input.role !== 'admin' && user.role === 'admin' && this.activeAdminCount() <= 1) {
       throw new Error('Cannot change role of the last admin');
     }
     // ...rest unchanged...
   }

   async delete(id: string): Promise<void> {
     const user = this.findById(id);
     if (!user) throw new Error('User not found');
-    if (user.role === 'admin' && this.adminCount() <= 1) {
+    if (user.role === 'admin' && this.activeAdminCount() <= 1) {
       throw new Error('Cannot delete the last admin');
     }
     // ...rest unchanged...
   }
 }
```

### 5.4 `server/src/auth/middleware.ts`

```diff
+import type { UserStore } from '../data/users/store.js';

-export function createAuthMiddleware(jwtSecret: string) {
+export function createAuthMiddleware(jwtSecret: string, userStore?: UserStore) {
   return (req: Request, res: Response, next: NextFunction): void => {
     if (isPublicRoute(req)) {
       next();
       return;
     }
     // ...existing token extraction...
     try {
       const payload = jwt.verify(token, jwtSecret) as JwtPayload;
+      if (userStore) {
+        const record = userStore.findById(payload.sub);
+        if (!record || record.disabled) {
+          res.status(403).json({ error: '账号已被禁用', code: 'USER_DISABLED' });
+          return;
+        }
+      }
       req.user = payload;
       next();
     } catch {
       res.status(401).json({ error: 'Invalid or expired token' });
     }
   };
 }
```

### 5.5 `server/src/channels/web/wsServer.ts`

```diff
+import type { UserStore } from '../../data/users/store.js';

 export interface WsServerConfig {
   jwtSecret?: string;
   pingIntervalMs?: number;
+  userStore?: UserStore;
 }

 export class WsServer {
   // ...existing...

+  disconnectUser(userId: string, reason?: string): void {
+    const clients = this.clientsByUser.get(userId);
+    if (!clients) return;
+    for (const client of clients) {
+      client.ws.close(4003, reason || 'Account disabled');
+    }
+  }

   private authenticate(request: IncomingMessage): WsUser | undefined {
     if (!this.config.jwtSecret) return undefined;
     try {
       // ...existing token extraction and JWT verify...
       const decoded = jwt.verify(token, this.config.jwtSecret) as { sub: string; username: string; role: string };
+      if (this.config.userStore) {
+        const record = this.config.userStore.findById(decoded.sub);
+        if (!record || record.disabled) return undefined;
+      }
       return { sub: decoded.sub, username: decoded.username, role: decoded.role as 'admin' | 'user' };
     } catch { return undefined; }
   }
 }
```

### 5.6 `server/src/routes/auth.ts` — 登录 + 新端点

```diff
 // POST /api/auth/login
 const user = await userStore.verifyPassword(username, password);
 if (!user) {
   // ...existing...
 }
+if (user.disabled) {
+  appendLoginLog({
+    timestamp: new Date().toISOString(),
+    event: 'login_fail',
+    username: user.username, userId: user.id,
+    ip, userAgent, channel,
+    failReason: 'account_disabled',
+  }, loginLogFilePath).catch(() => {});
+  res.status(403).json({ error: '账号已被禁用', code: 'USER_DISABLED' });
+  return;
+}

 // AuthRouterDeps 新增
 export interface AuthRouterDeps {
   // ...existing...
+  onUserDisabled?: (userId: string) => void;
 }

+// PATCH /api/auth/users/:id/status (admin only)
+router.patch('/users/:id/status', requireAdmin, async (req, res) => {
+  try {
+    const { disabled } = req.body;
+    if (typeof disabled !== 'boolean') {
+      res.status(400).json({ error: 'disabled 必须是布尔值' });
+      return;
+    }
+    const user = await userStore.setDisabled(req.params.id, disabled, req.user!.sub);
+    auditLog(req, disabled ? 'user_disabled' : 'user_enabled', user.username);
+    if (disabled && deps.onUserDisabled) {
+      deps.onUserDisabled(req.params.id);
+    }
+    res.json({ ...user, avatar: avatarUrl(user.id, user.avatar) });
+  } catch (err: unknown) {
+    const msg = err instanceof Error ? err.message : String(err);
+    if (msg === 'User not found') {
+      res.status(404).json({ error: '用户不存在' });
+    } else if (msg === 'Cannot disable yourself') {
+      res.status(400).json({ error: '不能禁用自己' });
+    } else if (msg === 'Cannot disable the last active admin') {
+      res.status(400).json({ error: '不能禁用最后一个活跃管理员' });
+    } else {
+      res.status(400).json({ error: msg });
+    }
+  }
+});

 // GET /api/auth/users — disabledBy 解析
 const usersWithStats = await Promise.all(users.map(async (u) => ({
   ...u,
+  disabledBy: u.disabledBy ? resolveCreatedBy(u.disabledBy) : undefined,

 })));
```

### 5.7 钉钉预处理器

```diff
 // preprocessor.ts — prepare() 方法
 if (this.userStore && source.senderId) {
   const record = this.userStore.findByDingtalkStaffId(source.senderId);
   if (record) {
+    if (record.disabled) {
+      return null;
+    }
     user = { /* ...existing... */ };
   }
 }

 // 返回类型
-async prepare(...): Promise<PreparedDingtalkMessage> {
+async prepare(...): Promise<PreparedDingtalkMessage | null> {

 // channel.ts — processMessage()
 prepared = await this.preprocessor.prepare(ctx, robotId);
+if (!prepared) return;
```

### 5.8 Web 前端关键变更

```diff
 // UserTable.tsx — 新增 import
+import { UserCheck, UserX } from "lucide-react";

 // UserTable.tsx — props
 interface UserTableProps {
   // ...existing...
+  onToggleDisabled: (user: UserInfo) => void;
 }

 // UserTable.tsx — 行样式
-<TableRow key={user.id}>
+<TableRow key={user.id} className={user.disabled ? "opacity-50" : ""}>

 // UserTable.tsx — 角色列
 <Badge variant={user.role === "admin" ? "default" : "secondary"}>
   {user.role === "admin" ? "管理员" : "用户"}
 </Badge>
+{user.disabled && (
+  <Badge variant="outline" className="text-destructive border-destructive/50">
+    已禁用
+  </Badge>
+)}

 // UserTable.tsx — 操作列（在编辑和删除按钮之间）
+{user.id !== currentUserId && (
+  <Button
+    variant="ghost"
+    size="icon"
+    className={`h-8 w-8 ${user.disabled ? "text-green-600 hover:text-green-700" : "text-muted-foreground hover:text-orange-600"}`}
+    onClick={() => onToggleDisabled(user)}
+    title={user.disabled ? "启用" : "禁用"}
+  >
+    {user.disabled ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
+  </Button>
+)}
```

---

## 六、精确调用链（已确认）

### 6.1 `createAuthMiddleware` 调用处

**文件**: `server/src/app/runtime.ts` 约 210-216 行

```typescript
if (config.auth?.enabled && config.auth.jwtSecret) {
  const usersFilePath = resolve(processCwd, config.auth.usersFile || './data/users.json');
  userStore = new UserStore(usersFilePath);
  authMiddleware = createAuthMiddleware(config.auth.jwtSecret);  // ← 此处传入 userStore
  serverLogger.info('Auth enabled');
}
```

**改造**: `createAuthMiddleware(config.auth.jwtSecret, userStore)`

### 6.2 `createAuthRouter` 调用处

**文件**: `server/src/app/routes.ts` 约 89-96 行

```typescript
app.use('/api/auth', createAuthRouter({
  userStore: runtime.userStore,
  jwtSecret: config.auth.jwtSecret,
  tokenExpiresIn: config.auth.tokenExpiresIn || '30d',
  avatarsDir,
  loginLogFilePath,
  agentCwd,
  // ← 此处新增 onUserDisabled 回调
}));
```

**改造**: 在 routes.ts 中，通过 `channelManager.getChannel<WebChannel>('web')` 获取 webChannel 实例，构建回调：

```typescript
const webChannel = channelManager.getChannel<WebChannel>('web');
// ...
app.use('/api/auth', createAuthRouter({
  // ...existing deps...
  onUserDisabled: webChannel
    ? (userId: string) => webChannel.disconnectUser(userId)
    : undefined,
}));
```

**前置条件**: routes.ts 中已有类似模式（第 45 行获取 webChannel 用于 broadcastToUser），可复用同一引用。

### 6.3 `new WsServer` 构造处

**文件**: `server/src/channels/web/channel.ts` 的 `start()` 方法中（约 154 行）

```typescript
this.wsServer = new WsServer({
  jwtSecret: this.config.jwtSecret,
  // ← 此处新增 userStore
});
```

**改造**: WebChannelConfig 已有 `userStore?: UserStore`（用于 findById），直接转发：

```typescript
this.wsServer = new WsServer({
  jwtSecret: this.config.jwtSecret,
  userStore: this.userStore,  // this.userStore 已在构造函数中赋值
});
```

### 6.4 `authFetch` 的 401 处理

**文件**: `shared/src/lib/authFetch.ts`

当前实现（关键部分）：

```typescript
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // ...token injection, URL normalization...
  const response = await fetch(url, { ...init, headers });
  if (response.status === 401) {
    onUnauthorized?.();
  }
  return response;
}
```

**改造**: 在 `response.status === 401` 判断后，增加 403 + USER_DISABLED 处理：

```typescript
if (response.status === 401) {
  onUnauthorized?.();
} else if (response.status === 403) {
  try {
    const cloned = response.clone();
    const body = await cloned.json();
    if (body.code === 'USER_DISABLED') {
      onUnauthorized?.();
    }
  } catch { /* ignore parse errors */ }
}
```

### 6.5 WebChannel 实例可达性

**已确认**: `routes.ts` 中已有 `channelManager.getChannel<WebChannel>('web')` 模式（第 45 行），用于 `broadcastToUser`。`onUserDisabled` 回调可在同一位置构建。WebChannel 需新增 `disconnectUser()` 公开方法。

---

## 七、边界条件与注意事项

1. **向后兼容**: `disabled` 字段使用可选类型（`disabled?: boolean`），旧数据中不存在该字段等同于 `false`（正常状态）。无需数据迁移。

2. **并发安全**: `setDisabled()` 是 async 方法（涉及文件写入），但 UserStore 是单实例内存操作，写入时序由 Node.js 事件循环保证。无并发风险。

3. **JWT 令牌不可撤销**: JWT 本身没有黑名单机制。禁用生效依赖中间件每次请求查询 UserStore。这是有意设计 — 避免引入 Redis 等额外依赖。

4. **WS 关闭码**: 使用 `4003` 作为自定义关闭码（WebSocket 标准允许 4000-4999 用于应用自定义）。前端收到此关闭码时应触发 logout 流程。

5. **钉钉静默忽略**: 被禁用用户的钉钉消息不回复任何内容。这是最安全的做法 — 避免泄露系统信息。

6. **禁用 admin 保护**: 使用 `activeAdminCount()` 而非 `adminCount()`。只有活跃（未禁用）的 admin 才计入保护阈值。这意味着：如果有 2 个 admin，禁用其中一个后，剩下的 admin 不能被禁用也不能被降级。

7. **启用操作**: 启用用户不需要特殊的连接处理。用户需重新登录获取新 JWT。

8. **禁用后的定时任务**: 如果被禁用用户有活跃的 cron job，这些任务理论上仍会执行（cron 系统有自己的调度逻辑）。如果需要处理，可以在 dispatch 中间件中增加检查 — 但这是 P2 优先级，不在本次实施范围内。可以在后续迭代中处理。

---

## 八、测试验证清单

### 功能测试

| # | 场景 | 预期结果 |
|---|------|---------|
| T1 | 管理员在用户列表中禁用普通用户 | 用户状态变为"已禁用"，行变灰 |
| T2 | 被禁用用户尝试 Web 登录 | 提示"账号已被禁用"，无法登录 |
| T3 | 被禁用用户尝试 Mobile 登录 | 同上 |
| T4 | 被禁用用户已有 JWT 调用 API | 返回 403，前端自动 logout |
| T5 | 被禁用用户的 WS 连接 | 立即断开（close code 4003） |
| T6 | 被禁用用户通过钉钉发消息 | 消息被静默忽略 |
| T7 | 管理员启用已禁用用户 | 用户状态恢复，可重新登录 |
| T8 | 管理员尝试禁用自己 | 提示"不能禁用自己" |
| T9 | 尝试禁用最后一个活跃 admin | 提示"不能禁用最后一个活跃管理员" |
| T10 | 禁用后用户数据完整性 | 会话、工作目录均保留，启用后可正常访问 |
| T11 | 禁用用户时有活跃 Agent 流 | 流立即中止 |

### 回归测试

| # | 场景 | 预期结果 |
|---|------|---------|
| R1 | 正常用户登录和使用 | 无影响 |
| R2 | 管理员 CRUD 用户 | 无影响 |
| R3 | WebSocket 重连 | 无影响 |
| R4 | 钉钉正常消息处理 | 无影响 |
| R5 | 删除用户 | admin 保护逻辑（activeAdminCount）正常 |
| R6 | 修改用户角色 | admin 保护逻辑正常 |

---

## 九、AI 接力规则

1. **每轮开头**: 阅读此文档，定位当前进度（已完成的 checklist 项）
2. **每完成一个小阶段**: 更新对应 checklist 项为 `[x]`
3. **每个阶段结束**: 运行 TypeScript 编译检查，确保无类型错误
4. **遇到问题**: 在本文档末尾的"实施日志"节追加记录，方便下一轮 AI 了解上下文
5. **禁止**: 重启生产服务、删除用户数据、修改不相关的代码
6. **提交策略**: 每完成一个阶段可以提交一次（如果用户要求），使用有意义的 commit message

---

## 十、实施日志

> 后续 AI 在每轮实施中记录重要发现、决策变更、遇到的问题。

_（待实施时填写）_
