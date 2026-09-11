# 独立 worktree 本地开发

新建 worktree 后，不要直接执行 `pnpm dev`。应使用统一入口初始化与启动：

```bash
pnpm local:dev
```

该命令会幂等完成以下工作：

- 缺少依赖时执行 `pnpm install --frozen-lockfile`；
- 优先复用主 checkout 的本地 `config.json`，生成当前 worktree 独立且被 Git 忽略的 `config.json.local-worktree`；
- 启动共享的 `local-postgres` 容器，为当前 worktree 创建独立数据库；
- 使用统一的非超级管理员 PostgreSQL 写入账号，满足治理与 RunStore 启动门禁；
- 启用本地鉴权、关闭 Cron，避免多个 worktree 重复执行定时任务；
- 幂等创建或校准平台管理员 `admin`（默认密码 `admin123`）；
- 使用生成的配置启动后端与 Web。

只初始化、不启动服务：

```bash
pnpm local:setup
```

主 checkout 没有可复用配置时，命令会回退到 `config.example.json` 并给出警告。此时页面与治理接口可以测试，但模型调用仍需补充真实模型配置。也可以显式指定源配置：

```bash
pnpm local:setup -- --source-config /absolute/path/to/config.json
```

本地开发默认地址为 <http://localhost:5174>，后端为 <http://localhost:3200>。同一时间只能有一个使用默认端口的 worktree 运行；切换前请先停止另一个 worktree 的 `pnpm local:dev`。
