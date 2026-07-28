# Runtime 来源与同步

- 上游仓库：`https://github.com/ZengLeiPro/wain-invoice`
- 当前 runtime 基线：`1bd7f1b9bc42098ec1a8d0a46206a2f36a1ad107`
- 同步日期：2026-07-28

该基线已把施耐德执行后端从 Windows Selenium IE 切换为 HTTP 验证码会话
+ Playwright Chromium，整个流程在 Agent SaaS 的 ACS Linux Sandbox 中运行。

`runtime/` 是为了让 agent-saas 技能随 workspace 物化后可以直接运行而复制的确定性代码快照。权威技能入口、安全门禁和平台运行边界仍在本目录的 `SKILL.md` 与 `scripts/wain_invoice.py`。

上游发票流程更新后，按以下范围同步：

- `core/`
- `clients/schneider/`
- `adapters/t100/`
- `adapters/share_drive/`
- `mocks/t100/schneider_pending_invoices.json`
- `entrypoint.py`
- `tests/`

同步后保留本技能的 ACS 适配：

- `runtime/core/skill.py`：Playwright 在非施耐德通用浏览器分支内懒加载，避免施耐德查询/预检被无关浏览器依赖阻断；客户流程的结构化结果必须原样返回给 wrapper。
- `runtime/clients/schneider/flow.py`：所有终态返回结构化 outcome；空待办必须返回 `no_pending_data`，成功预检必须返回 `preflight_passed`，禁止用裸 `return` 表示终态。
- `runtime/core/audit.py`：未显式传输出目录时落当前 workspace 的 `assets/yyyymmdd/`，不使用开发机 `~/code/` 路径。
- `runtime/clients/schneider/config.yaml`：使用客户 2026-07-28 提供的两个公网只读映射，环境变量仍可覆盖。
- `scripts/wain_invoice.py`：只依据 runtime 实际 outcome 报告成功；不能根据命令名推断 `websiteCommitted`，空数据须返回非零退出码和 `status=blocked`。

每次同步至少执行：

```bash
python3 -m pytest -q runtime/tests tests
python3 scripts/wain_invoice.py list --mode mock
python3 scripts/wain_invoice.py preflight --mode mock \
  --task-reference TEST-STATEMENT-001
```

还必须验证：

- 空待办预检返回非零退出码、`status=blocked`、`reason=no_pending_data`；
- 成功预检返回 `outcome=preflight_passed`、`excelDownloaded=true`，且 Excel 文件实际存在；
- `commit` 只有 runtime 返回 `website_committed` 时才能报告 `websiteCommitted=true`；
- 技能命令直接执行，不使用 `bash -lc`，避免切换到系统 Python。
