---
name: wy-invoice
description: 唯恩电气 T100→施耐德 Vendor Portal 提交前制单技能。用户提到唯恩发票、施耐德发票、T100 待开票、对账单、寄售/非寄售录入，或要求“处理对账单、做到最终确认页、全程录屏、不提交、不回写 T100”时必须使用。本技能完成接口取数、Excel 匹配、验证码接力和浏览器填写，硬性停在最终确认页；当前环境不执行生产提交，也不回写 T100。
---

# 唯恩施耐德发票提交前制单

把唯恩 T100 中的待开票数据与对账 Excel 严格匹配，再操作施耐德 Vendor Portal 完成提交前制单。稳定规则由随技能分发的确定性 Python runtime 执行，Agent 负责任务选择、验证码识别与人工兜底、提交前硬停止、异常解释和录像证据交付。

业务人员推荐提示语：

> 处理对账单 `<对账单号>`，做到施耐德最终确认页后停下，全程录屏，不提交、不回写 T100。

## 先判断用户要做哪一步

| 用户意图 | 动作 | 是否写客户系统 |
|---|---|---|
| 查当前有哪些发票、对账单 | `list` | 否 |
| 检查 T100 数据和 Excel 是否可用 | `preflight` | 否 |
| 获取施耐德登录验证码（供自动识别） | `captcha` | 否 |
| 处理对账单、做到最终确认页、全程录屏 | `prepare` | 只填写并生成确认页，不最终确认 |
| 要求最终提交 | `commit` | 当前禁用，返回 `ie_mode_required` |

“处理对账单”“录入发票”“跑一下流程”默认解释为 `prepare`，绝不能推断为最终提交。当前 Chromium 执行器无论用户如何措辞都不得点击最终“确认”，也不得回写 T100。

### 正常用户交互保持简洁

不要要求用户在提示语里复述金额、行数、检查项、结构化结果字段或技术步骤。真实使用时，用户通常只需要参与两件事：

1. 指定要处理的对账单；只有一条明确待办时，可直接确认该单；
2. 自动识别验证码达到失败上限时，人工读取最新验证码。

到达最终确认页后直接停止并交付录像，不再询问是否由当前环境提交。

验证码默认由 Agent 自动识别（见第 3 节），不打断用户；只有自动识别连续失败达到上限时，才请用户人工读取验证码。

T100/Excel 匹配、网页逐行入篮、金额和发票字段复核、结果判定与证据保存都由 runtime 内部强制执行。Agent 默认只回报当前进度、关键结果和需要用户做的下一件事；异常时再展开诊断信息。

## 运行入口

技能文件会同步到用户 workspace。先解析当前技能目录，不要假设 cwd：

```bash
SKILL_DIR=".ky-agent/skills/wy-invoice"
```

若该目录不存在，说明技能尚未同步到当前 workspace，应报告平台技能同步问题，不要从 GitHub 临时下载另一份代码冒充已安装技能。

首次运行或依赖异常时，**每条命令直接交给 Shell 执行**：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" doctor
python3 -m pip install -r "$SKILL_DIR/requirements.txt"
python3 "$SKILL_DIR/scripts/wain_invoice.py" doctor
```

依赖只能安装到当前 workspace 已提供的 Python 环境；不要使用 `sudo`、系统包管理器、`pip install --user`，也不要自行创建新 venv。

### Python 环境硬规则

- **禁止用 `bash -lc 'python3 ...'` 包裹技能命令。** 登录 shell 可能重置 workspace 已提供的 `PATH`，误用系统 Python，表现为“刚安装完依赖，脚本仍报告所有模块缺失”。
- 不要用 `command -v python3` 的另一个 shell 结果推断实际执行环境；以直接执行 `python3 ... doctor` 的结果为准。
- 安装依赖后必须直接重跑 `doctor`。只有 `missingModules=[]` 且 `runtimeReady=true`，才能继续。
- 如果必须串联命令，优先拆成多次 Shell 调用；不要为了 `pipefail` 引入登录 shell。业务原始输出需要留证时，优先用 Shell 工具自身输出或重定向到 workspace 文件。

## 网络配置

所有业务动作都在 ACS 容器中完成。客户已于 2026-07-28 提供两个无需鉴权的公网只读映射，默认地址保存在客户专属配置中。若客户后续更换地址，平台管理员可通过受控环境变量覆盖：

```bash
WAIN_T100_ORDER_URL="<ACS 可访问的订单查询 URL>"
WAIN_T100_EXCEL_URL="<ACS 可访问的 Excel 下载 URL>"
```

当前公网地址没有鉴权，POC 可直接联调；正式运行前仍建议客户只对白名单 ACS 固定 SNAT 出口 IP 开放，并优先升级为 HTTPS。不要在 Skill、Git 或对话日志中写未来新增的接口密钥。

配置后执行真实连通性检查：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" doctor --probe-network
```

按用户请求的安全边界决定探测范围：

- 只做 `list` / `preflight` 时，不要求探测施耐德门户，也不要为了“完整 doctor”额外访问门户；直接执行相应只读命令，T100 查询与 Excel 接口会在流程中实际验证。
- 要执行 `captcha` / `prepare` 时，才运行 `doctor --probe-network`，并要求 `runtimeReady=true`、`t100OrderReachable=true`、`schneiderPortalReachable=true`。

不要把门户 URL 出现在配置或日志中误解为已经登录或访问门户；是否访问以运行动作和证据为准。

## 1. 查询待办

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" list --mode real
```

返回多条时，把对账单号、客户简称、发票号和业务类型列给用户选择。不要默认取第一条。

`list` 是“查询清单”动作，因此空数组可以保持 `status=ok, count=0`；这只表示查询成功且当前无待办，**不表示任何指定对账单预检成功**。不要自行联系客户群或发消息，只向用户说明需要业务侧补数据。

## 2. 业务预检

用户选定对账单后：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" preflight \
  --mode real \
  --task-reference "<对账单号>"
```

这一步完成 T100 取数、Excel 下载、发票备注严格匹配、订单号+行号唯一性、寄售日期和金额规则检查，不启动施耐德网站。证据默认保存到 `assets/yyyymmdd/唯恩施耐德发票/`。

### 预检成功判定（必须同时满足）

只有命令结构化输出同时满足以下条件，才能对用户说“预检通过”：

- 退出码为 `0`；
- `status="ok"`；
- `outcome="preflight_passed"`；
- `preflightPassed=true`；
- `excelDownloaded=true`；
- `excelPath` 指向实际存在的 Excel 文件；
- 运行日志包含 `[PREFLIGHT] 业务预检通过`。

以下情况都必须报告为**预检阻塞/失败**，绝不能写“流程已完成”或“核对通过”：

- `status="blocked"` 或退出码非零；
- `reason="no_pending_data"`；
- T100 没有找到指定对账单；
- Excel 未下载、路径不存在或接口返回 JSON/HTML 错误内容；
- 备注、订单号+行号、日期或金额规则任一未通过；
- runtime 没有返回可核验的结构化结果。

特别注意：`actions=0` 只证明没有网页写动作，**不能证明预检成功**。空数据时应明确写出“Excel 未下载、内容核对未执行”。

## 3. 验证码自动识别与人工兜底

施耐德验证码不能绕过，也禁止把验证码图片上传到外部 OCR 服务或第三方打码平台。验证码由 Agent 在 workspace 内直接读取 `captchaPath` 图片、用自身视觉能力识别；自动识别连续失败 3 次后才请用户人工读取。

先在 ACS 中建立登录会话：

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" captcha \
  --mode real \
  --task-reference "<对账单号>"
```

命令返回：

- `captchaPath`：验证码图片；
- `challengeFile`：保存同一个 `JSESSIONID` 的受限会话文件；
- `expiresInSeconds`：当前为 600 秒。

然后按以下自动识别流程处理，默认不向用户展示验证码、不等待用户输入：

1. Agent 直接读取 `captchaPath` 图片，识别其中的 4-6 位字母数字字符；只输出图片中实际可见的字符，不猜测、不复用任何历史验证码。
2. 把识别结果连同本次返回的 `challengeFile` 一起传给 `prepare`。
3. 若 `prepare` 报错“施耐德登录未成功，可能是验证码或账号密码错误”，视为本次验证码识别失败：重新执行 `captcha` 获取**全新**图片和 `challengeFile`，再次识别并尝试。登录失败后旧验证码和旧 `challengeFile` 一律作废，禁止复用。
4. 自动识别最多尝试 3 次（即最多 3 轮 captcha → 识别 → prepare）。3 次全部因验证码原因登录失败后，把最新一张 `captchaPath` 图片展示给用户，请用户人工读取，并用用户提供的验证码配最新 `challengeFile` 做最后一次尝试。
5. 若错误不是验证码原因（网络不可达、会话过期、页面结构异常、账号被锁等），不占用识别重试次数，直接按异常诊断处理并报告停在哪一步；会话超过 `expiresInSeconds` 则重新执行 `captcha` 并重新开始识别计数。

识别失败重试属于正常流程，前两次失败不需要打扰用户，只需在最终进度回报中说明“验证码自动识别第 N 次成功”或“已转人工读取”。

## 4. 提交前制单到最终确认页

```bash
python3 "$SKILL_DIR/scripts/wain_invoice.py" prepare \
  --mode real \
  --task-reference "<对账单号>" \
  --captcha "<按第 3 节流程获得的验证码>" \
  --challenge-file "<captcha 返回的 challengeFile>"
```

runtime 先用 HTTP 表单复用验证码会话登录，再把同一组 cookies 注入 Playwright Chromium。页面打开后会在顶层页面与所有 frame 中寻找真正可交互的控件，完成明细匹配、金额核对、发票字段填写、检查结果为零和最终确认页四字段复核。

`prepare` 强制全程录像，并在最终确认页硬性停止。成功结果必须同时满足：

- `outcome="confirmation_reached"`；
- `websiteReached=true`；
- `websiteCommitted=false`；
- `t100WrittenBack=false`；
- `videoPaths` 至少包含一个实际存在的 `.webm` 文件。

## 5. 最终提交当前禁用

施耐德生产提交依赖 Microsoft Edge 的 Internet Explorer 模式，当前 Chromium 执行器不具备该环境。`commit` 命令只返回：

```json
{
  "status": "blocked",
  "reason": "ie_mode_required",
  "websiteCommitted": false,
  "t100WrittenBack": false
}
```

禁止通过 JavaScript shim、直接提交表单、HTTP 请求或其他旁路绕过该限制。即使用户明确要求提交，当前 Skill 也只能执行 `prepare` 并说明最终确认需要 IE 模式环境。

## 执行环境边界

- 当前执行器使用 Playwright Chromium，只负责提交前制单，不负责生产提交。
- 施耐德旧站登录表单可通过 HTTP 会话完成验证码接力，后续页面可由 Chromium 操作到最终确认页。
- 用户现场确认生产提交必须使用 Microsoft Edge 的 Internet Explorer 模式；目标网址加入 IE 模式页面后只有 30 天有效期。
- 当前 Skill 不连接 Windows IE 模式环境，因此 `commit` 必须硬阻塞，不能用 User-Agent、JavaScript shim、直接 HTTP 表单提交等方式冒充兼容环境。
- `doctor --probe-network` 失败时只处理当前查询与制单链路的网络问题，不扩展生产提交能力。

## 业务规则

需要解释寄售/非寄售匹配、金额校验、客户阶段授权或结果报表时，读 `references/business-rules.md`。核心纪律：

- Excel“发票备注栏”必须与 T100 发票备注完全一致；
- 非寄售按收货日期、订单号+行号跨页精确匹配，不猜测、不模糊匹配；
- 寄售日期区间必须只返回一行，且汇总金额等于 T100 原币税前；
- 最终确认页四字段逐标签核对；
- 到达最终确认页后硬性停止；
- 当前链路不得确认施耐德页面，也不得回写 T100。

## 结果回报

向用户报告：

1. 本轮处理的精确对账单号；
2. 完成到哪一步：查询 / 预检 / 验证码识别中 / 等用户读验证码 / 已到最终确认页并停止；
3. 关键核对结果和是否存在异常；
4. 证据目录；
5. T100 是否回写。

若 T100 网络不可达、验证码过期、页面字段不一致、未到达最终确认页或录像缺失，要报告“停在哪一步、缺什么”。当前 Skill 在任何情况下都不能使用“已提交”或“已回写 T100”等表述。
