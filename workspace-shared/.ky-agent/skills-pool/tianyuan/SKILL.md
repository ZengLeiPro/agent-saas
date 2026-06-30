---
name: tianyuan
description: 旧 macOS 本机钉钉客户端版天元抓取方案，仅在用户明确要求查看、维护或迁移旧天元抓取脚本时触发。当前不适配 agent-saas ACS Sandbox；用户只是要求拉取/同步/导出天元数据时，不要自动运行本 skill，应先确认是否有官方 API、天元导出文件、浏览器可访问页面或人工上传数据。
---

# 钉钉天元服务平台数据抓取

> **ACS Sandbox 状态：暂不支持自动抓取。** 当前方案依赖 macOS 钉钉桌面客户端、Safari Web Inspector、Frida、peekaboo 和剪贴板，不能在 Linux ACS Sandbox 中运行。
> 在 ACS 中遇到天元数据需求时，先走安全替代路径：官方/内部 API、天元后台导出文件、用户上传的 Excel/CSV/JSON，或重新设计 Playwright/HTTP 方案。不要自动修改本机钉钉、不要执行 Frida 注入、不要默认写数据库。

从钉钉桌面客户端内嵌的天元服务平台 WebView 中提取数据（订单、商机、Leads 等）。这是 legacy macOS 本机方案。

## 技术链路

Frida 注入 → peekaboo 进入服务平台 → Safari Web Inspector 连接 WebView → JS DOM 导航 + 分页抓取 → 剪贴板提取 JSON → 数据清洗入库

## 前置条件

- 仅限明确授权的 macOS 本机维护场景。DingTalk.app 已去除 Hardened Runtime（钉钉更新后需重做）:
  `codesign -s - --deep --force /Applications/DingTalk.app`
- Frida 已安装在受控 Python 环境中；不要使用 `--break-system-packages`
- peekaboo 可用（Safari 自动化依赖）
- Safari 已启用"开发"菜单（Safari → 设置 → 高级 → 显示开发菜单）

## 执行方式

### 一条命令跑完全流程

```bash
bash <skill_dir>/scripts/scrape-tianyuan.sh [模块名称] [--write-db]
```

示例：
```bash
# 抓订单，只输出 JSON（默认不入库）
bash <skill_dir>/scripts/scrape-tianyuan.sh 订单管理

# 抓商机并在用户明确确认后入库
bash <skill_dir>/scripts/scrape-tianyuan.sh 商机管理 --write-db
```

**脚本输出**：每个步骤打印 `✅`/`❌` 状态，成功时最后一行输出 JSON 文件路径。

### Agent 的角色

**顺利时**：调一次 `scrape-tianyuan.sh`，等它跑完，读最后一行拿到 JSON 路径，交付给用户。**全程零介入**。

**失败时**：脚本会 `exit 1` 并打印明确错误信息，Agent 根据错误类型决定：

| 错误信息 | Agent 应对 |
|----------|-----------|
| `屏幕疑似锁定` | 提示用户解锁屏幕，解锁后重新运行脚本 |
| `钉钉未运行` | 提示用户打开钉钉 |
| `Frida 无法附着（Hardened Runtime）` | 提示用户执行 codesign 命令后重开钉钉 |
| `找不到「天元/钉钉服务平台」入口` | 截屏确认钉钉在主界面，左侧栏应有「天元」入口（有时也叫「钉钉服务平台」）；若 UI 结构有变化需更新脚本中的元素定位逻辑 |
| `Web Inspector 连接或 JS 执行失败` | 检查 Safari 开发菜单是否启用；重做 Frida 注入 |
| `超时：抓取未在 5 分钟内完成` | 截屏 Web Inspector 控制台看报错 |
| `入库失败` | JSON 文件仍可用，直接交付文件 |

## 内部流程详解

统一脚本 `scrape-tianyuan.sh` 内部按顺序执行 6 个步骤：

### [0/6] 屏幕状态检查

`peekaboo image` 截屏，通过文件大小判断是否全黑（< 5KB = 锁屏/息屏）。

### [1/6] 钉钉 + Frida 注入

`pgrep -x DingTalk` 检查进程 → `dingtalk-inject.sh` Frida 附着，遍历 WKWebView 调用 `setInspectable_(true)`。

### [2/6] 进入天元服务平台

`peekaboo dock launch "钉钉"` 激活 → `peekaboo see` 找「天元」或「钉钉服务平台」元素 → `peekaboo click` 进入。

**只做这一步原生 UI 点击**。服务平台内的模块导航（如切到订单管理）交给步骤 3 的 JS 完成。

> **为什么不用 peekaboo 点击 WebView 内的菜单？**
> 实测发现：WebView 元素在 accessibility tree 中没有 bounds 坐标，peekaboo 点击靠猜测，侧边栏菜单项密集（间距 ~20px）极易点偏（实测「订单管理」偏到了「报价管理」）。而 JS DOM 操作精确度 100%。

### [3/6] 连接 Web Inspector + 执行 JS

1. 生成带导航指令的 JS 文件：`window.__TARGET_MODULE__ = '订单管理';` + scraper.js
2. `safari-run-js.sh` 启动 Safari → 找开发菜单 → 导航到钉钉 WebView → 打开 Web Inspector → 粘贴 JS → 执行

scraper.js 在 WebView 内执行：
- `navigateToModule()`: 在 DOM 中精确匹配菜单项文本 → `.click()` → 等 3 秒加载
- 主循环：提取 table 行 → 点"下一页" → 等 1.5 秒 → 循环到末页
- 完成标记：`window.__SCRAPER_DONE__ = true`，数据存入 `window.__SCRAPER_RESULT__`

### [4/6] 等待完成 + 剪贴板提取

聚焦 Web Inspector 窗口 → 每 5 秒轮询 `__SCRAPER_DONE__` → 完成后 `copy(JSON.stringify(...))` → `pbpaste` 保存为 JSON → python3 验证。

**不走 blob 下载**——blob 会弹系统保存对话框，不可靠且需要人工交互。

### [5/6] 数据入库（可选）

`process-data.py` 读 JSON → 自动检测模块 → 清洗 → PostgreSQL UPSERT。默认跳过入库；只有传 `--write-db` 且用户明确确认目标库、表和影响范围后才可写入。

### [6/6] 输出

打印 JSON 路径 + 数据摘要。最后一行为纯路径，Agent 可程序化读取。

## 数据库表

| 模块 | 表名 | 主键 |
|------|------|------|
| 订单管理 | `tianyuan_orders` | 订单编号 |
| 商机管理 | `tianyuan_opportunities` | 商机编号 |
| 线索管理 | `tianyuan_leads` | 线索编号 |

写入后可通过 `ky-data-query` skill 查询。

## 故障排查

| 问题 | 解决 |
|------|------|
| Frida: `unable to access process` | 用户退出钉钉 → `codesign -s - --deep --force /Applications/DingTalk.app` → 重开钉钉 |
| Safari 开发菜单无钉钉 | 重新执行 dingtalk-inject.sh |
| safari-run-js.sh 找不到开发菜单 | 确认 Safari 已启用开发菜单（设置 → 高级） |
| Web Inspector 连错页面 | 修改 safari-run-js.sh 的第二个参数为更精确的关键词 |
| JS 只抓到 1 页 | 翻页按钮选择器可能不匹配，检查 scraper.js 的 clickNextPage() |
| pbpaste 为空 | `copy()` 未执行成功，截屏 Web Inspector 控制台看是否有报错 |
| `__SCRAPER_DONE__` 一直 undefined | JS 脚本可能未执行或报错，截屏查看 |
| 截屏全黑 | 屏幕锁定/息屏，提示用户解锁 |

## 文件清单

```
<skill_dir>/
├── SKILL.md                         # 本文件
└── scripts/
    ├── scrape-tianyuan.sh           # ★ 统一入口（一条命令跑完全流程）
    ├── dingtalk-inject.sh           # Frida 注入 isInspectable
    ├── navigate-to-module.sh        # 激活钉钉 + 进入服务平台（peekaboo 原生 UI）
    ├── safari-run-js.sh             # Safari 自动化（连接 WebView + 执行 JS）
    ├── scraper.js                   # JS 导航 + 分页抓取（含 __TARGET_MODULE__）
    ├── wait-and-copy.sh             # [备用] 独立等待+剪贴板提取（已内置到统一脚本）
    └── process-data.py              # 数据清洗 + PostgreSQL 入库
```
