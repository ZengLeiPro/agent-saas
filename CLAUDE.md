# KY Agent

## 项目概述

开沿科技即将上线的企业通用 Agent SaaS，支持 Web 前端、React Native 移动端和钉钉机器人三种交互方式。技术栈：Express + TypeScript、React + Vite（前端）、Expo SDK 55 + React Native（移动端）、Node.js 22+ / tsx。

## 目录结构

- `config.json` - 后端服务配置（API 密钥、端口、Agent 参数）
- `~/workspace/` - Agent 工作根目录（`agent.cwd`，独立于项目目录）
- `workspace-shared/` - 共享资源中心（.ky-agent/settings.json、.ky-agent/skills-pool/、.ky-agent/scripts/），位于项目目录内，通过 `agent.sharedDir` 配置
- `~/workspace/{tenantId}/{userId}/` - 用户专属工作目录（per-user 隔离，首次请求自动创建；包含 .ky-agent runtime namespace、memory、uploads）
- `server/` - Express 后端
- `web/` - React 前端
- `mobile/` - React Native 移动端（Expo SDK 55 + expo-router）
- `shared/` - 跨平台共享包（`@agent/shared`），web 和 mobile 共用的 types、hooks、lib

## Per-User Workspace 隔离

每个用户拥有 `~/workspace/{username}/` 独立目录，由 `resolver.ts` 的 `ensureUserWorkspace()` 幂等初始化：创建目录结构 → 复制 skills → symlink scripts → 创建空 MEMORY.md。用户目录不包含任何配置文件（settings.json 等均在 `workspace-shared/` 统一管理）。

## Git 操作规范（重要）

**禁止擅自执行 `git push`。** push 会触发 CI/CD 自动部署，影响线上环境。只有在人工明确要求「push」「推送」时才可执行。同理，创建 PR、发布 release 等影响远程仓库的操作也需人工明确授权。

允许自主执行的 Git 操作：`git add`、`git commit`、`git status`、`git diff`、`git log` 等纯本地操作。

## 前端布局

断点 `767px`，`useIsMobile.ts` 判断。PC 渲染 `DesktopLayout`，移动端渲染 `MobileLayout`，共享 `useChatAppState`。
- **PC 独有**: `DesktopLayout.tsx`（右侧 header + tab）、`DesktopSessionSidebar.tsx`（左侧栏始终显示会话列表）
- **移动端独有**: `MobileLayout.tsx`（顶部 header + SwipeDrawer）、`MobileSessionList.tsx`（抽屉内 tabs + 左滑删除）
- **共享**: `ChatTabContent.tsx`、`ChatInput.tsx`、`MessageList.tsx`/`MessageItem.tsx`、`CronManager/`、`UserManager/`
侧边栏和 header 两端独立，聊天区域共享。需某端特殊行为时在共享组件内用 `useIsMobile()` 判断。

## 钉钉机器人

`config.json` 中 `dingtalk.robots` 配置多机器人。Webhook 地址：`POST /api/dingtalk/webhook/:robotId`。消息按 `conversationId` 路由到独立会话。

## 定时任务

`config.json` 中 `cron.enabled` + `cron.store` 启用。调度类型：`every`（间隔）、`cron`（表达式）、`at`（一次性）。API 前缀 `/api/cron/`。默认超时 1800s。
