# 销售数据闭环 · sales_action_items 读写 + 缺口侦探查询手册

> 这是「销售数据闭环系统」的专用参考。开沿的销售**不再写日报**，改由一条夜间 cron fan-out 子 agent，借各销售钉钉 token 采集 + 读存量 CRM，产出两类东西写进 `sales_action_items` 待办表：
>
> - **进攻信号（今日作战）**：今天该推哪个商机、哪个客户在变冷、哪笔回款静默——帮销售赚钱。
> - **缺口侦探（数据待办 / 防御）**：交叉比对存量 CRM 发现的硬/软缺口——反向督办销售把 CRM 补全。
>
> **本系统最高红线（D1）**：任何 AI 抽取/补全**一律进 `sales_action_items` 候选、人工一键采纳才入库，绝不夜间直接写 CRM（连跟进记录也不行）**。补错跟进（写错客户）比"没补"更伤。命令层面 = 夜间脚本唯一允许的写命令是 `azeroth sales-action-items create`，**绝不调** `azeroth keep-records create` / `customers create` / `payments create` 等任何 CRM 写命令。

---

## 一、sales_action_items 是什么 / 何时用

| 维度        | 说明                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- |
| 表/实体     | `sales_action_items`（CLI 命令 `azeroth sales-action-items ...`，API `/api/v1/sales-action-items`） |
| 谁写        | **仅夜间 admin cron 的协调器**（用 admin PAT，ADMIN 角色）。`employeeId` = 收件销售本人             |
| 谁读/处置   | 销售在 azeroth 工作台两卡 + 独立列表页看自己的；艺萍/ADMIN 看全员（管理端），可转交待办             |
| 写权限      | **建单/修正/删除只给 admin 角色**；销售只能处置自己名下待办（见第六节 RBAC）                         |
| 何时 create | 夜间分析产出进攻 item / 防御缺口 / 内容沉淀候选时。普通用户日常问数据分析**不要碰这张表**           |

`category` 取值（建议 enum，以 `azeroth describe sales-action-items --action create` 为准）：

- **进攻类**：`FOLLOW_UP_DUE`（该跟进了）/ `DEAL_COOLING`（商机变冷）/ `PAYMENT_SILENT`（回款静默）/ `CUSTOMER_STALE`（大客户太久没联系）
- **防御类**：`GAP_HARD`（硬缺口，理直气壮督办）/ `GAP_SOFT`（软缺口，标"疑似"+证据+"请你判断"）/ `CONFLICT`（聊天 vs CRM 矛盾）/ `FILL_CONFIRM`（内容沉淀候选，过 4 闸可一键采纳写 keep_record）

关键字段（完整以 `describe` 为准）：

- `employeeId`：收件销售。夜间 admin cron `create` 时必须显式传目标销售 employeeId；销售本人视角走 `my/my-count`，后端强制当前登录员工。
- `priority`：0-100，列表 `ORDER BY priority DESC`（不截断数量）
- `refType` / `refId`：关联对象（`Opportunity` / `Customer` / `KeepRecord`）+ 其 id
- `title` / `reason`（**「为什么提醒你」一句话，必须含具体数字**，如"距上次跟进 37 天"）/ `suggestedAction`
- `confidence`：`HIGH`（硬缺口/高置信）/ `MEDIUM`（软缺口，必须降级"请你判断"）
- `aiDraft`（Json）：采纳草稿。**`FILL_CONFIRM` 想被一键采纳，必须含** `kind='keep_record'` + `matchMode='FULL_NAME_EXPLICIT'` + `matchedCustomerId` + `matchedFullName` + `evidenceMessageId` + `payload.customerId/keepRecordType/keepRecordContent/keepRecordTime`（D6 后端强校验，缺则只能"去补充"不能"采纳"）
- `evidence`（Json 数组）：证据原文数组，四来源（**CRM 交叉比对 `[{type:'crm',table,refId,excerpt,recordedAt}]`——缺口侦探主来源，商机逾期/应收静默/赢单无跟进等必用此 type** / 钉钉引文 `{type:'dingtalk_msg',conversationTitle,sender,sentAt,excerpt,msgId}` / 文档 / 日程）
- `dedupKey`：去重键。后端有 partial unique index `(employee_id, dedup_key) WHERE status IN ('pending','snoozed')`，重复 create 会被 upsert 防重，**dedupKey 要稳定**（同一缺口跨天同 key）
- `status`：`pending` / `adopted` / `done` / `ignored` / `snoozed` / `auto_expired`
- `resolveNote`：ignore 时**必填理由**（D7，喂回 Agent 降权）
- `sourceRunId`：哪批夜间 run（回滚/排查用）

> 这张表是**夜间缺口侦探 + 晨间作战简报共用**的单表，进攻/防御靠 `category` 区分，不分两张表。

---

## 二、CLI 命令清单（命令名逐字来自后端 `@Controller('sales-action-items')`）

`SalesActionItem` 经 CLI schema-driven 自动发现派生为命令组 `sales-action-items`，API 路径 `/api/v1/sales-action-items`（见勘察 06）。

### 2.1 标准 CRUD（shared 四件套自动派生，无需改 CLI）

```bash
azeroth sales-action-items list   [filters...]        # GET  /sales-action-items（分页 + schema filter + --all 翻页）
azeroth sales-action-items get    <id>                # GET  /sales-action-items/:id
azeroth sales-action-items create --json -            # POST /sales-action-items（夜间写候选；见 2.3）
azeroth sales-action-items update <id> --field v --version <n>   # PUT /sales-action-items/:id（乐观锁）
azeroth sales-action-items delete <id>                # DELETE /sales-action-items/:id（软删除）
```

> 无 `restore` / `submit-approval` / `claim`（新表不进任何白名单，符合预期——待办表用不到审批/认领）。

### 2.2 非标 action 命令（后端额外路由，CLI 已手挂）

这些**不是**标准 CRUD 自动派生的命令，对应后端 controller 的专用路由。上线/刷新 bundle 后先跑 `azeroth sales-action-items --help` 确认当前环境已包含这些子命令。

```bash
# 销售本人视角（后端强制 employeeId = 当前登录身份，看不到别人的）
azeroth sales-action-items my [--status pending] [--category GAP_HARD] [--page-size 100]
azeroth sales-action-items my-count [--category GAP_HARD]              # GET /sales-action-items/my/count（铃铛角标用）

# 处置动作（POST /sales-action-items/:id/{action}）。后端校验状态/权限/并发，CLI 只传正确 body
azeroth sales-action-items adopt  <id>                                 # 采纳：仅 FILL_CONFIRM + 过 D6 强校验，转写 keep_record
azeroth sales-action-items ignore <id> --resolve-note "理由"           # 忽略：resolveNote 必填，喂回 Agent 降权
azeroth sales-action-items done   <id> --done-type progressed --resolve-note "已电话推进"  # 标记已办
azeroth sales-action-items done   <id> --json <file>                   # 可带 keepRecord；doneType=follow_recorded 时必填
azeroth sales-action-items transfer <id> --target-employee-id <uuid> --reason "转交原因" # 管理端转交
azeroth sales-action-items reopen <id>                                 # done → pending，不触碰采纳生成的 CRM 记录
azeroth sales-action-items undo   <id>                                 # adopted → pending，并软删本次采纳生成的 keep_record

# 管理端（仅艺萍/ADMIN，看全员）
azeroth sales-action-items list --source-run-id <id> --status <s>        # GET / 管理端筛 sourceRunId/status
```

> **采纳的正确姿势**：前端/CLI 走 `azeroth sales-action-items adopt <id>` / `POST /:id/adopt`，由后端复用 `KeepRecordsService.create()` 写跟进记录。**绝不在 agent/前端直接 `azeroth keep-records create`**（绕过 D6 强校验和业务规则），也不要用 `update --status adopted` 伪装采纳——标准 update schema 本来也不接受 `status` 字段，且不会触发写 CRM。
>
> **转交的正确姿势**：管理端走 `transfer <id>`，body 是 `{ targetEmployeeId, reason }`；销售本人不要用 update 改 `employeeId` 伪装转交，标准 update 虽可能接受 employeeId，但不会留下转交语义与原因。

### 2.3 夜间脚本写候选的标准形态（`create --json -`）

字段多、含中文/钉钉证据原文 → 用 `--json -`（stdin heredoc）最干净，避开 shell 转义地狱。先 `--dry-run` 自检 body，再正式写。

```bash
# 会话首次：确保 CLI 最新（拿到刚部署的新表 schema）。刚部署过务必 FORCE 刷绕过 1h TTL
KY_DATA_QUERY_SKILL_DIR="<当前 ky-data-query skill 目录>"
AZEROTH_CLI_FORCE=1 source "$KY_DATA_QUERY_SKILL_DIR/scripts/ensure-cli.sh"
azeroth describe sales-action-items --action create    # 拿权威字段表，别猜字段

# 写一条硬缺口督办（防御 / GAP_HARD）
azeroth sales-action-items create --json - <<'JSON'
{
  "employeeId": "<sales-employee-uuid>",
  "category": "GAP_HARD",
  "priority": 80,
  "refType": "Customer",
  "refId": "<customer-uuid>",
  "title": "S级客户「泉州市鲤城区人民法院」37天无跟进",
  "reason": "lastKeepRecordTime=2026-04-23，距今37天>30天阈值，dealStatus=未赢单",
  "suggestedAction": "本周内安排一次拜访或电话回访",
  "confidence": "HIGH",
  "dedupKey": "GAP_HARD:customer:<customer-uuid>:stale30",
  "evidence": [
    {
      "type": "crm",
      "table": "customer",
      "refId": "<customer-uuid>",
      "excerpt": "lastKeepRecordTime=2026-04-23，距今37天>30天阈值，dealStatus=未赢单",
      "recordedAt": "2026-04-23T10:00:00+08:00"
    }
  ],
  "sourceRunId": "<run-id>"
}
JSON

# 写一条内容沉淀候选（FILL_CONFIRM，过 4 闸才给采纳草稿）
azeroth sales-action-items create --json - <<'JSON'
{
  "employeeId": "<sales-employee-uuid>",
  "category": "FILL_CONFIRM",
  "priority": 60,
  "refType": "Customer",
  "refId": "<customer-uuid>",
  "title": "群内确认签约，建议补一条跟进记录",
  "reason": "「华恒项目群」05-29 客户明确说本周签约，CRM 近7天无对应跟进",
  "confidence": "MEDIUM",
  "dedupKey": "FILL_CONFIRM:keep:<customer-uuid>:m001",
  "aiDraft": {
    "kind": "keep_record",
    "matchMode": "FULL_NAME_EXPLICIT",
    "matchedCustomerId": "<customer-uuid>",
    "matchedFullName": "泉州华恒精密机械有限公司",
    "evidenceMessageId": "dingtalk-msg-001",
    "payload": {
      "customerId": "<customer-uuid>",
      "keepRecordType": "微信",
      "keepRecordContent": "客户确认本周签约，下周一签合同",
      "keepRecordTime": "2026-05-29T10:30:00+08:00"
    }
  },
  "evidence": [
    {
      "type": "dingtalk_msg",
      "conversationTitle": "华恒项目群",
      "sender": "陈育新",
      "sentAt": "2026-05-29T10:30:00+08:00",
      "excerpt": "客户确认本周签约，下周一签合同",
      "msgId": "dingtalk-msg-001"
    }
  ],
  "sourceRunId": "<run-id>"
}
JSON
```

要点：

- `--json -` 从 stdin 读，顶层必须 JSON 对象；嵌套对象（aiDraft/evidence）直接写进 JSON 即可（也可用 `--<field>-json <path>` 单独喂）。
- 批量写多条：脚本循环逐条 `create --json -`（标准 CRUD 无 batch-create）。
- **写入后必 `get <id>` 回查**（见第五节派生字段静默丢弃纪律）——确认 dedup 没被 upsert 合并、关键字段（aiDraft.matchMode 等）确实落库。

---

## 三、缺口侦探查询模板（硬缺口 / 软缺口）

> **硬缺口（`confidence=HIGH`，理直气壮督办）= 交叉比对存量 CRM 确定的**；**软缺口（`confidence=MEDIUM`，标"疑似"+附证据原文+降级"请你判断"）= 从钉钉聊天推测的**。**乱督办比不督办更伤信任**——拿不准一律降级软缺口或不报。
>
> 下列模板用 DuckDB SQL（dump NDJSON 后跑）。先按本 skill 三步法 dump，**字段名/枚举以 `azeroth describe` 实时为准**。所有 SQL 必走自检清单（软删除过滤 / CAST / UTC→Shanghai / chargerId=employees.id）。

### 通用前置

```sql
-- 建视图（路径换成本次 $SESS 实际目录）
CREATE OR REPLACE VIEW customers     AS SELECT * FROM read_json_auto('$SESS/customers.ndjson',     format='newline_delimited');
CREATE OR REPLACE VIEW keep_records  AS SELECT * FROM read_json_auto('$SESS/keep_records.ndjson',  format='newline_delimited');
CREATE OR REPLACE VIEW visit_records AS SELECT * FROM read_json_auto('$SESS/visit_records.ndjson', format='newline_delimited');
CREATE OR REPLACE VIEW opportunities AS SELECT * FROM read_json_auto('$SESS/opportunities.ndjson', format='newline_delimited');
CREATE OR REPLACE VIEW sale_orders   AS SELECT * FROM read_json_auto('$SESS/sale_orders.ndjson',   format='newline_delimited');
CREATE OR REPLACE VIEW payments      AS SELECT * FROM read_json_auto('$SESS/payments.ndjson',      format='newline_delimited');
CREATE OR REPLACE VIEW invoices      AS SELECT * FROM read_json_auto('$SESS/invoices.ndjson',      format='newline_delimited');
```

> **缺口口径核心（艺萍业务规则，一条不丢）**：判"有无跟进动作"必须**同查 `keep_records` + `visit_records` 两表**。有拜访签到=当天外出，若有新进展（新对接人/新需求/新规划/谈判报价/推进签约）→ 必配跟进、只签到=缺口；**纯培训/配置交付/搭建/实施/组织架构配置且无新进展 → 豁免不算缺口**。判"有无跟进"**别挑 keepRecordType**（有 12 种中英脏值 phone/电话/wechat/微信/visit/拜访/dingtalk/other/null…），先以 **时间 + customerId + content + visit_records 存在性** 判断，类型仅辅助。

### 硬缺口 1：赢单商机无签约跟进

赢单商机（`opportunityStage='赢单'`）但近期无对应客户跟进 → 该补签约后跟进。

```sql
-- 赢单商机，但其客户近 14 天无 keep/visit
WITH won_opp AS (
  SELECT o.id AS opp_id, o."opportunityName", o."customerId", o."chargerId", o."realDealDate"
  FROM opportunities o
  WHERE o."deletedAt" IS NULL
    AND o."opportunityStage" = '赢单'              -- 终态：已赢单
    AND o."chargerId" = '<me-employee-id>'         -- 业绩归我（不按可见性）
),
recent_touch AS (
  SELECT "customerId", MAX("keepRecordTime"::TIMESTAMP) AS last_keep
  FROM keep_records WHERE "deletedAt" IS NULL GROUP BY 1
),
recent_visit AS (
  SELECT "customerId", MAX("signInTime"::TIMESTAMP) AS last_visit   -- visit_records 用 signInTime（无 visitTime 字段，以 describe 为准）
  FROM visit_records WHERE "deletedAt" IS NULL GROUP BY 1
)
SELECT w.opp_id, w."opportunityName", w."customerId",
       rt.last_keep, rv.last_visit
FROM won_opp w
LEFT JOIN recent_touch rt ON rt."customerId" = w."customerId"
LEFT JOIN recent_visit rv ON rv."customerId" = w."customerId"
WHERE COALESCE(GREATEST(rt.last_keep, rv.last_visit), TIMESTAMP '1970-01-01')
      < (NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '14 days'
LIMIT 100;
```

### 硬缺口 2：大额回款无关联订单

大额回款（payment）`saleOrderId` 为空或指向不存在/无效订单 → 回款未挂订单。

```sql
SELECT p.id AS payment_id, p."paymentAmount", p."customerId", p."saleOrderId", p."businessDate"
FROM payments p
LEFT JOIN sale_orders s ON s.id = p."saleOrderId" AND s."deletedAt" IS NULL
WHERE p."deletedAt" IS NULL
  AND p."direction" = 'IN'                         -- 仅进项（OUT 是退款，describe 确认有 direction 字段）
  AND p."chargerId" = '<me-employee-id>'
  AND CAST(p."paymentAmount" AS DECIMAL(18,2)) >= 50000   -- 大额阈值按业务定
  AND (p."saleOrderId" IS NULL OR s.id IS NULL)
LIMIT 100;
```

### 硬缺口 3：已开票 ≠ 回款金额

某订单累计开票额与累计回款额不匹配（开票多于回款 = 应收未到账）。

```sql
WITH inv AS (
  SELECT "saleOrderId", SUM(CAST("invoiceAmount" AS DECIMAL(18,2))) AS invoiced
  FROM invoices WHERE "deletedAt" IS NULL GROUP BY 1
),
pay AS (   -- 净回款：IN 为正、OUT 退款为负（不读 sale_orders 缓存字段）
  SELECT "saleOrderId",
         SUM(CASE WHEN "direction"='OUT' THEN -CAST("paymentAmount" AS DECIMAL(18,2))
                  ELSE CAST("paymentAmount" AS DECIMAL(18,2)) END) AS paid
  FROM payments WHERE "deletedAt" IS NULL GROUP BY 1
)
SELECT s.id AS sale_order_id, s."serialNumber", s."customerId",
       COALESCE(inv.invoiced,0) AS invoiced, COALESCE(pay.paid,0) AS paid,
       COALESCE(inv.invoiced,0) - COALESCE(pay.paid,0) AS gap
FROM sale_orders s
LEFT JOIN inv ON inv."saleOrderId" = s.id
LEFT JOIN pay ON pay."saleOrderId" = s.id
WHERE s."deletedAt" IS NULL
  AND s."chargerId" = '<me-employee-id>'
  AND COALESCE(inv.invoiced,0) - COALESCE(pay.paid,0) > 0   -- 开票>回款
ORDER BY gap DESC LIMIT 100;
```

### 硬缺口 4：客户 lastKeepRecordTime > 30 天（睡眠客户）

对标后端 `getSleeping`（阈值本系统改 **30 天**；终态客户豁免）。

```sql
SELECT c.id AS customer_id, c."customerName", c."customerLevel",
       c."lastKeepRecordTime", c."dealStatus",
       DATE_DIFF('day', c."lastKeepRecordTime"::TIMESTAMP, NOW() AT TIME ZONE 'Asia/Shanghai') AS days_since
FROM customers c
WHERE c."deletedAt" IS NULL
  AND c."chargerId" = '<me-employee-id>'
  AND c."dealStatus" NOT IN ('已赢单','多次赢单')      -- 终态豁免（WON / MULTI_WON）
  AND (c."lastKeepRecordTime" IS NULL
       OR c."lastKeepRecordTime"::TIMESTAMP < (NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '30 days')
ORDER BY c."lastKeepRecordTime" ASC NULLS FIRST   -- 从未跟进的排最前
LIMIT 100;
```

### 硬缺口 5：商机 expectedDealDate 已过未成交未改期

活跃商机预计成交日已过，仍未赢单/未改期 → 该推进或改期。

```sql
SELECT o.id AS opp_id, o."opportunityName", o."customerId",
       o."opportunityStage", o."expectedDealDate", o."opportunityAmount"
FROM opportunities o
WHERE o."deletedAt" IS NULL
  AND o."chargerId" = '<me-employee-id>'
  AND o."opportunityStage" NOT IN ('赢单','输单流失')        -- 仍活跃
  AND o."expectedDealDate" IS NOT NULL
  AND o."expectedDealDate"::DATE < (NOW() AT TIME ZONE 'Asia/Shanghai')::DATE
ORDER BY o."expectedDealDate" ASC LIMIT 100;
```

### 硬缺口 6 / 进攻 PAYMENT_SILENT：近 N 天无 IN 回款

某活跃订单/客户近 N 天无任何 `direction='IN'` 回款 → 回款静默，该催。

```sql
WITH last_in AS (
  SELECT "customerId", MAX("businessDate"::DATE) AS last_in_date
  FROM payments
  WHERE "deletedAt" IS NULL AND "direction" = 'IN'
  GROUP BY 1
)
SELECT c.id AS customer_id, c."customerName", li.last_in_date,
       DATE_DIFF('day', li.last_in_date, (NOW() AT TIME ZONE 'Asia/Shanghai')::DATE) AS days_no_in
FROM customers c
LEFT JOIN last_in li ON li."customerId" = c.id
WHERE c."deletedAt" IS NULL
  AND c."chargerId" = '<me-employee-id>'
  AND c."accountsReceivable" > 0                              -- 有应收
  AND (li.last_in_date IS NULL OR li.last_in_date < (NOW() AT TIME ZONE 'Asia/Shanghai')::DATE - 30)
ORDER BY days_no_in DESC NULLS FIRST LIMIT 100;
```

### 进攻 DEAL_COOLING：商机变冷

活跃商机但客户近期跟进频率骤降（如上次跟进 > 7 天且商机金额大）→ 在变冷，今天该推。

```sql
WITH last_keep AS (
  SELECT "customerId", MAX("keepRecordTime"::TIMESTAMP) AS last_keep
  FROM keep_records WHERE "deletedAt" IS NULL GROUP BY 1
)
SELECT o.id AS opp_id, o."opportunityName", o."customerId",
       o."opportunityStage", o."opportunityAmount", lk.last_keep,
       DATE_DIFF('day', lk.last_keep, NOW() AT TIME ZONE 'Asia/Shanghai') AS days_since_keep
FROM opportunities o
LEFT JOIN last_keep lk ON lk."customerId" = o."customerId"
WHERE o."deletedAt" IS NULL
  AND o."chargerId" = '<me-employee-id>'
  AND o."opportunityStage" NOT IN ('赢单','输单流失')
  AND (lk.last_keep IS NULL OR lk.last_keep < (NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '7 days')
ORDER BY CAST(o."opportunityAmount" AS DECIMAL(18,2)) DESC NULLS LAST LIMIT 100;
```

### 软缺口（只从钉钉聊天推测，必降级）

软缺口**不在 CRM SQL 里产生**，而是 LLM 读清理版钉钉聊天后推测：

- 疑似新需求未建商机 / 疑似要签约 / 疑似该进下一阶段。
- 一律 `confidence=MEDIUM`、title/reason 带"疑似"、`evidence` 附消息原文（会话+时间+发送人，清理版无 msgId）、`suggestedAction` 用"请你判断/确认"措辞。
- 写之前过**内容沉淀 4 闸**（见第四节），缺一闸 → 降级为纯待办（不给 `aiDraft` 采纳草稿）。

### 不算缺口（一律不报，避免沦为被无视的日报）

已有跟进、纯培训/配置交付/日常配置维护/搭建实施/组织架构配置（无新进展）、商机已搁置、已读未回/电话未接、**仅知识库建档（金友德类，见别名表）**、归属错位中协作人只做配置交付（非销售动作）。

> **数据坑（影响缺口判断准确性，务必避开）**：
>
> - `dingtalk_logs` 先跑水位检查 `SELECT MAX("syncedAt") FROM dingtalk_logs`——距今 >1 天不轻判"未提交"。reportType 中英混用，同时匹配 `daily` 和 `日报`。
> - `payments.chargerName` 4 月起大量为空 → 按 chargerId 关联，别靠 chargerName。
> - `orderStatus` 实为"退款状态"语义不可靠 → 未回款必靠 payments 净额聚合（IN 正 / OUT 负），不读 sale_orders 缓存字段 totalReceived/totalReceivables。
> - `keepRecordType` 12 种脏值 → 判"有无跟进"别挑 type（见上）。

---

## 四、内容沉淀 4 闸（FILL_CONFIRM 候选写入前核验，缺一降级）

候选要带 `aiDraft` 采纳草稿（让销售一键采纳写 keep_record），必须**同时**满足 4 闸，否则降级为纯待办（去掉 aiDraft、改 `suggestedAction` 引导"去补充"）：

1. **客户唯一且全称明确点到**（D6）：客户在 azeroth 唯一匹配，且**全称在群名/消息被明确点到**（不是靠简称推断）。
2. **负责人 employeeId 明确**。
3. **事实来自明确消息原文**（evidence 有会话+时间+发送人+原文摘录溯源；清理版无 msgId）。
4. **近 7 天 keep_records 无高度重复**（不重复补同一条）。

满足 4 闸 → `aiDraft.kind='keep_record'` + `matchMode='FULL_NAME_EXPLICIT'` + matchedCustomerId/matchedFullName/evidenceMessageId + `payload.customerId/keepRecordType/keepRecordContent/keepRecordTime`（后端 adopt 强校验这套，是"防写错客户"的最后机器闸门）。

---

## 五、派生字段只读 + 关键写入后回查（铁律）

azeroth 多张表有**只读派生字段**——service 层从 update DTO 显式剔除、写入静默丢弃（不报错，直接当没传）。代表：

- `customers.contactStatus` / `customers.dealStatus`（`customers.service.ts` 里 `const { contactStatus: _contactStatus, dealStatus: _dealStatus, ... } = dto` 解构丢弃）
- 各类汇总缓存字段（`sale_orders.totalReceived/totalReceivables/totalUncollected`、`customers.lastKeepRecordTime/lastKeepRecordContent/accountsReceivable/paidAmountLast365Days`）——由后端聚合维护，不接受外部写。

后果与纪律：

- **写这些字段不会报错，会被静默丢弃**——所以"命令返回成功"≠"字段写进去了"。
- **任何关键写入后必 `azeroth <entity> get <id>` 回查**，确认想写的字段确实落库、没被静默丢弃 / 没被乐观锁拒 / 没被 dedup upsert 合并。
- 这条对 `sales_action_items` 同样适用：create 可能被 dedupKey 命中合并、采纳后会派生写 keep_record 并回填 resultId——都靠 get 回查确认。

---

## 六、结构性写入只给 admin（RBAC，别人 token 调写 → 403）

- `sales_action_items` 的**建单/修正/删除**（create/update/delete）只授予 **admin 角色**。夜间 cron 用 admin PAT（ADMIN 角色）写。
- **销售本人 token 只有读 + 处置自己待办的权限**（my/get/adopt/ignore/done/reopen/undo 受 RBAC + 数据范围限定在 `employeeId=自己`）；管理端才做 `transfer` 转交；**调 `create` 写候选 → 403**（azeroth RBAC 拦截，预期行为，不是 bug）。
- 普通用户/分析师 token 调 `sales-action-items create/update` 也 **403**。
- **403 是预期行为**：说明当前身份在 azeroth 内没有该写权限。**不要尝试升权 / 换账号 / 用 admin 绕过**——告诉用户即可。只有夜间 admin cron 链路才建/改/删这张表。
- 这是"ky-data-query 写扩散"的防线：靠 azeroth RBAC 约束，不做专门 coordinator token（内部工具）。

---

## 七、客户简称匹配纪律（5/12 踩坑，禁直接 LIKE）

把钉钉聊天里的简称/口语称呼匹配到 CRM 客户**全称**时，**禁止直接 `LIKE '%简称%'`**（简称会误命中无关客户、或漏掉真正的全称客户）。正确顺序：

1. **先按销售 chargerId 拉名下全部客户全称**（`customers WHERE chargerId='<me>' AND deletedAt IS NULL`）。
2. **在名下客户里做语义匹配**（简称→全称，结合别名表）。
3. **名下没匹配上，再全表查**（识别"归属错位"——事实客户的 chargerId ≠ 当事销售）。
4. **匹配不唯一 / 拿不准 → 一律降级**（软缺口或纯待办，不给采纳草稿），绝不据简称推断写系统。

```sql
-- 第 1 步：先拉该销售名下全称，缩小匹配域
SELECT id, "customerName", "shortName" FROM customers
WHERE "deletedAt" IS NULL AND "chargerId" = '<me-employee-id>';
-- 再在内存/LLM 里按 customerName/shortName + 别名表做语义匹配，不要 LIKE '%简称%'
```

---

## 八、内置别名表（艺萍维护口径，匹配简称时必查）

聊天里这些简称/口语称呼对应的 CRM 客户全称（括号内为负责销售）。**别名表里的，按对应全称匹配，不要按字面 LIKE**：

| 聊天里的称呼 | CRM 客户全称             | 负责销售 | 备注 / 匹配提示                                                         |
| ------------ | ------------------------ | -------- | ----------------------------------------------------------------------- |
| 鲤城法院     | 泉州市鲤城区人民法院     | 黄思霖   |                                                                         |
| 中院         | 福建省泉州市中级人民法院 | 陈育新   |                                                                         |
| 永春公安     | 永春县公安局             | 陈育新   | 匹配用 `LIKE '%永春%公安%'`（两段式，不是整词）                         |
| 启垚         | 不忘初心                 | —        | 简称与全称字面无关，必靠别名表                                          |
| 乾泰家具     | 米恩网络                 | —        | 简称与全称字面无关，必靠别名表                                          |
| 巨将         | 泉州市巨将防盗设备       | —        |                                                                         |
| 金友德（类） | （无对应 CRM 客户）      | —        | **仅钉钉知识库建档，不是 CRM 缺口**——出现金友德类内容不报缺口、不建候选 |

注意：

- 别名表**短期是配置/提示语硬编码**（本表），中期应做成 `customer_aliases` 表由艺萍维护（硬编码会随业务漂移）。
- 用别名匹配出全称后，仍要回到第七节流程：在该销售名下客户里确认唯一全称，再决定是否写候选。
- **金友德类是负向规则**：明确"仅知识库、非 CRM 缺口"，遇到就豁免，别误报成"客户未建档"缺口。

---

## 九、跨销售归属疑点（只给艺萍，不发销售本人）

夜间分析发现聊天/日报里的事实客户，其 CRM 归属（chargerId）≠ 当事销售时：

- 列「客户全称｜来源｜CRM 当前归属｜动作摘要」**作为 `ownership_suspect` 类只发艺萍/ADMIN，绝不发销售本人**，**只列事实不判归谁**，**禁止自动改 employeeId**。
- 主销售 + 配置协作场景：协作人只做配置/交付**不算错位**；只有协作人做了**销售动作**（推进/谈判/报价）才标疑点。
- 所有"监督性"产出（归属疑点、排行榜、末位、采纳率）只发艺萍/曾磊，销售端只看"帮手"不看"考核"（D9）。
