---
name: ky-data-query
description: 查询和操作公司业务数据库，涵盖CRM数据、钉钉员工/部门/日志/日程、云效项目/工时等数据，以及销售数据闭环的待办表 sales_action_items（缺口侦探/作战信号读写）。查询分析默认只读；当用户明确要求新增、修改、删除、恢复业务数据时，也通过 ky-azeroth CLI 执行。
---

# 开沿业务数据查询

通过 **ky-azeroth CLI（JWT + RBAC）** 访问业务系统。查询分析时 dump 业务数据为 NDJSON，再用本地 **DuckDB** 做 SQL 分析；当用户明确要求写入时，可用 CLI 的标准 CRUD 子命令新增、修改、软删除、恢复数据。全程走应用层，不直连数据库，权限与业务系统完全一致。

## 核心原则：查询像业务分析师，写入像业务系统操作员

用户提问时，不要机械地只查一张表。要站在"懂业务的分析师"角度，想清楚三件事：

1. **提问者真正想知道什么？** "查一下这个客户"不只是要名字，而是想了解全貌——基本信息、商机进展、订单金额、回款到账情况、最近跟进动态。
2. **还需要补充什么才完整？** 查商机要带上具体卖了什么产品；查订单要附上回款进度；查回款要关联到哪个合同、什么产品。孤立的数字没有意义。
3. **结果怎么呈现最有用？** 不只是贴出表格，而是做出分析和总结——总金额多少、完成率多少、有什么异常或风险。

### 分析与总结要求

查询结果不要只罗列原始数据，应主动提供：

- **汇总统计**：总金额、数量、平均值等关键指标
- **完成率/缺口**：订单应收 vs 已收、商机预计 vs 实际
- **时间维度**：按月/季度趋势、距上次跟进多久
- **异常提醒**：长期未跟进的客户、大额未回款、逾期订单
- **结论性语句**：用一两句话概括结果的业务含义

### 写操作原则

CLI 已支持标准 CRUD，但写操作会真实修改业务系统数据：

- 只有当用户**明确要求**新增、修改、删除或恢复数据时才执行写操作；模糊请求先确认。
- 执行前先用 `azeroth describe <entity> --action <create|update>` 确认可用字段，用 `get` 或 `list` 定位目标记录。
- 执行前向用户展示将要运行的命令和影响对象；删除、恢复、批量修改等高影响操作必须得到明确确认。
- 禁止绕过 RBAC 或换账号；403 代表当前用户无权操作。
- 写入后用 `get <id>` 或相关 `list` 复查，并把结果摘要返回给用户。

## 第 0 步：确保 CLI 是最新版（每次会话首次使用 ky-data-query 时必跑一次）

agent 平台已经按当前会话用户自动注入 `AZEROTH_TOKEN`（长期 PAT）和 `AZEROTH_API_URL` 到子进程 env。但 `azeroth` 二进制本身要从 ky-azeroth 生产服务按需拉取（保证与服务端同版本，永不漂移），第一次使用前必须 source 一次 ensure 脚本：

```bash
source ".ky-agent/skills/ky-data-query/scripts/ensure-cli.sh"
azeroth whoami    # 确认身份
```

ensure 脚本逻辑：

- cache 在 `~/workspace/<user>/.cache/azeroth-cli/azeroth`（脚本内部用 `$(pwd)/.cache/azeroth-cli` 推断，agent dispatch 下 cwd 永远等于 workspace 根，等价）
- 1h TTL；命中 cache 且未过期 → 0 网络请求立即返回
- 过期 → 调一次轻量 hash 端点比对，hash 一致只刷新 stamp 不下载
- hash 变了 / cache 空 → 拉 ~1MB bundle 原子覆盖

之后整个会话内可以直接 `azeroth ...`，无需关心路径（cache 已注入 PATH）。

如果刚部署过 ky-azeroth，或 `azeroth describe <entity>` 看不到刚新增的字段，可能是 1h TTL 命中旧 cache；可强制刷新一次：

```bash
AZEROTH_CLI_FORCE=1 source ".ky-agent/skills/ky-data-query/scripts/ensure-cli.sh"
```

如果 `source` 报"No such file or directory"，说明当前 workspace 没启用 ky-data-query skill。**不要尝试自己 cp 脚本**，告诉用户即可。

## 可选：CLI 覆盖度自检

不确定某实体是否被 CLI 暴露，或行为反常时跑一次：

```bash
azeroth doctor          # 三分类报告：shared schema / controller / Prisma 三方比对
azeroth entities        # 当前 CLI 实际可用的实体清单（JSON）
```

## ⚠ 不要查询的实体（即使 `azeroth entities` 列出了也忽略）

`azeroth entities` 是 schema-driven 自动发现，会列出比 ky-data-query 业务查询范围更宽的实体。下列三类一律忽略：

**A. 个人健康/饮食域**（曾磊个人健康配置，不属于业务查询）：

- 6 个个人 `my/*` 实体已在 CLI 层用 `EXCLUDED_ENTITIES` 显式排除，`azeroth entities` **不再列出**，无需你手动忽略：
  `body-metrics  diet-plans  diet-daily-logs  diet-water-logs  diet-subjective-logs  diet-purchase-items`
- `diet-foods`（食物库）/ `diet-supplements`（补剂库）是公司共享主数据，`azeroth entities` 仍会列出且 CRUD 可正常调通，但属个人健康域配置、不是业务分析对象——业务查询里同样不要碰。

**B. 阿里云运维数据**（属于云成本治理域，ky-data-query 不覆盖）：

```
cloud-bill-snapshots  cloud-usage-metrics  cloud-instance-metas  cloud-alerts
```

**C. 调用必失败的"假实体"**（CLI 自动派生但 server 无对应 controller，调用会 404；跑 `azeroth doctor` 看 `standard_gap` 段确认。注：`covered_broken` 现已为 0——原先会失败的健康域实体已移入 `excluded` 分类、不再派生命令）：

```
cloud-cost-overviews  cloud-package-projections  cloud-usage-serieses   # 命名不匹配的虚假派生
approval-flows                                                          # 审批流模板，运维配置不参与业务分析
```

> **审批"实例"查询请用 `azeroth approvals` 命令组**——不是 entity-CRUD 风格，而是独立命令组：`pending / completed / initiated / copy-to / all / form <eventType> <formId> / get <instanceId> / pending-count`。用户问"XX 订单的审批进度"时用 `azeroth approvals get <instanceId>` 或 `azeroth approvals form <eventType> <formId>`（后者按业务单 ID 反查实例）。

> **`sales-action-items` 不是普通业务分析实体**：它是「销售数据闭环系统」的待办表，**写权限只给 admin 角色**（夜间 cron 用），销售/分析师本人 token 调 `create`/`update` → 403。普通数据分析问题（查客户/商机/业绩）**不要碰这张表**；只有做缺口侦探、夜间写候选、或销售处置自己待办时才用，详见下方「销售数据闭环」专节 + [references/sales-action-items.md](references/sales-action-items.md)。

## 鉴权与身份

**你扮演的是当前会话用户在 ky-azeroth 内的真实身份**，不是 admin。这意味着：

- 数据范围按 RBAC 自动过滤——你看到的 customers/opportunities 等是该用户能看到的部分，不是全量。
- **403 是预期行为，不是 bug**。某条资源拒绝你，说明该用户在 ky-azeroth 内本就没那个权限，告诉用户即可，不要想着升权或换账号。
- **禁止运行 `azeroth login` / `azeroth logout`**。这两个命令会写 `~/.azeroth-cli/auth.json`，但该路径已被 sandbox deny，且 env token 优先级最高让本地 auth.json 失效。
- 想确认身份用 `azeroth whoami`（只读，调服务端拿当前 PAT 真实身份）。

如果 `azeroth` 报"command not found" / "Not logged in" / 401：

1. 先确认 ensure 脚本跑过：`ls -la .cache/azeroth-cli/azeroth`
2. `echo "${AZEROTH_TOKEN:0:12}..."` 验证 PAT env 存在
3. PAT 缺失 = 当前 agent 用户在 server 端的 PAT 配置里没有条目，告诉用户找 admin 补一个；不要尝试自己 login

## 前置依赖

**DuckDB 已安装**（本地 SQL 分析引擎，无需 server）

```bash
duckdb --version      # 期望 ≥ 0.10
# 若未安装：
brew install duckdb
```

## 三步法

### 第 1 步：dump NDJSON

**先判断要不要全量 dump**——`list` 子命令支持服务端 filter 参数（每个实体不同，`azeroth <entity> list --help` 自查）。能用 filter 缩范围就别全量拉。常见 filter：

```bash
# 按负责人查（chargerId 是 employees.id UUID，不是钉钉 userId）
azeroth customers list --charger-id <employee-uuid> --all --output "$SESS/customers.ndjson"
# 按状态/质量/成交状态过滤（具体参数以 help / describe 为准）
azeroth customers list --customer-level A --deal-status 已赢单 --all --output ...
# 按关键字
azeroth customers list --keyword 福宠 --all --output ...
```

判断标准：用户问的是"育新名下的客户""A 级客户"等可由 filter 表达的范围 → 用 filter；问的是"团队整体业绩排名"等需要全表聚合 → 全量。

需要全量时，并行启动多个实体的 `list --all` 翻页导出，用 `wait` 对齐快照时刻：

```bash
# 路径必须落在 cwd 内的 .cache/ 下，不要用 /tmp 或 $TMPDIR：
#   - /tmp 在非 admin 沙箱下 mkdir 会 EPERM（macOS symlink 边角问题）
#   - $TMPDIR 沙箱可写但 Write 工具白名单不含，后续写 SQL 文件会被拒
# cwd 内默认两路全通，print-then-execute 流程才能闭环。
export SESS="$(pwd)/.cache/azq/$(date +%Y%m%d-%H%M)"
mkdir -p "$SESS"

azeroth customers     list --all --output "$SESS/customers.ndjson"     &
azeroth keep-records  list --all --output "$SESS/keep_records.ndjson"  &
azeroth opportunities list --all --output "$SESS/opportunities.ndjson" &
azeroth sale-orders   list --all --output "$SESS/sale_orders.ndjson"   &
azeroth payments      list --all --output "$SESS/payments.ndjson"      &
wait
```

**关键约定**：

- `--all` 自动串行翻页（pageSize 默认 100，可 `--page-size 500` 加速；非 ADMIN 账号在 customers/keep-records/opportunities 上把 `--page-size` 设 >500 会被 403）。
- CLI stderr 会打印进度；**完成时末行输出 ISO 时间戳 `snapshot_at=...`**，这就是本次分析的"现在"时刻。
- 失败时 stderr 打印续传命令：`azeroth <entity> list --all --resume-from-page <n> --output <file>`。
- **每次新会话必须重新 dump，不复用任何旧的 NDJSON**。不引入"几小时内可复用"之类的时间窗口判断——会话开始就重拉，一次到底，业务数据是否最新由这一规则强保证。

### 第 2 步：DuckDB 分析

**Print-then-execute 硬约定**（不可跳过）：

1. 先把要跑的 SQL **写入 `$SESS/q.sql`**（完整 SQL，含 CAST、软删除过滤、注释）。
2. **把 SQL 贴给用户 review**，一两句说明意图，给用户秒级喊停的机会。
3. 用户默许或确认后，再执行：

   ```bash
   duckdb -c ".read $SESS/q.sql"
   # 或结构化输出
   duckdb -json -c ".read $SESS/q.sql"
   ```

NDJSON 直接 `read_json_auto('file.ndjson', format='newline_delimited')` 即可入表。对复杂分析建议建临时视图：

```sql
CREATE OR REPLACE VIEW customers AS
  SELECT * FROM read_json_auto('.cache/azq/20260422-0130/customers.ndjson', format='newline_delimited');
```

### 第 3 步：业务总结

按上面"分析与总结要求"给结论，不要只回贴表格。

## 自检清单（写 SQL 前必走）

1. **软删除过滤**：只对 `azeroth describe <entity> --action response` 确认含 `deletedAt` 的实体加 `WHERE "deletedAt" IS NULL`；没有该字段的实体不要加。
2. **JOIN key**：`customerId` / `opportunityId` / `saleOrderId` / `chargerId` 都是 string，对齐名字不要张冠李戴。
3. **类型 CAST**：日期显式 `::TIMESTAMP` 或 `::DATE`；Decimal 金额统一 `CAST(x AS DECIMAL(18,2))`。
4. **NULL 处理**：`SUM()` 和 `COUNT(expr)` 都可能出 NULL，用 `COALESCE(..., 0)` 兜底。
5. **时区对齐**：时间字段来自后端是 UTC ISO 字符串；聚合前 `field::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'` 两步转换再 `DATE_TRUNC`。当前时间用 `NOW() AT TIME ZONE 'Asia/Shanghai'`。

## 数据关联指南

CRM 数据的价值在于关联。以下是核心关联路径：

```
customers (客户)
  ├── contacts (联系人)                    via "customerId"
  ├── keep_records (跟进记录)              via "customerId"
  ├── visit_records (拜访记录)             via "customerId"
  ├── opportunities (商机)                 via "customerId"
  │     └── products[] (商机产品明细，内嵌在 opportunity.products 数组，get 时返回)
  ├── sale_orders (合同订单)               via "customerId" / "opportunityId"
  │     └── products[] (订单产品明细，内嵌在 sale_order.products 数组，get 时返回)
  ├── payments (回款)                      via "customerId" / "saleOrderId"
  └── invoices (发票)                      via "customerId" / "saleOrderId"
```

> **按产品维度做全量分析需逐条 `get`**：`sale_orders` / `opportunities` 的 `products` 子数组只在 `get <id>` 时返回，`list --all` 只含主表字段。要做"所有订单/商机各卖了什么"类分析，先 `list --all` 拿主表 id，再串行 `get` 输出详情 NDJSON。
>
> ```bash
> # 例：订单产品明细。要求先 dump sale_orders.ndjson。
> python3 - <<'PY'
> import json, subprocess, pathlib, os, sys
> sess = pathlib.Path(os.environ['SESS'])
> src = sess / 'sale_orders.ndjson'
> dst = sess / 'sale_order_details.ndjson'
> with src.open() as f, dst.open('w') as out:
>     for line in f:
>         if not line.strip():
>             continue
>         oid = json.loads(line)['id']
>         r = subprocess.run(['azeroth', 'sale-orders', 'get', oid], text=True, capture_output=True)
>         if r.returncode != 0:
>             print(r.stderr, file=sys.stderr)
>             raise SystemExit(r.returncode)
>         out.write(json.dumps(json.loads(r.stdout), ensure_ascii=False) + '\n')
> PY
> ```

### 什么场景该关联什么

| 用户问的是     | 不要只看       | 而要一并带出                                                                 |
| -------------- | -------------- | ---------------------------------------------------------------------------- |
| 某客户情况     | customers      | + 进行中的商机、未完结订单、回款缺口、最近跟进                               |
| 某商机详情     | opportunities  | + 产品明细（products 子数组）、客户背景                                      |
| 某订单详情     | sale_orders    | + 订单下的产品明细（需 `get <id>`，list 不含）、回款进度（从 payments 聚合） |
| 某笔回款       | payments       | + 对应合同订单、订单产品明细                                                 |
| 某人负责的客户 | chargerId 过滤 | + 各客户成交状态、金额汇总                                                   |
| 某员工信息     | employees      | + 所在部门（departments 子数组）、在职状态                                   |
| 某项目进度     | projects       | + 工单按状态分布（project_tickets）、工时（effort_records）                  |

### 4 套 DuckDB 模板（详见 references/templates.sql）

| 模板                               | 用途                                           | 典型场景                   |
| ---------------------------------- | ---------------------------------------------- | -------------------------- |
| **模板 A：客户全貌**               | 客户 + 商机/订单/回款/跟进/拜访 JSON 数组聚合  | "查一下 XX 客户的情况"     |
| **模板 B：销售业绩排行**           | 按 chargerId 汇总：客户数/商机额/订单额/回款率 | "团队这个月业绩排名"       |
| **模板 C：每日动态**               | 按天聚合跟进/拜访/回款/新客户/新商机           | "今天/本周/本月发生了什么" |
| **模板 D：长期未跟进的有商机客户** | >7 天未跟进 AND 有活跃商机的客户               | "哪些客户要催销售跟一下"   |

写新查询前，**先看这 4 个模板是否已覆盖**，覆盖就直接改参数；不覆盖再基于自检清单新写。

## 实体清单与 CLI 命令

**CRM 核心**：

```bash
azeroth customers       list --all --output "$SESS/customers.ndjson"
azeroth contacts        list --all --output "$SESS/contacts.ndjson"
azeroth keep-records    list --all --output "$SESS/keep_records.ndjson"
azeroth opportunities   list --all --output "$SESS/opportunities.ndjson"
azeroth sale-orders     list --all --output "$SESS/sale_orders.ndjson"
azeroth payments        list --all --output "$SESS/payments.ndjson"
azeroth invoices        list --all --output "$SESS/invoices.ndjson"
azeroth visit-records   list --all --output "$SESS/visit_records.ndjson"
azeroth crm-products    list --all --output "$SESS/crm_products.ndjson"
azeroth crm-work-dailies list --all --output "$SESS/crm_work_dailies.ndjson"
```

**组织/项目/薪资**：

```bash
azeroth employees       list --all --output "$SESS/employees.ndjson"
azeroth departments     list --all --output "$SESS/departments.ndjson"
azeroth users           list --all --output "$SESS/users.ndjson"
azeroth roles           list --all --output "$SESS/roles.ndjson"
azeroth projects        list --all --output "$SESS/projects.ndjson"
azeroth project-tickets list --all --output "$SESS/project_tickets.ndjson"
azeroth effort-records  list --all --output "$SESS/effort_records.ndjson"
azeroth payroll         list --all --output "$SESS/payroll.ndjson"
```

> 审批"实例"查询走独立命令组 `azeroth approvals ...`（见上方"不要查询的实体"段末注），不在 entity-CRUD 体系内。`approval-flows` 是流模板配置，属于不要查询的实体清单。

**钉钉/系统只读表**（无软删除字段）：

```bash
azeroth dingtalk-logs             list --all --output "$SESS/dingtalk_logs.ndjson"
azeroth dingtalk-calendar-events  list --all --output "$SESS/calendar_events.ndjson"
azeroth employee-leaves           list --all --output "$SESS/employee_leaves.ndjson"
azeroth login-logs                list --all --output "$SESS/login_logs.ndjson"
```

不记得字段名时，第一信源是 `azeroth describe <entity> --action <create|update|query|response>`；references/schema.md 只是静态速查缓存，可能落后于最新 CLI。

## 写操作命令

标准 CRUD 实体会自动暴露以下子命令（只读实体只暴露 `list/get`）：

```bash
azeroth <entity> list [filters...]              # 查询列表
azeroth <entity> get <id>                       # 查询单条
azeroth <entity> create --field value ...       # 新增
azeroth <entity> update <id> --field value      # 修改
azeroth <entity> delete <id>                    # 软删除
azeroth <entity> restore <id>                   # 恢复软删除（仅 customers / crm-products）
azeroth <entity> submit-approval <id>           # 提交业务单审批（仅 sale-orders / payments / invoices / visit-records）
azeroth customers claim <id>                    # 认领公海客户（仅 customers）
```

字段与参数不要猜：

```bash
azeroth describe customers --action create
azeroth describe customers --action update
azeroth customers create --help
azeroth customers update --help
```

只读实体（如钉钉同步日志、离职记录、登录日志）不会注册 `create/update/delete/restore`，命令不存在就是设计如此。

## 非标 action 命令（按实体列出）

除标准 CRUD 外，部分实体有专用 action 命令——不属于自动派生范畴，必须在此显式记录，agent 才会发现。**所有写命令均支持 `--dry-run`，输出 `{ method, path, body }` 但不实际发请求**。

### projects（项目）

```bash
azeroth projects link-sale-order <projectId>   --sale-order-id <uuid>     # 挂接销售订单
azeroth projects unlink-sale-order <projectId> <saleOrderId>              # 解除挂接
azeroth projects add-member <projectId>        --employee-id <uuid> [--user-name <s>] [--role <s>]
azeroth projects remove-member <projectId>     <memberId>                 # 移除成员
azeroth projects list-members <projectId>                                 # 查成员（只读）
```

用户问"某项目挂了哪些订单 / 有哪些成员"用 `list-members` + 主表 `get` 即可，不用 dump 主表硬猜。

### customers（客户批量与回收站）

```bash
azeroth customers trash --page 1 --page-size 100         # 查回收站（已软删除）
azeroth customers duplicate-check --json <file>          # 客户查重（body 至少含 name/phone/uncId 一项）
azeroth customers batch-transfer --json <file>           # 批量转交负责人 { ids, chargerId }
azeroth customers batch-update --json <file>             # 批量改白名单字段 { ids, patch }
azeroth customers batch-add-collaborators --json <file>  # 批量加协作人 { ids, collaboratorIds }
azeroth customers batch-remove-collaborators --json <file>
azeroth customers batch-delete --json <file>             # 批量软删除 { ids }（可 restore 恢复）
azeroth customers permanent-delete <id> --yes            # 永久删除（不可恢复，强制 --yes 二次确认，仅 ADMIN）
```

批量命令 body 必须是 JSON 文件路径（或 `-` 表示 stdin），CLI 端走 shared zod schema 校验——失败直接打印 zod issues，不会真发请求。

### payments（退款）

```bash
azeroth payments create-refund --json <file>             # 创建退款（OUT 方向，11 字段，含 saleOrderId/paymentAmount/refundType/relatedPaymentId 等）
azeroth payments submit-refund-approval <id>             # 退款专用审批入口（与 submit-approval 区别在 eventType）
```

### invoices（发票红冲）

```bash
azeroth invoices red-void <id> --version <n> --reason <text> --yes   # 全额红字冲销（不可逆，强制 --yes）
```

`--version` 是乐观锁版本号；CLI 端走 shared `redVoidInvoiceSchema` 校验 version ≥1、reason 1-500 字。

### holidays（节假日）

```bash
azeroth holidays list --year 2026                        # 查整年节假日
azeroth holidays calendar --start-date 2026-01-01 --end-date 2026-12-31   # 工作日历范围查询
azeroth holidays publish <year> --json <items.json> [--confirm-empty]     # 整年发布（PUT /year/:year）
```

holidays **只有这三个命令**——CLI 已显式屏蔽 `get/create/update/delete`（后端无对应路由）。整年发布 body 走 `publishHolidaysSchema` 校验，含跨年与重复日期 superRefine。

### payroll（薪资周期 / 导入流水 / 批删）

```bash
azeroth payroll list-periods                             # 薪资周期汇总（按 yyyy-MM 归并）
azeroth payroll list-import-batches                      # 历次导入批次列表
azeroth payroll get-import-batch <id>                    # 单个导入批次详情（含 issues 明细）
azeroth payroll preview-import --file-url <oss-xlsx-url> # 预览导入（不入库，看行级 issues + 汇总）
azeroth payroll commit-import  --file-url <oss-xlsx-url> [--strategy replace_period]   # 落库 + 整周期替换
azeroth payroll batch-delete   --ids <uuid> --ids <uuid> [--json <file>]               # 批量软删除（≤200 条）
```

导入流程：业务端先上传 .xlsx 到 OSS 拿 fileUrl → `preview-import` 看 issues → 修 Excel 重传 → `preview-import` 直到 0 error → `commit-import` 整周期替换落库。

### users（用户状态 / 改密 / 选择器列表）

```bash
azeroth users update-status <id> --status active|disabled            # 切换启用/禁用（不接受 locked，那是登录失败系统自动置位）
azeroth users change-password  --current-password <pw> --new-password <pw> --confirm-password <pw>   # 改当前 JWT 身份的密码（--dry-run 自动脱敏）
azeroth users list-all         [--status active|disabled] [--keyword <kw>]   # 选择器视图（不分页，仅 id/username/phone/employeeName）
```

`change-password` **走当前登录身份**而非 :id——admin 改他人密码请走 `azeroth users update <id> --password <new>`（标准 update 命令）。新密码需 ≥8 位 + 大小写字母 + 数字 + 两次确认一致，shared `changePasswordSchema` 端到端强校验。

### effort-records（工时批量补录）

```bash
azeroth effort-records batch-create --json <items.json>   # 单次 1-20 条原子提交（任一条校验失败整批回滚）
```

工时补录是高频场景（项目结算时回填一周工时），单条循环 `create` 慢且容易半成功——`batch-create` 一次性原子化提交是正解。items 字段含 `projectId/recordType/date/actualTime/description/...`，走 shared `batchCreateEffortRecordSchema` 校验，注意 `recordType` 是 `ACTUAL | PLAN`（不是 DEV/QA/...）。

> 上述非标 action 命令均**不在** ky-data-query"业务查询默认范围"内（ky-data-query 主要做 CRM/项目/工时只读分析），仅当用户**明确要求**做批量转交、发起退款、红冲、整年发布、薪资导入、用户状态切换、工时补录等业务操作时才用，执行前按"写操作原则"段展示命令与影响对象等待确认。

## 销售数据闭环：sales_action_items 待办表（缺口侦探 / 作战信号）

> 开沿「销售数据闭环系统」：销售**不再写日报**，改由一条夜间 admin cron fan-out 子 agent，借各销售钉钉 token 采集 + 读存量 CRM，产出「进攻信号（今日作战）+ 缺口侦探（数据待办/防御）」写进 `sales_action_items` 表，再由 azeroth 工作台两卡呈现。**完整手册见 [references/sales-action-items.md](references/sales-action-items.md)**——做缺口侦探查询、写候选、采纳/忽略前必读。

这里只放最 load-bearing 的几条（细节、字段、查询模板、别名表都在 reference）：

- **D1 终极红线**：任何 AI 抽取/补全**一律进 `sales_action_items` 候选、人工一键采纳才入库，绝不夜间直接写 CRM（连跟进记录也不行）**。夜间脚本唯一允许的写命令是 `azeroth sales-action-items create`；**绝不调** `azeroth keep-records create` / `customers create` / `payments create` 等 CRM 写命令。补错跟进比"没补"更伤。
- **CLI 命令**（命令名逐字来自后端 `@Controller('sales-action-items')`）：标准 CRUD `list/get/create/update/delete` 自动派生；非标动作已由 CLI 手挂：`my` / `my-count` / `adopt <id>` / `ignore <id> --resolve-note` / `done <id> --done-type --resolve-note` / `reopen <id>` / `undo <id>`。上线后跑 `azeroth sales-action-items --help` 确认 bundle 已更新。**采纳务必走 `azeroth sales-action-items adopt <id>` / `POST /:id/adopt`**（后端复用 KeepRecordsService.create + D6 强校验），别绕过去直接写 keep-records，也别用 `update --status adopted` 伪装采纳。
- **写权限只给 admin 角色**：夜间 cron 用 admin PAT 写。**销售/分析师本人 token 调 `create`/`update` 写这张表 → 403**（azeroth RBAC，预期行为，不是 bug，别升权/换账号）。销售 token 只能读 + 处置自己名下待办。
- **缺口分硬/软**：硬缺口（交叉比对存量 CRM 确定，`confidence=HIGH`，理直气壮督办）vs 软缺口（从聊天推测，`confidence=MEDIUM`，必须标"疑似"+证据原文+降级"请你判断"）。**乱督办比不督办更伤信任**，拿不准一律降级。六类硬缺口 SQL 模板见 reference 第三节。
- **客户简称匹配禁直接 `LIKE '%简称%'`**：先按 chargerId 拉名下客户全称、再语义匹配（结合内置别名表，见 reference 第七、八节）；匹配不唯一一律降级，绝不据简称推断写系统。
- **派生字段静默丢弃**：`contactStatus`/`dealStatus`/各类汇总缓存字段写入被 service 层静默剔除（不报错），所以"命令成功"≠"写进去了"——**关键写入后必 `get <id>` 回查**（见下方"派生字段"规范）。

## 查询规范

### Part 1：DuckDB / NDJSON 通用陷阱（写 SQL 前必读一次）

详见 [references/duckdb-pitfalls.md](references/duckdb-pitfalls.md)，12 条带反例：camelCase 双引号、日期 CAST、UTC↔Shanghai 两次转换、Prisma Decimal CAST、`COALESCE(SUM(...), 0)`、`COUNT(expr)` vs `COUNT(*)`、`read_json` 显式 schema 兜底、`array_agg` 必须 `ORDER BY`、`date_diff('day', ...)` 单数、复杂 SQL 走 `.sql` 文件、`format='newline_delimited'` 完整写法、保留字加引号。

每条独立、可对照反例直接复制粘贴。**第一次写 SQL 时通读一遍，之后只在踩坑时回查具体条目。**

### Part 2：ky-azeroth 业务规则（非通用，本系统特有）

#### § 1. 软删除字段范围

下列业务表通常有 `"deletedAt"`，**写 SQL 必加** `WHERE "deletedAt" IS NULL`：

`customers / contacts / keep_records / opportunities / sale_orders / payments / invoices / visit_records / crm_products / crm_work_dailies / employees / projects / project_tickets / effort_records / payroll`

下列响应里**没有** `deletedAt` 字段，加了会报 `column not found`：

`departments / users / roles / dingtalk_logs / dingtalk_calendar_events / employee_leaves / login_logs`

如有不确定，优先跑 `azeroth describe <entity> --action response`，以实时输出为准。

#### § 2. dingtalk_logs 的 creatorId 不是稳定身份主键

`dingtalk_logs.creatorId` 可能混用钉钉 userId 与 Azeroth employee UUID，同一个人跨时间段可能出现不同 `creatorId`。查询某员工钉钉日志时，**禁止只按单个 creatorId 下结论**；优先按 `creatorName` 过滤，必要时再兼容多个已知 ID。

✅ 正确：

```sql
WHERE "creatorName" = '杨乙煌'
```

或：

```sql
WHERE "creatorName" = '杨乙煌'
   OR "creatorId" IN ('17738826091744800', '2480c57d-f5d7-491e-9494-920d6ed3e60f')
```

❌ 错误：

```sql
WHERE "creatorId" = '17738826091744800'
```

如果用旧钉钉 userId 查询，可能漏掉 2026-05-26 起以 employee UUID 进入的日志，误判为“未提交”。`source='local'` 也属于 Azeroth 钉钉日志记录，不应默认排除。

#### § 3. chargerId / ownerId / assigneeId 一律是 employees.id（UUID）

04-06 Employee ID 归一化后，所有 CRM/项目表的负责人字段都已统一为 `employees.id`：

```sql
-- ✅ 正确
LEFT JOIN employees e ON e.id = c."chargerId" AND e."deletedAt" IS NULL

-- ❌ 反例（旧文档遗留写法，已不工作）
LEFT JOIN employees e ON e."dingtalkUserId" = c."chargerId"
```

涵盖：`customers.chargerId / opportunities.chargerId / keep_records.chargerId / sale_orders.chargerId / payments.chargerId / visit_records.chargerId / projects.ownerId / project_tickets.assigneeId / project_tickets.dispatcherId / effort_records.ownerId`。

> 实测验证（2026-04-28）：1024 条 payments 全部 100% 命中 employees.id，无任何记录走 dingtalkUserId 路径。

#### § 3.1 业绩聚合一律按 chargerId 字段筛，不按可见性筛

后端 RBAC 对 `sale_orders / opportunities / keep_records / visit_records / payments` 一律走双路径 OR：
`chargerId IN me OR customer.chargerId IN me`（`invoices` 因无 chargerId 字段是 customer.chargerId 单路径，等价退化形）。

这意味着 dump 出的 NDJSON 包含两类记录：

1. **业绩归属是我的**（`chargerId = me`）
2. **客户名下、但业绩属于历史经手人的**（`customer.chargerId = me AND chargerId ≠ me`）——客户从离职销售转过来后历史订单/商机/跟进/拜访/回款仍归原经手人。

任何"我的业绩 / 我的回款 / 我的订单 / 我的商机 / 我的跟进"聚合，**必须**显式按 `chargerId = me` 筛，不能直接 `SUM(可见全集)`：

✅ 正确：

```sql
SELECT SUM(CAST("orderAmount" AS DECIMAL(18,2)))
FROM sale_orders
WHERE "deletedAt" IS NULL AND "chargerId" = '<me-employee-id>';
```

❌ 错误（会把客户名下、归属于前任经手人的订单算进自己业绩）：

```sql
SELECT SUM(CAST("orderAmount" AS DECIMAL(18,2)))
FROM sale_orders
WHERE "deletedAt" IS NULL;
```

"我可见但不归我业绩"的差额可以单独分析（如"客户从谁手上转过来携带了多少历史业绩"），但**不应当混入业绩口径**。

> ADMIN 用户 chargerScope = null，dump 出来是全量；业绩排行/团队报表本就按 chargerId 字段聚合，无需特别处理。

#### § 4. opportunityStage 活跃过滤

枚举实际值（基于全量 1835 条分布，2026-05-10 校准）："赢单 / 输单流失 / 解决方案 / 发现需求 / 商务谈判 / 合同签约"。其中"赢单"和"输单流失"是终态，其余 4 个是活跃中。分析"活跃商机"统一写法：

```sql
WHERE "opportunityStage" NOT IN ('赢单','输单流失')
  AND "deletedAt" IS NULL
```

枚举值会随业务调整，第一次查前先 `SELECT DISTINCT "opportunityStage" FROM opportunities` 看看实际分布。

#### § 5. keepRecordType 枚举

常见值："电话 / 拜访 / 微信 / 邮件 / 见面 / 其他"。做"最近跟进时间"时用 `MAX("keepRecordTime"::TIMESTAMP)`，不用按类型分桶。

#### § 6. products 嵌套数组只在 `get` 返回，`list` 不含

`sale_orders` / `opportunities` 的 `products` 子数组在 `azeroth ... list --all` 时**可能为空**，要做"按产品维度全量分析"必须先 `list --all` 拿主表 id，再逐条 `get <id>`。遇 429 退避重试即可。

展开 products 的标准写法：

```sql
-- 展开 products 数组
SELECT
  o.id AS opp_id,
  unnest(o.products) AS p
FROM opportunities o
WHERE o."deletedAt" IS NULL;

-- 访问 struct 字段
SELECT p.productName, p.quantity FROM (
  SELECT unnest(products) AS p FROM opportunities
) t;
```

#### § 7. 精确回款额从 payments 聚合，不读 sale_orders 自带字段

`sale_orders.totalReceived` / `totalReceivables` 是缓存字段，**可能不准**。要精确金额必须从 payments 聚合：

```sql
SELECT "saleOrderId", SUM(CAST("paymentAmount" AS DECIMAL(18,2))) AS paid
FROM payments
WHERE "deletedAt" IS NULL
GROUP BY 1;
```

## 其他规范

- **查询分析默认只读**：用 `list` / `get` dump，再用本地 DuckDB 分析。
- **写操作允许但必须显式授权**：`create` / `update` / `delete` / `restore` 会真实修改业务系统；除用户明确要求外不要使用。
- **删除是软删除**：`delete <id>` 走业务系统软删除；需要恢复时用 `restore <id>`（仅标准 CRUD 实体支持）。
- **派生字段只读 + 关键写入必回查**：部分字段是后端聚合维护的**只读派生字段**，service 层从 update DTO 显式剔除、**写入静默丢弃（不报错，当没传）**——所以 `create`/`update` 返回成功 ≠ 该字段写进去了。已知只读派生字段：`customers.contactStatus` / `customers.dealStatus`、各类汇总缓存（`sale_orders.totalReceived/totalReceivables/totalUncollected`、`customers.lastKeepRecordTime/lastKeepRecordContent/accountsReceivable/paidAmountLast365Days`）。写这些纯属无效操作，别浪费在它们上。**任何关键写入（含 sales-action-items）做完，必 `azeroth <entity> get <id>` 回查**，确认目标字段确实落库、没被静默丢弃 / 没被乐观锁拒 / 没被去重 upsert 合并。
- **不在输出里泄露敏感字段**。薪资（`payroll`）、手机号、身份证、银行卡号等，呈现时做聚合或脱敏。
- **结果超 100 行加 `LIMIT 100`**，除非用户明确要全部。
- **最终分析输出禁止 `SELECT *`**，明确列出需要的字段，避免输出浪费；创建 NDJSON 临时视图时可以用 `SELECT * FROM read_json_auto(...)`。
- 出错不要盲目重试。先用 `azeroth describe <entity> --action <query|response|create|update>` 确认字段名和类型，再改命令或 SQL。

## 完整字段列表

见 [references/schema.md](references/schema.md)（按 CLI list 返回的 JSON 结构组织，TS 类型 + 说明）。

## 分析模板库

见 [references/templates.sql](references/templates.sql)（4 套可直接改参数跑的 DuckDB SQL）。

## 销售数据闭环手册

见 [references/sales-action-items.md](references/sales-action-items.md)：`sales_action_items` 读写（CLI 命令 / 字段含义 / 何时用 / admin-only 写权限）、缺口侦探查询模板（6 类硬缺口 + 进攻信号的 DuckDB SQL）、内容沉淀 4 闸、派生字段只读纪律、客户简称匹配纪律、内置别名表、跨销售归属疑点口径。**做缺口侦探 / 夜间写候选 / 处置待办前必读。**
