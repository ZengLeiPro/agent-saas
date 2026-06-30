# 典型查询示例

> 所有示例为只读 SELECT。客户/合同号/数字已对照真实数据校验。
> 数据库路径：`.ky-agent/skills/xinling-procurement-qc/data/procurement_qc.db`
> SQL 中中文标识符用双引号 `"..."` 包裹。
>
> **数据已清洗**：
> - `品检_皮胚检验` 每订单 1 行（无双倍计算，**直接 SUM 不需特殊过滤**）
> - `品检_呆滞消化` 各月列结构已统一
> - `皮源` 字段已拆为 5 个结构化字段：`皮源_批次编号 / 皮源_代理商 / 皮源_产地 / 皮源_原皮类型 / 皮源_等级`

## 1. 月度品检概览：各月皮胚检验张数 + 加权呆滞率

```sql
SELECT
  month AS "月份",
  COUNT(*) AS "单数",
  ROUND(SUM(检验张数), 0) AS "总张数",
  ROUND(SUM(呆滞数量), 1) AS "总呆滞数",
  ROUND(SUM(呆滞数量) * 100.0 / SUM(检验张数), 2) AS "加权呆滞率%"
FROM "品检_皮胚检验"
WHERE month IS NOT NULL AND 检验张数 > 0
GROUP BY month
ORDER BY month;
```

**业务解读模板**：`X 月共检验 Y 张，加权呆滞率 Z%，环比上月 ↑/↓ N pp。Top 拖累是 ...`

---

## 1b. 代理商维度：哪个皮源代理商呆滞最严重（新字段用法）

```sql
SELECT
  皮源_代理商 AS "代理商",
  COUNT(*) AS "单数",
  ROUND(SUM(检验张数), 0) AS "张数",
  ROUND(SUM(呆滞数量), 0) AS "呆滞",
  ROUND(SUM(呆滞数量) * 100.0 / SUM(检验张数), 2) AS "呆滞率%"
FROM "品检_皮胚检验"
WHERE 皮源_代理商 IS NOT NULL AND 检验张数 > 0
GROUP BY 皮源_代理商
ORDER BY 呆滞 DESC
LIMIT 10;
```

---

## 1c. 缺陷分类 Top（用合并后的缺陷分类字段）

```sql
-- 提取缺陷分类里第一个缺陷关键词
SELECT
  CASE
    WHEN 缺陷分类 LIKE '松面%' THEN '松面'
    WHEN 缺陷分类 LIKE '面差%' THEN '面差'
    WHEN 缺陷分类 LIKE '整鼓%' THEN '整鼓'
    WHEN 缺陷分类 LIKE '挖刀%' THEN '挖刀'
    WHEN 缺陷分类 LIKE '%' THEN '其他'
  END AS "主因",
  COUNT(*) AS "单数",
  ROUND(SUM(呆滞数量), 0) AS "呆滞数"
FROM "品检_皮胚检验"
WHERE 缺陷分类 IS NOT NULL
GROUP BY 主因
ORDER BY 呆滞数 DESC;
```

---

## 2. 客户角度：每客户的呆滞 TOP 10

```sql
SELECT
  客户,
  COUNT(*) AS "检验单数",
  ROUND(SUM(检验张数), 0) AS "总张数",
  ROUND(SUM(呆滞数量), 1) AS "总呆滞数",
  ROUND(SUM(呆滞数量) * 100.0 / SUM(检验张数), 2) AS "呆滞率%"
FROM "品检_皮胚检验"
WHERE 客户 IS NOT NULL AND 检验张数 > 0
GROUP BY 客户
HAVING SUM(检验张数) > 100
ORDER BY "呆滞率%" DESC
LIMIT 10;
```

---

## 3. 品种角度：哪些品种最容易呆滞

```sql
SELECT
  品种,
  COUNT(*) AS "次数",
  ROUND(SUM(检验张数), 0) AS "总张数",
  ROUND(AVG(呆滞占比) * 100, 2) AS "平均呆滞占比%"
FROM "品检_皮胚检验"
WHERE 品种 IS NOT NULL AND 检验张数 > 0
GROUP BY 品种
ORDER BY "平均呆滞占比%" DESC
LIMIT 15;
```

---

## 4. 皮源追溯：某批次的全链路情况

```sql
-- 已知批次编号 LP260107LY507，查它在采购→检验全流程的轨迹
SELECT '采购入库' AS 环节, in_date AS 日期, supplier AS 客户或供应商, pi_yuan AS 描述,
       rolls AS 数量, NULL AS 呆滞或不良
FROM "采购_皮源总表" WHERE pi_yuan LIKE '%LP260107LY507%'

UNION ALL

SELECT '皮胚检验', 日期, 客户, 皮源, 检验张数, 呆滞数量
FROM "品检_皮胚检验" WHERE 皮源 LIKE '%LP260107LY507%'

UNION ALL

SELECT '成品检验', 日期, 客户, 皮源, 检验张数, 异常数量
FROM "品检_成品检验" WHERE 皮源 LIKE '%LP260107LY507%';
```

---

## 5. 进口毛皮：各代理商到货总量 + 二层产出效率

```sql
SELECT
  c.agent AS "代理商",
  COUNT(DISTINCT c.contract_no) AS "合同数",
  ROUND(SUM(c.total_weight), 0) AS "总重量KG",
  SUM(c.rolls) AS "总条数",
  ROUND(AVG(b."二层平均KG_per_条"), 2) AS "平均二层KG_per_条",
  ROUND(AVG(b."二层平均元_per_条"), 2) AS "平均二层元_per_条"
FROM "进口毛皮_合同安排" c
LEFT JOIN "进口毛皮_批次加工" b
  ON b.合同号 = c.contract_no
GROUP BY c.agent
ORDER BY "总重量KG" DESC;
```

---

## 6. 呆滞消化：跨月趋势 + 出库 vs 套染比例

```sql
SELECT
  month AS "月份",
  消化类型,
  COUNT(*) AS "笔数",
  ROUND(SUM(数量_条), 1) AS "总条数",
  ROUND(SUM(数量_SF), 1) AS "总SF"
FROM "品检_呆滞消化"
GROUP BY month, 消化类型
ORDER BY month, 消化类型;
```

---

## 7. 库存月度变化：黄牛成品的条 vs SF 趋势

```sql
SELECT
  month AS "月份",
  品类,
  单位,
  ROUND(数量, 1) AS 数量,
  ROUND(SF, 1) AS SF,
  ROUND(变动数量, 1) AS 变动数量
FROM "品检_库存月度快照"
WHERE 品类 IN ('黄牛成品', '黄牛外购', '总计：')
ORDER BY 品类, 单位, month;
```

---

## 8. 异常订单溯源：呆滞特例里的责任分布

```sql
SELECT
  客户,
  品种,
  COUNT(*) AS 案例数,
  ROUND(SUM(呆滞数量), 1) AS 总呆滞,
  GROUP_CONCAT(DISTINCT 工序) AS 涉及工序,
  GROUP_CONCAT(DISTINCT 责任人) AS 责任人
FROM "品检_呆滞特例"
WHERE 客户 IS NOT NULL
GROUP BY 客户, 品种
ORDER BY 总呆滞 DESC;
```

---

## 9. 客户订单分布：每个客户的发胚情况

```sql
SELECT
  客户,
  COUNT(DISTINCT 订单号) AS 订单数,
  COUNT(*) AS 发胚条目数,
  GROUP_CONCAT(DISTINCT 品种) AS 涉及品种
FROM "品检_皮胚发胚日报"
WHERE 客户 IS NOT NULL
GROUP BY 客户
ORDER BY 订单数 DESC;
```

---

## 10. 皮源入库历史：按年份+名称累计

```sql
SELECT
  substr(日期, 1, 4) AS 年份,
  名称,
  COUNT(*) AS 入库笔数,
  ROUND(SUM(张数), 0) AS 总张数,
  ROUND(SUM(尺码SF), 0) AS 总SF
FROM "品检_皮源入库累积"
WHERE 日期 IS NOT NULL
GROUP BY 年份, 名称
ORDER BY 年份, 总张数 DESC;
```

---

## 自由问答时的思考清单（给 Agent）

收到用户问题先想：
1. **该问题落到哪张表？** 多个表都相关时，从主表（皮胚/成品检验）开始，必要时 JOIN
2. **是否需要跨月对比？** 单月数据无对照难下结论
3. **客户/品种/皮源 三轴**：哪个轴是用户关心的？
4. **聚合层次**：用户要"汇总数字" 还是"明细列表"？
5. **业务结论必须给**：不要只贴 SQL 结果，主动给"X 比上月升 N%，主要因 Y"
6. **拒绝幻觉**：客户名/合同号/数字必从查询结果取，不从对话印象取
