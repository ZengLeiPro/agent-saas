-- =============================================================
-- ky-data-query DuckDB 分析模板库（4 套）
--
-- 使用步骤：
--   1. 用 `azeroth <entity> list --all --output $SESS/<file>.ndjson` dump 好数据
--   2. 复制本文件对应模板内容到 $SESS/q.sql
--   3. 按注释替换查询参数（__REPLACE_*__ 占位符、时间窗口等）
--   4. 贴给用户 review，得到默许后：`duckdb -c ".read $SESS/q.sql"`
--
-- 共用约定：
--   - 所有时间字段按 UTC→Asia/Shanghai 转换后再按日聚合
--   - 所有金额统一 CAST AS DECIMAL(18,2)
--   - 所有业务表加 WHERE "deletedAt" IS NULL
--   - array_agg 必须显式 ORDER BY
--
-- session 路径：从 shell env $SESS 读取（dump 步骤已 export）。
-- 如果 duckdb 报 "Missing variable 'sess'"，先在 shell 跑：
--   export SESS="$(pwd)/.cache/azq/<your-session>"
-- 再 .read 本文件。
-- 注：必须落 cwd 内（.cache/azq），不要用 /tmp 或 $TMPDIR——
-- 前者非 admin 沙箱 EPERM，后者 Write 工具白名单不含。
SET VARIABLE sess = getenv('SESS');

-- 全局时区固定到 Shanghai，让所有 NOW()/隐式 TIMESTAMPTZ↔TIMESTAMP 比较都按 +08:00 解读。
-- 配合下方各 CTE 的 "AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'" 转换，
-- 跨字段比较不会出现 8h 偏差。
SET TimeZone = 'Asia/Shanghai';

-- =============================================================
-- 通用：注册 NDJSON 为视图
-- 注意：DuckDB 创建 view 时就会检查文件是否存在。只保留本次已 dump 文件对应的视图；
-- 如果没有 dump 某个文件，必须删除或注释对应 CREATE VIEW。
-- =============================================================

CREATE OR REPLACE VIEW customers AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/customers.ndjson', format='newline_delimited');

CREATE OR REPLACE VIEW opportunities AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/opportunities.ndjson', format='newline_delimited');

CREATE OR REPLACE VIEW sale_orders AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/sale_orders.ndjson', format='newline_delimited');

CREATE OR REPLACE VIEW payments AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/payments.ndjson', format='newline_delimited');

CREATE OR REPLACE VIEW keep_records AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/keep_records.ndjson', format='newline_delimited');

CREATE OR REPLACE VIEW visit_records AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/visit_records.ndjson', format='newline_delimited');

CREATE OR REPLACE VIEW contacts AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/contacts.ndjson', format='newline_delimited');

CREATE OR REPLACE VIEW invoices AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/invoices.ndjson', format='newline_delimited');

CREATE OR REPLACE VIEW crm_work_dailies AS
  SELECT * FROM read_json_auto(getvariable('sess') || '/crm_work_dailies.ndjson', format='newline_delimited');

-- 若报 "conversion error"（某字段类型推断不稳），回退到显式 schema 版：
-- SELECT * FROM read_json('...', format='newline_delimited', columns={id:'VARCHAR', products:'JSON', ...});


-- =============================================================
-- 模板 A：客户全貌
-- ----------------------------------------------------
-- 用途：一行 = 一个客户，聚合其所有商机/订单/回款/跟进/拜访为 JSON 数组。
-- 适用场景："查一下 XX 客户的情况"、"XX 客户最近怎么样"。
-- 输入：customers.ndjson, opportunities.ndjson, sale_orders.ndjson,
--       payments.ndjson, keep_records.ndjson, visit_records.ndjson
-- 输出字段：
--   - 基本信息：id, serialNumber, customerName, industry, customerLevel, chargerName, ...
--   - 汇总：opportunity_count, total_opportunity_amount, order_count,
--           total_order_amount, total_paid, follow_up_count, visit_count
--   - 明细 JSON：opportunities[], sale_orders[], payments[],
--                follow_ups[], visits[]
--   - 派生：days_since_last_follow_up（距最近跟进天数）
--
-- 用户替换：第 ??? 行的 customerName LIKE 关键词
-- =============================================================

WITH opp_agg AS (
  SELECT
    "customerId",
    COUNT(*) AS opportunity_count,
    SUM(CASE WHEN "opportunityStage" NOT IN ('赢单','输单流失') THEN 1 ELSE 0 END) AS active_opp_count,
    COALESCE(SUM(CAST("opportunityAmount" AS DECIMAL(18,2))), 0) AS total_opportunity_amount,
    array_agg(struct_pack(
      name       := "opportunityName",
      stage      := "opportunityStage",
      amount     := CAST("opportunityAmount" AS DECIMAL(18,2)),
      winRate    := "winRate",
      expectedAt := "expectedDealDate",
      realDealAt := "realDealDate",
      charger    := "chargerName"
    ) ORDER BY "createdAt"::TIMESTAMP DESC) AS opportunities_json
  FROM opportunities
  WHERE "deletedAt" IS NULL
  GROUP BY "customerId"
),
order_agg AS (
  SELECT
    "customerId",
    COUNT(*) AS order_count,
    COALESCE(SUM(CAST("orderAmount" AS DECIMAL(18,2))), 0) AS total_order_amount,
    array_agg(struct_pack(
      title        := "orderTitle",
      serialNumber := "serialNumber",
      amount       := CAST("orderAmount" AS DECIMAL(18,2)),
      status       := "orderStatus",
      businessDate := "businessDate",
      charger      := "chargerName"
    ) ORDER BY "createdAt"::TIMESTAMP DESC) AS orders_json
  FROM sale_orders
  WHERE "deletedAt" IS NULL
  GROUP BY "customerId"
),
payment_agg AS (
  SELECT
    "customerId",
    COALESCE(SUM(CAST("paymentAmount" AS DECIMAL(18,2))), 0) AS total_paid,
    COUNT(*) AS payment_count,
    array_agg(struct_pack(
      amount  := CAST("paymentAmount" AS DECIMAL(18,2)),
      type    := "paymentType",
      date    := "businessDate",
      payer   := payer,
      charger := "chargerName"
    ) ORDER BY "businessDate"::TIMESTAMP DESC NULLS LAST) AS payments_json
  FROM payments
  WHERE "deletedAt" IS NULL
  GROUP BY "customerId"
),
follow_agg AS (
  SELECT
    "customerId",
    COUNT(*) AS follow_up_count,
    -- 转 Shanghai naive，方便跟 NOW(Shanghai) 做 date_diff
    MAX("keepRecordTime"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::TIMESTAMP AS last_follow_up_at,
    array_agg(struct_pack(
      time    := "keepRecordTime",
      type    := "keepRecordType",
      content := "keepRecordContent",
      charger := "chargerName"
    ) ORDER BY "keepRecordTime"::TIMESTAMP DESC NULLS LAST) AS follow_ups_json
  FROM keep_records
  WHERE "deletedAt" IS NULL
  GROUP BY "customerId"
),
visit_agg AS (
  SELECT
    "customerId",
    COUNT(*) AS visit_count,
    array_agg(struct_pack(
      signInTime := "signInTime",
      type       := "visitType",
      content    := content,
      address    := "signAddress",
      duration   := duration
    ) ORDER BY "signInTime"::TIMESTAMP DESC NULLS LAST) AS visits_json
  FROM visit_records
  WHERE "deletedAt" IS NULL
  GROUP BY "customerId"
)
SELECT
  c.id,
  c."serialNumber",
  c."customerName",
  c.industry,
  c."customerLevel",
  c."chargerName",
  c."contactStatus",
  c."dealStatus",
  c."lastKeepRecordTime",
  c."lastKeepRecordContent",
  CAST(c."paidAmountLast365Days" AS DECIMAL(18,2)) AS paid_last_365d,
  CAST(c."accountsReceivable"    AS DECIMAL(18,2)) AS accounts_receivable,
  -- 汇总
  COALESCE(oa.opportunity_count, 0)        AS opportunity_count,
  COALESCE(oa.active_opp_count, 0)         AS active_opportunity_count,
  COALESCE(oa.total_opportunity_amount, 0) AS total_opportunity_amount,
  COALESCE(sa.order_count, 0)              AS order_count,
  COALESCE(sa.total_order_amount, 0)       AS total_order_amount,
  COALESCE(pa.total_paid, 0)               AS total_paid,
  COALESCE(pa.payment_count, 0)            AS payment_count,
  COALESCE(fa.follow_up_count, 0)          AS follow_up_count,
  COALESCE(va.visit_count, 0)              AS visit_count,
  -- 派生：距最近跟进天数（NOW 转 Shanghai 与 dump 字段 timezone 对齐）
  CASE WHEN fa.last_follow_up_at IS NULL THEN NULL
       ELSE date_diff('day',
                      fa.last_follow_up_at,
                      (NOW() AT TIME ZONE 'Asia/Shanghai')::TIMESTAMP)
  END AS days_since_last_follow_up,
  -- 明细
  oa.opportunities_json,
  sa.orders_json,
  pa.payments_json,
  fa.follow_ups_json,
  va.visits_json
FROM customers c
LEFT JOIN opp_agg     oa ON oa."customerId" = c.id
LEFT JOIN order_agg   sa ON sa."customerId" = c.id
LEFT JOIN payment_agg pa ON pa."customerId" = c.id
LEFT JOIN follow_agg  fa ON fa."customerId" = c.id
LEFT JOIN visit_agg   va ON va."customerId" = c.id
WHERE c."deletedAt" IS NULL
  -- 【必改参数】__REPLACE_KEYWORD__ 替换为客户名关键词（如 '福宠'、'师院'）；
  -- 想查全部注释此行（注意：不替换会返回 0 行，因为没有客户名含字面值 __REPLACE_KEYWORD__）
  AND c."customerName" LIKE '%__REPLACE_KEYWORD__%'
ORDER BY total_order_amount DESC
LIMIT 20;


-- =============================================================
-- 模板 B：销售业绩排行
-- ----------------------------------------------------
-- 用途：按 chargerId 聚合销售员：客户数/商机额/订单额/回款率/跟进/拜访。
-- 适用场景："团队业绩排名"、"XX 的业绩如何"。
-- 输入：customers, opportunities, sale_orders, payments, keep_records, visit_records
-- 输出字段：
--   chargerName, customer_count, opportunity_count, active_opportunity_count,
--   total_opportunity_amount, order_count, total_order_amount, total_paid,
--   collection_rate_pct（回款率 %）, follow_up_count_30d, visit_count_30d,
--   top_customers JSON, overdue_customers JSON
--
-- 用户替换：无（全量）；想看单人加 HAVING "chargerName" = 'xx'
--
-- 业绩聚合口径：本模板的所有子 CTE 都按 chargerId 字段 GROUP BY，
-- 与 RBAC 可见性范围天然分离（详见 SKILL.md § 2.1）。
-- 即使 dump 出的 NDJSON 含"客户名下、业绩属于他人"的记录，
-- 该记录会被聚合到原经手人头上，不会错算到当前用户。
-- =============================================================

WITH now_shanghai AS (
  SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::TIMESTAMP AS ts
),
cust_by_charger AS (
  SELECT
    "chargerId",
    "chargerName",
    COUNT(*) AS customer_count,
    array_agg(struct_pack(
      id           := id,
      customerName := "customerName",
      dealStatus   := "dealStatus",
      lastFollowUp := "lastKeepRecordTime"
    ) ORDER BY "lastKeepRecordTime"::TIMESTAMP DESC NULLS LAST) AS customers_json
  FROM customers
  WHERE "deletedAt" IS NULL AND "chargerId" IS NOT NULL
  GROUP BY "chargerId", "chargerName"
),
opp_by_charger AS (
  SELECT
    "chargerId",
    COUNT(*) AS opportunity_count,
    SUM(CASE WHEN "opportunityStage" NOT IN ('赢单','输单流失') THEN 1 ELSE 0 END) AS active_opportunity_count,
    COALESCE(SUM(CAST("opportunityAmount" AS DECIMAL(18,2))), 0) AS total_opportunity_amount
  FROM opportunities
  WHERE "deletedAt" IS NULL
  GROUP BY "chargerId"
),
order_by_charger AS (
  SELECT
    "chargerId",
    "customerId",
    COUNT(*) AS order_count,
    COALESCE(SUM(CAST("orderAmount" AS DECIMAL(18,2))), 0) AS total_order_amount
  FROM sale_orders
  WHERE "deletedAt" IS NULL
  GROUP BY "chargerId", "customerId"
),
order_agg AS (
  SELECT
    "chargerId",
    SUM(order_count) AS order_count,
    SUM(total_order_amount) AS total_order_amount
  FROM order_by_charger
  GROUP BY "chargerId"
),
pay_by_charger AS (
  SELECT
    "chargerId",
    COALESCE(SUM(CAST("paymentAmount" AS DECIMAL(18,2))), 0) AS total_paid
  FROM payments
  WHERE "deletedAt" IS NULL
  GROUP BY "chargerId"
),
follow_30d AS (
  SELECT
    kr."chargerId",
    COUNT(*) AS follow_up_count_30d
  FROM keep_records kr
  CROSS JOIN now_shanghai n
  WHERE kr."deletedAt" IS NULL
    AND kr."keepRecordTime"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai' >= n.ts - INTERVAL 30 DAY
  GROUP BY kr."chargerId"
),
visit_30d AS (
  SELECT
    vr."chargerId",
    COUNT(*) AS visit_count_30d
  FROM visit_records vr
  CROSS JOIN now_shanghai n
  WHERE vr."deletedAt" IS NULL
    AND vr."signInTime"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai' >= n.ts - INTERVAL 30 DAY
  GROUP BY vr."chargerId"
),
-- 每销售 Top 5 客户（按订单额）
top_custs AS (
  SELECT
    "chargerId",
    array_agg(struct_pack(
      customerId   := "customerId",
      orderAmount  := total_order_amount,
      orderCount   := order_count
    ) ORDER BY total_order_amount DESC) FILTER (WHERE rnk <= 5) AS top_customers_json
  FROM (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY "chargerId" ORDER BY total_order_amount DESC) AS rnk
    FROM order_by_charger
  ) t
  GROUP BY "chargerId"
),
active_opp_by_customer AS (
  SELECT
    "customerId",
    COUNT(*) AS active_opportunity_count
  FROM opportunities
  WHERE "deletedAt" IS NULL
    AND "opportunityStage" NOT IN ('赢单','输单流失')
  GROUP BY "customerId"
),
-- 超 7 天未跟进 AND 该客户自己还有活跃商机
-- 注：把 lastKeepRecordTime 转 Shanghai naive 后再跟 n.ts 比较，避免 8h 时区差
overdue AS (
  SELECT
    c."chargerId",
    array_agg(struct_pack(
      id           := c.id,
      customerName := c."customerName",
      lastFollowUp := c."lastKeepRecordTime",
      daysSince    := CASE WHEN c."lastKeepRecordTime" IS NULL THEN NULL ELSE date_diff('day',
                                (c."lastKeepRecordTime"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::TIMESTAMP,
                                (n.ts)::TIMESTAMP) END
    ) ORDER BY c."lastKeepRecordTime"::TIMESTAMP ASC NULLS FIRST) AS overdue_customers_json
  FROM customers c
  JOIN active_opp_by_customer aoc ON aoc."customerId" = c.id
  CROSS JOIN now_shanghai n
  WHERE c."deletedAt" IS NULL
    AND (c."lastKeepRecordTime" IS NULL
         OR (c."lastKeepRecordTime"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::TIMESTAMP
            < (n.ts)::TIMESTAMP - INTERVAL 7 DAY)
    AND c."dealStatus" NOT IN ('已赢单','多次赢单')
  GROUP BY c."chargerId"
)
SELECT
  cbc."chargerId",
  cbc."chargerName",
  cbc.customer_count,
  COALESCE(obc.opportunity_count, 0)        AS opportunity_count,
  COALESCE(obc.active_opportunity_count, 0) AS active_opportunity_count,
  COALESCE(obc.total_opportunity_amount, 0) AS total_opportunity_amount,
  COALESCE(oa.order_count, 0)               AS order_count,
  COALESCE(oa.total_order_amount, 0)        AS total_order_amount,
  COALESCE(pbc.total_paid, 0)               AS total_paid,
  CASE WHEN COALESCE(oa.total_order_amount, 0) = 0 THEN 0
       ELSE ROUND(COALESCE(pbc.total_paid, 0) * 100.0 / oa.total_order_amount, 2)
  END                                       AS collection_rate_pct,
  COALESCE(f30.follow_up_count_30d, 0)      AS follow_up_count_30d,
  COALESCE(v30.visit_count_30d, 0)          AS visit_count_30d,
  tc.top_customers_json,
  ov.overdue_customers_json
FROM cust_by_charger cbc
LEFT JOIN opp_by_charger   obc ON obc."chargerId" = cbc."chargerId"
LEFT JOIN order_agg        oa  ON oa."chargerId"  = cbc."chargerId"
LEFT JOIN pay_by_charger   pbc ON pbc."chargerId" = cbc."chargerId"
LEFT JOIN follow_30d       f30 ON f30."chargerId" = cbc."chargerId"
LEFT JOIN visit_30d        v30 ON v30."chargerId" = cbc."chargerId"
LEFT JOIN top_custs        tc  ON tc."chargerId"  = cbc."chargerId"
LEFT JOIN overdue          ov  ON ov."chargerId"  = cbc."chargerId"
ORDER BY total_order_amount DESC;


-- =============================================================
-- 模板 C：每日动态
-- ----------------------------------------------------
-- 用途：按 UTC+8 自然日聚合：新增跟进/拜访/回款/新客户/新商机/日报数。
-- 适用场景："今天/本周/本月发生了什么"、"最近 N 天趋势"。
-- 输入：keep_records, visit_records, payments, customers, opportunities, crm_work_dailies
-- 输出字段：
--   day (DATE), follow_up_count, visit_count, payment_count, payment_amount,
--   new_customer_count, new_opportunity_count, new_opportunity_amount, daily_report_count
--
-- 用户替换：第 ??? 行的时间窗口（默认最近 30 天）
-- =============================================================

WITH now_shanghai AS (
  SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::TIMESTAMP AS ts
),
follow_daily AS (
  SELECT
    DATE_TRUNC('day', "keepRecordTime"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE AS day,
    COUNT(*) AS follow_up_count
  FROM keep_records
  WHERE "deletedAt" IS NULL AND "keepRecordTime" IS NOT NULL
  GROUP BY 1
),
visit_daily AS (
  SELECT
    DATE_TRUNC('day', "signInTime"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE AS day,
    COUNT(*) AS visit_count
  FROM visit_records
  WHERE "deletedAt" IS NULL AND "signInTime" IS NOT NULL
  GROUP BY 1
),
pay_daily AS (
  SELECT
    DATE_TRUNC('day', "businessDate"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE AS day,
    COUNT(*) AS payment_count,
    COALESCE(SUM(CAST("paymentAmount" AS DECIMAL(18,2))), 0) AS payment_amount
  FROM payments
  WHERE "deletedAt" IS NULL AND "businessDate" IS NOT NULL
  GROUP BY 1
),
new_cust_daily AS (
  SELECT
    DATE_TRUNC('day', "createdAt"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE AS day,
    COUNT(*) AS new_customer_count
  FROM customers
  WHERE "deletedAt" IS NULL
  GROUP BY 1
),
new_opp_daily AS (
  SELECT
    DATE_TRUNC('day', "createdAt"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE AS day,
    COUNT(*) AS new_opportunity_count,
    COALESCE(SUM(CAST("opportunityAmount" AS DECIMAL(18,2))), 0) AS new_opportunity_amount
  FROM opportunities
  WHERE "deletedAt" IS NULL
  GROUP BY 1
),
report_daily AS (
  SELECT
    DATE_TRUNC('day', "reportDate"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE AS day,
    COUNT(*) AS daily_report_count
  FROM crm_work_dailies
  WHERE "deletedAt" IS NULL AND "reportDate" IS NOT NULL
  GROUP BY 1
),
-- 所有日期的全集，构造连续的日历行（避免某天无数据就断行）
all_days AS (
  SELECT day FROM follow_daily
  UNION SELECT day FROM visit_daily
  UNION SELECT day FROM pay_daily
  UNION SELECT day FROM new_cust_daily
  UNION SELECT day FROM new_opp_daily
  UNION SELECT day FROM report_daily
)
SELECT
  d.day,
  strftime(d.day, '%Y-%m-%d %a') AS day_display,
  COALESCE(f.follow_up_count, 0)          AS follow_up_count,
  COALESCE(v.visit_count, 0)              AS visit_count,
  COALESCE(p.payment_count, 0)            AS payment_count,
  COALESCE(p.payment_amount, 0)           AS payment_amount,
  COALESCE(nc.new_customer_count, 0)      AS new_customer_count,
  COALESCE(no_.new_opportunity_count, 0)  AS new_opportunity_count,
  COALESCE(no_.new_opportunity_amount, 0) AS new_opportunity_amount,
  COALESCE(r.daily_report_count, 0)       AS daily_report_count
FROM all_days d
CROSS JOIN now_shanghai n
LEFT JOIN follow_daily    f   ON f.day   = d.day
LEFT JOIN visit_daily     v   ON v.day   = d.day
LEFT JOIN pay_daily       p   ON p.day   = d.day
LEFT JOIN new_cust_daily  nc  ON nc.day  = d.day
LEFT JOIN new_opp_daily   no_ ON no_.day = d.day
LEFT JOIN report_daily    r   ON r.day   = d.day
-- 【参数】时间窗口：默认最近 30 天；改 7 为 7 天、90 为 3 个月、365 为 1 年
WHERE d.day >= (n.ts - INTERVAL 30 DAY)::DATE
ORDER BY d.day DESC;


-- =============================================================
-- 模板 D：长期未跟进的有商机客户（重点催跟进列表）
-- ----------------------------------------------------
-- 用途：过滤出 7 天未跟进 AND 有活跃商机（非赢单/输单流失）的客户。
-- 适用场景："哪些客户要催销售跟进"、"有活跃商机但冷了的客户"。
-- 输入：customers, keep_records, opportunities
-- 输出字段：
--   serialNumber, customerName, chargerName, last_follow_up_at,
--   days_since_last_follow_up, active_opportunity_count,
--   active_opportunity_total_amount, active_opportunities JSON
--
-- 用户替换：第 ??? 行的 INTERVAL 7 DAY 阈值
-- =============================================================

WITH last_follow AS (
  SELECT
    "customerId",
    -- 转 Shanghai naive，方便跟 NOW(Shanghai) 做 date_diff
    MAX("keepRecordTime"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::TIMESTAMP AS last_follow_up_at
  FROM keep_records
  WHERE "deletedAt" IS NULL
  GROUP BY "customerId"
),
active_opp AS (
  SELECT
    "customerId",
    COUNT(*) AS active_opportunity_count,
    COALESCE(SUM(CAST("opportunityAmount" AS DECIMAL(18,2))), 0) AS active_opportunity_total_amount,
    array_agg(struct_pack(
      id              := id,
      opportunityName := "opportunityName",
      stage           := "opportunityStage",
      amount          := CAST("opportunityAmount" AS DECIMAL(18,2)),
      expectedDealAt  := "expectedDealDate",
      winRate         := "winRate"
    ) ORDER BY "opportunityAmount" DESC NULLS LAST) AS active_opportunities_json
  FROM opportunities
  WHERE "deletedAt" IS NULL
    AND "opportunityStage" NOT IN ('赢单','输单流失')
  GROUP BY "customerId"
)
,
now_shanghai AS (
  SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::TIMESTAMP AS ts
)
SELECT
  c."serialNumber",
  c."customerName",
  c."chargerName",
  c."dealStatus",
  lf.last_follow_up_at,
  CASE WHEN lf.last_follow_up_at IS NULL THEN NULL
       ELSE date_diff('day', lf.last_follow_up_at, n.ts)
  END AS days_since_last_follow_up,
  ao.active_opportunity_count,
  ao.active_opportunity_total_amount,
  ao.active_opportunities_json
FROM customers c
JOIN active_opp ao  ON ao."customerId" = c.id
CROSS JOIN now_shanghai n
LEFT JOIN last_follow lf ON lf."customerId" = c.id
WHERE c."deletedAt" IS NULL
  AND c."dealStatus" NOT IN ('已赢单','多次赢单')
  -- 【参数】未跟进阈值：默认 7 天；改成 INTERVAL 14 DAY / 30 DAY 可调整
  AND (lf.last_follow_up_at IS NULL
       OR lf.last_follow_up_at < n.ts - INTERVAL 7 DAY)
ORDER BY days_since_last_follow_up DESC NULLS FIRST
LIMIT 50;
