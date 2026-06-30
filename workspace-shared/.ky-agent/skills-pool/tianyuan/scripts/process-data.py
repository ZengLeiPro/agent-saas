#!/usr/bin/env python3
"""
钉钉天元数据处理脚本
读取 scraper.js 导出的 JSON，清洗后写入数据库

用法: python3 process-data.py <json_file> [--module orders|opportunities|leads]
"""
import json
import sys
import os
import subprocess
from datetime import datetime

PSQL = "/opt/homebrew/opt/libpq/bin/psql"
DB_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/ky_agent")

# 模块配置：表名映射
MODULE_CONFIG = {
    "orders": {
        "table": "tianyuan_orders",
        "id_field": "订单编号",
    },
    "opportunities": {
        "table": "tianyuan_opportunities",
        "id_field": "商机编号",
    },
    "leads": {
        "table": "tianyuan_leads",
        "id_field": "线索编号",
    },
}

# 需要排除的字段
EXCLUDE_FIELDS = {"操作", ""}


def clean_value(val):
    """清理单元格值"""
    if not val or val == "-" or val == "—":
        return None
    val = val.strip()
    # 去掉"..."截断标记
    if val.endswith("..."):
        val = val[:-3].strip()
    return val if val else None


def detect_module(headers):
    """根据表头自动检测数据模块"""
    header_set = set(headers)
    if "订单编号" in header_set:
        return "orders"
    if "商机编号" in header_set and "订单编号" not in header_set:
        return "opportunities"
    if "线索编号" in header_set:
        return "leads"
    return "unknown"


def process_json(filepath, module_override=None):
    """处理 JSON 文件，返回清洗后的记录列表"""
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    headers = data.get("headers", [])
    rows = data.get("data", [])
    scraped_at = data.get("scraped_at", datetime.now().isoformat())

    # 检测模块
    module = module_override or detect_module(headers)
    print(f"📋 模块: {module}")
    print(f"📊 原始行数: {len(rows)}")
    print(f"📋 字段: {', '.join(headers)}")

    # 过滤掉需要排除的字段
    keep_indices = [i for i, h in enumerate(headers) if h not in EXCLUDE_FIELDS]
    clean_headers = [headers[i] for i in keep_indices]

    records = []
    seen_ids = set()
    id_field = MODULE_CONFIG.get(module, {}).get("id_field")

    for row in rows:
        # 清理每个字段
        cleaned = [clean_value(row[i]) if i < len(row) else None for i in keep_indices]

        # 构建字典
        record = dict(zip(clean_headers, cleaned))

        # 去重（基于 ID 字段）
        if id_field and record.get(id_field):
            rid = record[id_field]
            if rid in seen_ids:
                continue
            seen_ids.add(rid)

        # 跳过全空记录
        if not any(v for v in record.values()):
            continue

        record["_scraped_at"] = scraped_at
        record["_module"] = module
        records.append(record)

    print(f"✅ 清洗后: {len(records)} 条有效记录")
    return records, module, clean_headers


def create_table_sql(module, headers):
    """生成建表 SQL"""
    table = MODULE_CONFIG.get(module, {}).get("table", f"tianyuan_{module}")
    id_field = MODULE_CONFIG.get(module, {}).get("id_field")

    cols = []
    for h in headers:
        col_name = h.replace("/", "_").replace(" ", "_")
        if h == id_field:
            cols.append(f'  "{h}" TEXT PRIMARY KEY')
        else:
            cols.append(f'  "{h}" TEXT')

    cols.append('  "_scraped_at" TIMESTAMPTZ')
    cols.append('  "_module" TEXT')

    return f"""CREATE TABLE IF NOT EXISTS {table} (
{chr(10).join(cols)}
);"""


def upsert_sql(module, headers, records):
    """生成 UPSERT SQL"""
    table = MODULE_CONFIG.get(module, {}).get("table", f"tianyuan_{module}")
    id_field = MODULE_CONFIG.get(module, {}).get("id_field")

    all_fields = headers + ["_scraped_at", "_module"]
    col_names = ", ".join(f'"{f}"' for f in all_fields)

    values_list = []
    for r in records:
        vals = []
        for f in all_fields:
            v = r.get(f)
            if v is None:
                vals.append("NULL")
            else:
                vals.append("'" + str(v).replace("'", "''") + "'")
        values_list.append("(" + ", ".join(vals) + ")")

    values_str = ",\n".join(values_list)

    if id_field:
        update_fields = [f for f in all_fields if f != id_field]
        update_set = ", ".join(f'"{f}" = EXCLUDED."{f}"' for f in update_fields)
        return f"""INSERT INTO {table} ({col_names})
VALUES
{values_str}
ON CONFLICT ("{id_field}") DO UPDATE SET
{update_set};"""
    else:
        return f"""INSERT INTO {table} ({col_names})
VALUES
{values_str};"""


def write_to_db(module, headers, records):
    """写入数据库"""
    table = MODULE_CONFIG.get(module, {}).get("table", f"tianyuan_{module}")

    # 建表
    create_sql = create_table_sql(module, headers)
    print(f"\n🔧 创建/确认表: {table}")
    subprocess.run(
        [PSQL, DB_URL, "-c", create_sql],
        capture_output=True, text=True
    )

    # 分批写入（每批 100 条）
    batch_size = 100
    total_written = 0
    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        sql = upsert_sql(module, headers, batch)
        result = subprocess.run(
            [PSQL, DB_URL, "-c", sql],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"  ❌ 批次 {i//batch_size + 1} 失败: {result.stderr[:200]}")
        else:
            total_written += len(batch)
            print(f"  📥 批次 {i//batch_size + 1}: +{len(batch)} 条")

    print(f"\n✅ 共写入 {total_written} 条到 {table}")
    return total_written


def main():
    if len(sys.argv) < 2:
        print("用法: python3 process-data.py <json_file> [--module orders|opportunities|leads]")
        sys.exit(1)

    filepath = sys.argv[1]
    module_override = None

    if "--module" in sys.argv:
        idx = sys.argv.index("--module")
        if idx + 1 < len(sys.argv):
            module_override = sys.argv[idx + 1]

    if not os.path.exists(filepath):
        print(f"❌ 文件不存在: {filepath}")
        sys.exit(1)

    print(f"📁 处理文件: {filepath}")
    records, module, headers = process_json(filepath, module_override)

    if not records:
        print("⚠️ 无有效数据")
        sys.exit(0)

    # 写入数据库
    write_to_db(module, headers, records)

    # 输出统计
    print(f"\n📊 数据统计:")
    if "订单状态" in headers:
        status_count = {}
        for r in records:
            s = r.get("订单状态", "未知") or "未知"
            status_count[s] = status_count.get(s, 0) + 1
        for s, c in sorted(status_count.items(), key=lambda x: -x[1]):
            print(f"  {s}: {c}")


if __name__ == "__main__":
    main()
