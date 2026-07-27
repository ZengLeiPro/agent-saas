# Runtime 来源与同步

- 上游仓库：`https://github.com/ZengLeiPro/wain-invoice`
- 当前 runtime 基线：`1bd7f1b9bc42098ec1a8d0a46206a2f36a1ad107`
- 同步日期：2026-07-27

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

同步后保留本技能的两处 ACS 适配：

- `runtime/core/skill.py`：Playwright 在非施耐德通用浏览器分支内懒加载，避免施耐德查询/预检被无关浏览器依赖阻断。
- `runtime/core/audit.py`：未显式传输出目录时落当前 workspace 的 `assets/yyyymmdd/`，不使用开发机 `~/code/` 路径。

每次同步至少执行：

```bash
python3 -m pytest -q runtime/tests tests
python3 scripts/wain_invoice.py list --mode mock
python3 scripts/wain_invoice.py preflight --mode mock \
  --task-reference TEST-STATEMENT-001
```
