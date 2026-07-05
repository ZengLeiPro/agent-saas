# DuckDB / NDJSON 通用陷阱（12 条带反例）

每条独立、可对照反例直接复制粘贴。第一次写 SQL 时通读一遍，之后只在踩坑时回查具体条目。

## 1. camelCase 字段名必须加双引号

DuckDB 未加引号的标识符会被自动 lowercase，`customerName` 会被当成 `customername` 找不到。

```sql
-- ✅ 正确
SELECT "customerName", "chargerId" FROM customers WHERE "deletedAt" IS NULL;

-- ❌ 反例：报 Column "customername" not found
SELECT customerName FROM customers;
```

## 2. 日期字段必须显式 CAST

NDJSON 里的日期是 ISO 字符串，直接当时间比较会变成字典序对比，`"2026-04-22T..."` < `"2026-04-9T..."` 会出错。

```sql
-- ✅ 正确
WHERE "createdAt"::TIMESTAMP >= DATE '2026-04-01'
WHERE "keepRecordTime"::DATE = DATE '2026-04-22'

-- ❌ 反例：字符串比较，跨月时排序会错
WHERE "createdAt" >= '2026-04-01'
```

## 3. 时区 UTC → Asia/Shanghai 需两次转换

后端写入是 UTC，直接 `DATE_TRUNC('day', ...)` 会按 UTC 切日，比上海时间早 8 小时。

```sql
-- ✅ 正确
DATE_TRUNC('day', "createdAt"::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')

-- ❌ 反例：上海时间 04-22 00:30 的数据会被算到 04-21
DATE_TRUNC('day', "createdAt"::TIMESTAMP)
```

> 注意区分字段和当前时间：后端 UTC ISO 字符串字段用 `field::TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'`；当前时间用 `NOW() AT TIME ZONE 'Asia/Shanghai'`。不要对 `NOW()` 再做 UTC→Shanghai 双转换。

## 4. Prisma Decimal 序列化不稳定，统一 CAST

Prisma 把 Decimal 序列化成字符串（`"100.00"`）或 number（`100`），DuckDB 读到的类型不一定稳定；相加不同类型会报错。

```sql
-- ✅ 正确
SUM(CAST("paymentAmount" AS DECIMAL(18,2))) AS total_paid

-- ❌ 反例：直接 SUM 可能报 "type mismatch"
SUM("paymentAmount")
```

## 5. SUM() 对空集返回 NULL，必加 COALESCE

```sql
-- ✅ 正确
COALESCE(SUM(CAST("paymentAmount" AS DECIMAL(18,2))), 0) AS total_paid

-- ❌ 反例：没有回款的客户 total_paid 是 NULL，后续做减法结果全 NULL
SUM("paymentAmount")
```

## 6. COUNT(expr) 会忽略 NULL，COUNT(*) 全计

```sql
-- 统计有 realDealDate 的商机（实际成交了）：
COUNT("realDealDate")     -- 忽略 NULL，结果是"已成交数"
COUNT(*)                  -- 全部商机数
```

想统计"填了内容的跟进条数"和"跟进条数"是两回事，心里要分清。

## 7. read_json_auto 字段稀疏会漏推断

NDJSON 中某字段前 N 行全是 null，DuckDB 可能推断为 `VARCHAR`，后续读到 object 就报错。

```sql
-- ✅ 兜底：遇到 "conversion error" 切显式 schema
SELECT * FROM read_json(
  '.cache/azq/.../opportunities.ndjson',
  format='newline_delimited',
  columns={
    id: 'VARCHAR',
    "opportunityName": 'VARCHAR',
    "opportunityAmount": 'DOUBLE',
    products: 'JSON',
    "createdAt": 'VARCHAR'
  }
);

-- 默认用法（先试这个，不报错就不用管）
SELECT * FROM read_json_auto('.cache/azq/.../file.ndjson', format='newline_delimited');
```

## 8. array_agg 必须显式 ORDER BY

不指定顺序的 `array_agg` 在并行扫描下顺序不稳定，前后两次运行可能不一样。

```sql
-- ✅ 正确
array_agg(struct_pack(name := "opportunityName", amount := "opportunityAmount")
          ORDER BY "createdAt" DESC)

-- ❌ 反例：顺序不稳
array_agg(struct_pack(name := "opportunityName", amount := "opportunityAmount"))
```

## 9. date_diff 单位是单数 'day'，不是 PG 的 'days'

```sql
-- ✅ 正确
date_diff('day', "lastKeepRecordTime"::TIMESTAMP, NOW())

-- ❌ 反例：PostgreSQL 习惯写 'days'，DuckDB 识别不了
date_diff('days', ...)
```

## 10. 复杂 SQL 写入 .sql 文件，不要硬塞 -c "..."

`duckdb -c "SELECT ... WHERE \"a\" = '...'"` 里的双引号、单引号、`$`、反引号嵌套多了就会翻车。

```bash
# ✅ 正确：写文件 + -c ".read ..."
cat > "$SESS/q.sql" <<'EOF'
SELECT "customerName", COUNT(*) FROM customers WHERE "deletedAt" IS NULL GROUP BY 1;
EOF
duckdb -c ".read $SESS/q.sql"

# ✅ 正确：ACS wrapper 也支持 stdin
duckdb -json < "$SESS/q.sql"

# ❌ 反例：shell 转义地狱
duckdb -c "SELECT \"customerName\", COUNT(*) FROM ..."

# ❌ 反例：交互模式在 ACS wrapper 中不可用
duckdb
.read "$SESS/q.sql"
```

## 11. NDJSON 格式参数用完整写法

```sql
-- ✅ 正确
read_json_auto('file.ndjson', format='newline_delimited')

-- ⚠️ 有些老版本接受 format='nd'，但跨版本不稳定，统一用完整写法
```

## 12. 保留字与字段名加引号

DuckDB 里 `order`、`limit`、`group` 等是保留字；表名 `sale_orders` 没问题，但如果查询里引用字段叫 `order` 要加双引号。`status`、`type` 不是保留字但建议都加引号以防 camelCase 规则。

## 附：条件计数惯用法

虽然不算"陷阱"，但写汇总时常用：

```sql
-- 统计"已成交商机数"和"未成交商机数"一条 SQL 搞定
SELECT
  SUM(CASE WHEN "opportunityStage" = '赢单' THEN 1 ELSE 0 END) AS won,
  SUM(CASE WHEN "opportunityStage" NOT IN ('赢单','输单流失') THEN 1 ELSE 0 END) AS active
FROM opportunities WHERE "deletedAt" IS NULL;
```
