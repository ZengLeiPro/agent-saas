---
name: wain-invoice
description: 唯恩电气 T100→施耐德 Vendor Portal 发票录入技能。用户提到唯恩发票、施耐德发票、T100 待开票、对账单、寄售/非寄售录入、客户系统最终确认或发票 POC 联调时必须使用。本技能在 Agent SaaS 的 ACS Linux Sandbox 中完成接口取数、Excel 处理、浏览器操作、人工验证码接力和最终确认，不依赖客户 Windows 或本地 Hand。
---

# 唯恩施耐德发票录入

把唯恩 T100 中的待开票数据与对账 Excel 严格匹配，再在 Agent SaaS 的 ACS 容器中操作施耐德 Vendor Portal。稳定规则由随技能分发的确定性 Python runtime 执行，Agent 负责任务选择、人工验证码接力、最终确认门禁、异常解释和证据交付。

## 先判断用户要做哪一步

| 用户意图 | 动作 | 是否写客户系统 |
|---|---|---|
| 查当前有哪些发票、对账单 | `list` | 否 |
| 检查 T100 数据和 Excel 是否可用 | `preflight` | 否 |
| 获取施耐德登录验证码 | `captcha` | 否 |
| 自动操作到施耐德最终确认页，但不确认 | `run` | 登录并填写，但不最终确认 |
| 明确要求提交某个对账单 | `commit` | 是，施耐德最终确认 |

不要把“处理一下发票”“跑一下流程”自动解释成最终提交。只有用户在当前对话中明确确认了具体对账单号，才能执行 `commit`。

## 运行入口

技能文件会同步到用户 workspace。先解析当前技能目录，不要假设 cwd：

```bash
SKILL_DIR=".ky-agent/skills/wain-invoice"
```

若该目录不存在，说明技能尚未同步到当前 workspace，应报告平台技能同步问题，不要从 GitHub 临时下载另一份代码冒充已安装技能。

首次运行或依赖异常时：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" doctor
python3 -m pip install -r "$SKILL_DIR/requirements.txt"
```

依赖只能安装到当前 workspace 已提供的 Python 环境；不要使用 `sudo`、系统包管理器、`pip install --user`，也不要自行创建新 venv。

## 网络配置

所有业务动作都在 ACS 容器中完成。T100 当前文档里的 `10.9.15.62:8000` 是唯恩内网地址，生产联调时由平台管理员通过受控环境变量注入客户开放后的地址：

```bash
WAIN_T100_ORDER_URL="<ACS 可访问的订单查询 URL>"
WAIN_T100_EXCEL_URL="<ACS 可访问的 Excel 下载 URL>"
```

客户开放公网端口时，应至少限制为 ACS 固定 SNAT 出口 IP，并优先使用 HTTPS 或客户提供的鉴权方式；不要把无鉴权接口直接暴露给整个公网。不要在 Skill、Git 或对话日志中写接口密钥。

配置后执行真实连通性检查：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" doctor --probe-network
```

只有 `runtimeReady=true`、`t100OrderReachable=true`、`schneiderPortalReachable=true` 才进入真实联调。Excel 接口会在 `preflight` 中实际验证。

## 1. 查询待办

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" list --mode real
```

返回多条时，把对账单号、客户简称、发票号和业务类型列给用户选择。不要默认取第一条。返回空数组时，直接说明客户已告知“业务部门可能已经处理”，需要在客户群请对方补一条新数据。

## 2. 业务预检

用户选定对账单后：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" preflight \
  --mode real \
  --task-reference "<对账单号>"
```

这一步完成 T100 取数、Excel 下载、发票备注严格匹配、订单号+行号唯一性、寄售日期和金额规则检查，不启动施耐德网站。证据默认保存到 `assets/yyyymmdd/唯恩施耐德发票/`。

## 3. 人工验证码接力

施耐德验证码不能绕过，也不能用 OCR 或第三方打码。先在 ACS 中建立登录会话：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" captcha \
  --mode real \
  --task-reference "<对账单号>"
```

命令返回：

- `captchaPath`：验证码图片；
- `challengeFile`：保存同一个 `JSESSIONID` 的受限会话文件；
- `expiresInSeconds`：当前为 600 秒。

把 `captchaPath` 对应图片展示给用户，请用户人工读取。下一步必须同时使用该验证码和原样返回的 `challengeFile`，不能重新生成登录页后复用旧验证码。

## 4. 操作到最终确认页

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" run \
  --mode real \
  --task-reference "<对账单号>" \
  --captcha "<用户人工读取的验证码>" \
  --challenge-file "<captcha 返回的 challengeFile>"
```

runtime 先用 HTTP 表单复用验证码会话登录，再把同一组 cookies 注入 ACS Playwright Chromium。旧站的 IE 建议提示按 IE11 User-Agent 兼容；业务操作、截图、DOM 和下载均留在当前 workspace。`run` 到达最终确认页并复核四个发票字段后停止，不点击最终“确认”。

## 5. 最终提交

最终确认是客户生产系统写操作。执行前必须在当前对话中再次向用户展示：

- 对账单号；
- 发票号码；
- 原币税前、税额、含税金额；
- “本次会确认施耐德页面，但当前不会回写 T100”。

用户明确确认具体对账单后，三个引用参数必须完全一致：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" commit \
  --mode real \
  --task-reference "<对账单号>" \
  --commit-reference "<同一对账单号>" \
  --confirm-submit "<同一对账单号>" \
  --captcha "<用户人工读取的验证码>" \
  --challenge-file "<captcha 返回的 challengeFile>"
```

脚本会在点击前再次复核发票号、日期、含税金额和税额，点击后必须观察到明确成功状态。不能因为工具退出码为 0 就自行推断成功，要同时检查运行日志的“最终确认”记录和证据目录。

## 执行环境边界

- 权威执行环境是 Agent SaaS 的 ACS Linux Sandbox，不使用 Windows Hand。
- 施耐德旧站公开登录页只是通过 User-Agent 弹出 IE 建议；登录表单本身是标准 HTTP POST。runtime 使用 HTTP 会话解决多轮验证码接力，再由 Playwright Chromium执行后续页面操作。
- 客户说明“Chrome 无法提交数据”仍是待真实联调验证的事实约束。若最终提交在 Chromium 中失败，应保留当次 DOM、网络结果和表单字段，在 ACS 内补直接 HTTP 表单提交；不能因此把执行环境改回客户 Windows。
- `doctor --probe-network` 若失败，先解决客户接口公网映射/白名单或 ACS 出口策略，不引入本地执行端。
- Windows 双击 EXE 只保留为历史现场备份，不是 Agent SaaS 产品链路。

## 业务规则

需要解释寄售/非寄售匹配、金额校验、客户阶段授权或结果报表时，读 `references/business-rules.md`。核心纪律：

- Excel“发票备注栏”必须与 T100 发票备注完全一致；
- 非寄售按收货日期、订单号+行号跨页精确匹配，不猜测、不模糊匹配；
- 寄售日期区间必须只返回一行，且汇总金额等于 T100 原币税前；
- 最终确认页四字段逐标签核对；
- 当前客户允许网页提交，但尚未提供 T100 回写接口，成功后必须明确记录“施耐德已确认、T100 未回写”。

## 结果回报

向用户报告：

1. 本轮处理的精确对账单号；
2. 完成到哪一步：查询 / 预检 / 等验证码 / 到确认页 / 已确认；
3. 关键核对结果和是否存在异常；
4. 证据目录；
5. T100 是否回写。

若 T100 网络不可达、验证码过期、页面字段不一致或最终确认没有明确成功标志，要报告“停在哪一步、缺什么”，不能使用“完整闭环”“已提交”等表述。
