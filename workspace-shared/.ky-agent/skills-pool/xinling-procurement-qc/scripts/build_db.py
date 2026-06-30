#!/usr/bin/env python3
"""新凌公司采购+品管数据集 SQLite 构建脚本（一次性）

数据源：skill 同级 source_xlsx/
输出：skill 同级 data/procurement_qc.db

数据清洗（vs 原始 Excel）：
  1. 皮胚检验合并：主表 "皮胚汇总" + 拆分表 "皮胚汇总 (3)/2)" 合并为单表，
     拆分表的缺陷原因/数量聚合到新字段 `缺陷分类`（如 "挖刀:8;面差:26"），
     不再有 source_sheet 重复行——直接 SUM 即可得到正确呆滞总数。
  2. 呆滞消化列结构：源 Excel 各月列数不同（1月13列/3月19列/4月15列），
     脚本按月份配置列号映射，输出统一 schema：
     日期/消化类型/类别/客户/品种/颜色/数量_条/数量_SF/皮源/原责任。
  3. 皮源字段拆分：自由文本 `皮源` 在保留原值同时，新增 5 个结构化字段：
     皮源_批次编号 / 皮源_代理商 / 皮源_产地 / 皮源_原皮类型 / 皮源_等级。
     所有含 "皮源" 字段的表都同步拆分。
"""
import re
import sqlite3
from pathlib import Path
from datetime import datetime
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source_xlsx"
DB_PATH = ROOT / "data" / "procurement_qc.db"

# ---------- 工具 ----------
def _norm(v):
    if v is None: return None
    try:
        if pd.isna(v): return None
    except (TypeError, ValueError):
        pass
    return v

def _str(v):
    v = _norm(v)
    return str(v).strip() if v is not None else None

def _num(v):
    v = _norm(v)
    if v is None: return None
    if isinstance(v, (int, float)): return float(v)
    s = str(v).strip()
    m = re.search(r"-?\d+\.?\d*", s)
    return float(m.group()) if m else None

def _date(v):
    v = _norm(v)
    if v is None: return None
    if isinstance(v, datetime): return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    m = re.match(r"^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", s)
    if m:
        y, mo, d = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return s

# 产地/原皮关键词列表（按长到短匹配以避免子串误识）
_ORIGIN_KWS = ('塔斯马尼亚', '澳大利亚', '西班牙', '意大利',
               '英国', '法国', '波兰', '南非', '美国', '巴西', '国产')
_CATTLE_KWS = ('未育母牛', '小母牛', '小公牛', '奶阉', '阉牛',
               '公牛', '母牛', '小牛', '水牛')
# 等级模式
_GRADE_RE = re.compile(r'(?<![A-Z])([A-E]级|\d+级|\d+#|[A-E]{2,}级?|\bE级\b)')

def _split_pi_yuan(s):
    """把皮源自由文本拆为 (批次编号, 代理商代码, 产地, 原皮类型, 等级)。

    无法识别的字段返回 None。规则：
      - 批次编号: MP/LP + 6-8 位日期 + 字母段 + 数字段
      - 代理商: 从批次中提取字母段（如 HYG/LY/WSX）
      - 产地/原皮: 关键词包含匹配
      - 等级: 仅独立的 "X级"、"数字级"、"数字#"、连续大写字母
    """
    if not s:
        return (None, None, None, None, None)
    text = str(s).strip()
    # 1. 批次编号
    batch = None
    m = re.search(r'([ML]P\d{6,8}[A-Z]+\d+)', text)
    if m:
        batch = m.group(1)
    # 2. 代理商代码
    agent = None
    if batch:
        m2 = re.search(r'[ML]P\d{6,8}([A-Z]+)', batch)
        if m2:
            agent = m2.group(1)
    # 3. 产地
    origin = next((kw for kw in _ORIGIN_KWS if kw in text), None)
    # 4. 原皮类型
    cattle = next((kw for kw in _CATTLE_KWS if kw in text), None)
    # 5. 等级
    grade = None
    for cand in _GRADE_RE.findall(text):
        # 排除批次编号子串误识（如 HYG 不是等级）
        if batch and cand in batch:
            continue
        grade = cand
        break
    return (batch, agent, origin, cattle, grade)


def _attach_pi_yuan_split(row, pi_yuan_text):
    """把 5 个拆分字段填入 row dict，便于在解析函数里复用"""
    b, a, o, ct, g = _split_pi_yuan(pi_yuan_text)
    row["皮源_批次编号"] = b
    row["皮源_代理商"] = a
    row["皮源_产地"] = o
    row["皮源_原皮类型"] = ct
    row["皮源_等级"] = g

# ---------- 1. 采购_皮源 ----------
def build_purchase_pi_yuan(conn):
    f = SRC / "皮源.xlsx"
    df = pd.read_excel(f, sheet_name="Sheet1", header=None)
    COL = {"in_date":0,"supplier":1,"contract_no":2,"pi_yuan":3,
           "net_weight":5,"container_no":6,"rolls":7,"boards":8,
           "stock_rolls":9,"drum_rolls":10,"loss_rolls":11,
           "blue_rolls":14,"blue_sf":15}
    detail, summary = [], []
    cur_date = cur_sup = cur_con = None
    for i in range(3, df.shape[0]):
        r = df.iloc[i]
        if r.isna().all(): continue
        in_date = _date(r[COL["in_date"]])
        sup = _str(r[COL["supplier"]])
        con = _str(r[COL["contract_no"]])
        py = _str(r[COL["pi_yuan"]])
        if in_date: cur_date = in_date
        if sup: cur_sup = sup
        if con: cur_con = con
        net_w = _num(r[COL["net_weight"]])
        rolls = _num(r[COL["rolls"]])
        boards = _num(r[COL["boards"]])
        stock = _num(r[COL["stock_rolls"]])
        drum = _num(r[COL["drum_rolls"]])
        loss = _num(r[COL["loss_rolls"]])
        blue_rolls = _num(r[COL["blue_rolls"]])
        blue_sf = _num(r[COL["blue_sf"]])
        if py is not None:
            row = {"in_date":cur_date,"supplier":cur_sup,"contract_no":cur_con,
                "pi_yuan":py,"net_weight_t":net_w,"container_no":_str(r[COL["container_no"]]),
                "rolls":rolls,"boards":boards,"stock_rolls":stock,"drum_rolls":drum,
                "loss_rolls":loss,"blue_rolls":blue_rolls,"blue_sf":blue_sf,"raw_row":i+1}
            _attach_pi_yuan_split(row, py)
            detail.append(row)
        else:
            is_year = (sup is None and con is None and in_date is None
                       and rolls is not None and rolls >= 1000)
            row_type = "年度合计" if is_year else "合同小计"
            summary.append({"in_date":cur_date,"supplier":cur_sup,"contract_no":cur_con,
                "row_type":row_type,"net_weight_t":net_w,"rolls":rolls,"boards":boards,
                "stock_rolls":stock,"drum_rolls":drum,"loss_rolls":loss,
                "blue_rolls":blue_rolls,"blue_sf":blue_sf,"raw_row":i+1})
    pd.DataFrame(detail).to_sql("采购_皮源总表", conn, if_exists="replace", index=False)
    pd.DataFrame(summary).to_sql("采购_皮源汇总", conn, if_exists="replace", index=False)
    print(f"  采购_皮源总表: {len(detail)} 行")
    print(f"  采购_皮源汇总: {len(summary)} 行")

# ---------- 2. 进口毛皮 ----------
def build_import_fur(conn):
    f = SRC / "进口毛皮2026.xlsx"
    xls = pd.ExcelFile(f)
    # 2.1 合同安排
    df = pd.read_excel(f, sheet_name="毛皮总安排", header=None)
    COL = {"agent":0,"region":1,"factory":2,"factory_region":3,
           "contract_no":4,"fur_source":5,"spec":6,"total_weight":7,
           "rolls":8,"arrival_date":9,"processing_site":10,
           "benchmark_product":11,"split_thickness":12}
    rows = []
    cur = {k: None for k in COL}
    for i in range(1, df.shape[0]):
        r = df.iloc[i]
        if r.isna().all(): continue
        for k, c in COL.items():
            v = _norm(r[c]) if c < df.shape[1] else None
            if v is not None: cur[k] = v
        rows.append({
            "agent":_str(cur["agent"]),"region":_str(cur["region"]),
            "factory":_str(cur["factory"]),"factory_region":_str(cur["factory_region"]),
            "contract_no":_str(cur["contract_no"]),"fur_source":_str(cur["fur_source"]),
            "spec":_str(cur["spec"]),"total_weight":_num(cur["total_weight"]),
            "rolls":_num(cur["rolls"]),"arrival_date":_date(cur["arrival_date"]),
            "processing_site":_str(cur["processing_site"]),
            "benchmark_product":_str(cur["benchmark_product"]),
            "split_thickness":_str(cur["split_thickness"]),
        })
    pd.DataFrame(rows).to_sql("进口毛皮_合同安排", conn, if_exists="replace", index=False)
    print(f"  进口毛皮_合同安排: {len(rows)} 行")
    # 2.2 批次加工
    skip = {"毛皮总安排", "Sheet1"}
    batch_rows = []
    for sh in xls.sheet_names:
        if sh in skip: continue
        sdf = pd.read_excel(f, sheet_name=sh, header=None)
        if sdf.dropna(how='all').empty: continue
        rec = _parse_batch_card(sh, sdf)
        if rec: batch_rows.append(rec)
    pd.DataFrame(batch_rows).to_sql("进口毛皮_批次加工", conn, if_exists="replace", index=False)
    print(f"  进口毛皮_批次加工: {len(batch_rows)} 行")

def _parse_batch_card(sheet_name, df):
    cells = {}
    for i in range(df.shape[0]):
        for j in range(df.shape[1]):
            v = _norm(df.iat[i, j])
            if v is not None: cells[(i, j)] = v
    def find_after(label_kw, max_offset=3):
        for (i, j), v in cells.items():
            if isinstance(v, str) and label_kw in v:
                for k in range(1, max_offset + 1):
                    if (i, j + k) in cells:
                        return cells[(i, j + k)]
        return None
    return {
        "sheet_name": sheet_name,
        "加工场地": _str(find_after("加工场地")),
        "片皮时间": _date(find_after("片皮时间")),
        "负责人": _str(find_after("负责人")),
        "到厂日期": _date(find_after("到厂日期")),
        "合同号": _str(find_after("合同号")),
        "批次编号": _str(find_after("批次编号")),
        "生产日期": _date(find_after("生产日期")),
        "毛皮代理商": _str(find_after("毛皮代理商")),
        "毛皮名称": _str(find_after("毛皮名称")),
        "片皮厚度_1批": _str(find_after("1批片皮厚度")),
        "片皮厚度_2批": _str(find_after("2批片皮厚度")),
        "选出条数_灰皮": _num(find_after("选出条数")),
        "送货张数_或实际张数": _num(find_after("送货张数") or find_after("实际张数")
                                or find_after("总张数") or find_after("到柜张数")),
        "二层第一批重量": _num(find_after("第一批2层重量")),
        "二层第二批重量": _num(find_after("第二批2层重量")),
        "二层总费用": _num(find_after("二层总费用")),
        "二层平均KG_per_条": _num(find_after("二层平均KG/条")),
        "二层平均元_per_条": _num(find_after("二层平均元/条")),
    }

# ---------- 3. 品检侧 ----------
QC_FILES = {1:"品检日报_1月.xls",2:"品检日报_2月.xls",3:"品检日报_3月.xls",4:"品检日报_4月.xls"}

# 缺陷分类关键词（从备注中识别）
_DEFECT_KWS = ("松面", "整鼓", "面差", "挖刀", "折痕", "皮性", "色差", "厚度")


def _parse_qc_pipei(df, month):
    """解析皮胚检验 sheet。返回的 row 不含 source_sheet（合并后无需区分）"""
    rows = []
    cur_kind = cur_date = cur_cust = None
    for i in range(4, df.shape[0]):
        r = df.iloc[i]
        if r.isna().all(): continue
        c9 = _str(r[9]) if df.shape[1] > 9 else None
        if c9 and "合计" in c9: continue
        k = _str(r[0])
        if k: cur_kind = k
        d = _date(r[1])
        if d: cur_date = d
        c = _str(r[2])
        if c: cur_cust = c
        zh = _num(r[8])
        dh = _str(r[3])
        pz = _str(r[4])
        if zh is None and dh is None and pz is None: continue
        py = _str(r[6])
        row = {
            "month":month,
            "类别":cur_kind,"日期":cur_date,"客户":cur_cust,"单号":dh,
            "品种":pz,"颜色":_str(r[5]),"皮源":py,"厚度":_str(r[7]),
            "检验张数":zh,
            "尺码SF":_num(r[9]) if df.shape[1] > 9 else None,
            "呆滞占比":_num(r[10]) if df.shape[1] > 10 else None,
            "异常数量":_num(r[11]) if df.shape[1] > 11 else None,
            "呆滞数量":_num(r[12]) if df.shape[1] > 12 else None,
            "备注":_str(r[13]) if df.shape[1] > 13 else None,
            "raw_row":i+1,
        }
        _attach_pi_yuan_split(row, py)
        rows.append(row)
    return rows


def _parse_split_table(df, month):
    """专门解析拆分表 "皮胚汇总 (3)/2)"。

    与主表不同：拆分表的列 12 不是数字，而是缺陷描述文本（如 "松面8条留下"）；
    备注列（列 13）通常为空。
    """
    rows = []
    cur_kind = cur_date = cur_cust = None
    for i in range(4, df.shape[0]):
        r = df.iloc[i]
        if r.isna().all(): continue
        c9 = _str(r[9]) if df.shape[1] > 9 else None
        if c9 and "合计" in c9: continue
        k = _str(r[0])
        if k: cur_kind = k
        d = _date(r[1])
        if d: cur_date = d
        c = _str(r[2])
        if c: cur_cust = c
        zh = _num(r[8])
        dh = _str(r[3])
        pz = _str(r[4])
        if zh is None and dh is None and pz is None: continue
        # 拆分表关键：列 12 是缺陷描述文本，备注（列 13）兜底
        defect_text = _str(r[12]) if df.shape[1] > 12 else None
        backup = _str(r[13]) if df.shape[1] > 13 else None
        text_pool = " ".join(t for t in (defect_text, backup) if t)
        rows.append({
            "month":month, "日期":cur_date, "客户":cur_cust,
            "品种":pz, "检验张数":zh, "缺陷文本":text_pool,
        })
    return rows


def _aggregate_defects(split_rows):
    """把拆分表按订单聚合为缺陷分类映射。

    key = (month, 日期, 客户, 品种, 检验张数)  ← 不含皮源（主表/拆分表写法不一）
    value = "松面:8;面差:26" （从缺陷文本中抽缺陷类型 + 数量）
    """
    # 匹配 "<关键词>...<数字>条" 模式
    qty_re = re.compile(r'(\d+)\s*条')
    defect_map = {}
    for r in split_rows:
        key = (r["month"], r["日期"], r["客户"], r["品种"], r["检验张数"])
        text = r.get("缺陷文本") or ""
        if not text:
            continue
        # 同一行可能含多个缺陷描述（如 "松面8条及面差7条留下"）
        # 按"及/，/,"切片，逐段抽缺陷+数量
        segs = re.split(r'[及，,、]', text)
        for seg in segs:
            kw_hit = None
            for kw in _DEFECT_KWS:
                if kw in seg:
                    kw_hit = kw
                    break
            if not kw_hit:
                continue
            m = qty_re.search(seg)
            if not m:
                continue
            qty = int(m.group(1))
            defect_map.setdefault(key, []).append(f"{kw_hit}:{qty}")
    return defect_map


def build_qc_pi_pei(conn):
    """合并版：只保留 "皮胚汇总" 主表为唯一明细，
    "皮胚汇总 (3)/2)" 的拆分按订单聚合为缺陷分类字段附加到主表上。
    """
    main_rows = []
    split_rows = []
    for month, fname in QC_FILES.items():
        xls = pd.ExcelFile(SRC / fname)
        for sh in xls.sheet_names:
            if sh == "皮胚汇总":
                df = pd.read_excel(SRC / fname, sheet_name=sh, header=None)
                main_rows.extend(_parse_qc_pipei(df, month=month))
            elif sh in ("皮胚汇总 (3)", "皮胚汇总 2)"):
                df = pd.read_excel(SRC / fname, sheet_name=sh, header=None)
                split_rows.extend(_parse_split_table(df, month=month))

    # 把拆分行按订单聚合为「缺陷分类」字符串
    defect_map = _aggregate_defects(split_rows)
    matched = 0
    for row in main_rows:
        key = (row["month"], row["日期"], row["客户"], row["品种"],
               row["检验张数"])
        if key in defect_map:
            row["缺陷分类"] = ";".join(defect_map[key])
            matched += 1
        else:
            row["缺陷分类"] = None

    pd.DataFrame(main_rows).to_sql("品检_皮胚检验", conn, if_exists="replace", index=False)
    print(f"  品检_皮胚检验: {len(main_rows)} 行  "
          f"(缺陷分类映射 {matched}/{len(main_rows)} 条；拆分行参考: {len(split_rows)})")

def _parse_qc_chengpin(df, month):
    rows = []
    cur_kind = cur_date = cur_cust = None
    for i in range(4, df.shape[0]):
        r = df.iloc[i]
        if r.isna().all(): continue
        c9 = _str(r[9]) if df.shape[1] > 9 else None
        if c9 and "合计" in c9: continue
        k = _str(r[0])
        if k: cur_kind = k
        d = _date(r[1])
        if d: cur_date = d
        c = _str(r[2])
        if c: cur_cust = c
        zh = _num(r[8]); dh = _str(r[3]); pz = _str(r[4])
        if zh is None and dh is None and pz is None: continue
        py = _str(r[6])
        row = {
            "month":month,
            "类别":cur_kind,"日期":cur_date,"客户":cur_cust,"单号":dh,
            "品种":pz,"颜色":_str(r[5]),"皮源":py,"厚度":_str(r[7]),
            "检验张数":zh,
            "尺码SF":_num(r[9]) if df.shape[1] > 9 else None,
            "不良率":_num(r[10]) if df.shape[1] > 10 else None,
            "异常数量":_num(r[11]) if df.shape[1] > 11 else None,
            "呆滞数量":_num(r[12]) if df.shape[1] > 12 else None,
            "备注":_str(r[13]) if df.shape[1] > 13 else None,
            "raw_row":i+1,
        }
        _attach_pi_yuan_split(row, py)
        rows.append(row)
    return rows

def build_qc_cheng_pin(conn):
    rows = []
    for month, fname in QC_FILES.items():
        df = pd.read_excel(SRC / fname, sheet_name="成品汇总", header=None)
        rows.extend(_parse_qc_chengpin(df, month=month))
    pd.DataFrame(rows).to_sql("品检_成品检验", conn, if_exists="replace", index=False)
    print(f"  品检_成品检验: {len(rows)} 行")

def build_qc_pi_pei_fa(conn):
    rows = []
    for month, fname in QC_FILES.items():
        try:
            df = pd.read_excel(SRC / fname, sheet_name="皮胚发胚日报", header=None)
        except ValueError:
            continue
        for i in range(4, df.shape[0]):
            r = df.iloc[i]
            if r.isna().all(): continue
            if _norm(r[1]) is None and _norm(r[2]) is None: continue
            py = _str(r[8])
            row = {
                "month":month,
                "序号":_str(r[0]),"订单号":_str(r[1]),"客户":_str(r[2]),
                "品种":_str(r[3]),"颜色":_str(r[4]),"厚度":_str(r[5]),
                "片数":_str(r[6]),"尺码":_str(r[7]),"皮源":py,
                "品检员":_str(r[9]),
                "备注":_str(r[10]) if df.shape[1] > 10 else None,
                "raw_row":i+1,
            }
            _attach_pi_yuan_split(row, py)
            rows.append(row)
    pd.DataFrame(rows).to_sql("品检_皮胚发胚日报", conn, if_exists="replace", index=False)
    print(f"  品检_皮胚发胚日报: {len(rows)} 行")

def build_qc_cheng_pin_fa(conn):
    rows = []
    for month, fname in QC_FILES.items():
        try:
            df = pd.read_excel(SRC / fname, sheet_name="成品发胚日报", header=None)
        except ValueError:
            continue
        for i in range(3, df.shape[0]):
            r = df.iloc[i]
            if r.isna().all(): continue
            if _norm(r[1]) is None and _norm(r[3]) is None: continue
            py = _str(r[6])
            row = {
                "month":month,
                "序号":_str(r[0]),"客户":_str(r[1]),"品种":_str(r[2]),
                "颜色":_str(r[3]),"数量":_str(r[4]),"技术员":_str(r[5]),
                "皮源":py,
                "备注":_str(r[7]) if df.shape[1] > 7 else None,
                "raw_row":i+1,
            }
            _attach_pi_yuan_split(row, py)
            rows.append(row)
    pd.DataFrame(rows).to_sql("品检_成品发胚日报", conn, if_exists="replace", index=False)
    print(f"  品检_成品发胚日报: {len(rows)} 行")

def build_qc_dai_zhi_te_li(conn):
    rows = []
    df = pd.read_excel(SRC / QC_FILES[1], sheet_name="皮胚汇总 (2)", header=None)
    for i in range(4, df.shape[0]):
        r = df.iloc[i]
        if r.isna().all(): continue
        c9 = _str(r[9]) if df.shape[1] > 9 else None
        if c9 and "合计" in c9: continue
        if _norm(r[2]) is None and _norm(r[8]) is None: continue
        py = _str(r[6])
        row = {
            "类别":_str(r[0]),"日期":_date(r[1]),"客户":_str(r[2]),"单号":_str(r[3]),
            "品种":_str(r[4]),"颜色":_str(r[5]),"皮源":py,"厚度":_str(r[7]),
            "检验张数":_num(r[8]),
            "尺码SF":_num(r[9]) if df.shape[1] > 9 else None,
            "呆滞占比":_num(r[10]) if df.shape[1] > 10 else None,
            "呆滞数量":_num(r[12]) if df.shape[1] > 12 else None,
            "备注":_str(r[13]) if df.shape[1] > 13 else None,
            "订单负责人":_str(r[22]) if df.shape[1] > 22 else None,
            "品检员":_str(r[24]) if df.shape[1] > 24 else None,
            "工序":_str(r[25]) if df.shape[1] > 25 else None,
            "责任人":_str(r[26]) if df.shape[1] > 26 else None,
            "raw_row":i+1,
        }
        _attach_pi_yuan_split(row, py)
        rows.append(row)
    pd.DataFrame(rows).to_sql("品检_呆滞特例", conn, if_exists="replace", index=False)
    print(f"  品检_呆滞特例: {len(rows)} 行")

# ---------- 呆滞消化：按月份适配列结构 ----------
# 各月 Sheet2 的列位置映射（None 表示该月没有这个字段）
# 字段顺序：日期/类别/客户/品种/颜色/数量_条/数量_SF/皮源/原责任
SHEET2_LAYOUT = {
    1: {
        # 1 月只有 6 列（无类别/客户/原责任）
        "出库": {"日期":0, "类别":None, "客户":None, "品种":1, "颜色":2,
                "数量_条":3, "数量_SF":4, "皮源":5, "原责任":None},
        "套染": {"日期":7, "类别":None, "客户":None, "品种":8, "颜色":9,
                "数量_条":10, "数量_SF":11, "皮源":12, "原责任":None},
    },
    3: {
        # 3 月 9 列：多了类别/客户/原责任
        "出库": {"日期":0, "类别":1, "客户":2, "品种":3, "颜色":4,
                "数量_条":5, "数量_SF":6, "皮源":7, "原责任":8},
        "套染": {"日期":10, "类别":11, "客户":12, "品种":13, "颜色":14,
                "数量_条":15, "数量_SF":16, "皮源":17, "原责任":18},
    },
    4: {
        # 4 月 7 列：多了类别，但没有客户/原责任
        "出库": {"日期":0, "类别":1, "客户":None, "品种":2, "颜色":3,
                "数量_条":4, "数量_SF":5, "皮源":6, "原责任":None},
        "套染": {"日期":8, "类别":9, "客户":None, "品种":10, "颜色":11,
                "数量_条":12, "数量_SF":13, "皮源":14, "原责任":None},
    },
}


def _parse_dai_zhi(df, month):
    """按月份配置列号解析呆滞消化 Sheet2。

    输出统一 schema：month/消化类型/日期/类别/客户/品种/颜色/数量_条/数量_SF/皮源/原责任
    """
    rows = []
    layout = SHEET2_LAYOUT[month]
    for i in range(3, df.shape[0]):
        r = df.iloc[i]
        for xh_type in ("出库", "套染"):
            cfg = layout[xh_type]
            d_col = cfg["日期"]
            q_col = cfg["数量_条"]
            if d_col >= df.shape[1] or q_col >= df.shape[1]:
                continue
            # 至少日期或数量有值才算一行
            if pd.isna(r[d_col]) and pd.isna(r[q_col]):
                continue
            def cell(name, fn=_str):
                c = cfg[name]
                if c is None or c >= df.shape[1]:
                    return None
                return fn(r[c])
            py = cell("皮源", _str)
            row = {
                "month": month,
                "消化类型": xh_type,
                "日期": cell("日期", _date),
                "类别": cell("类别", _str),
                "客户": cell("客户", _str),
                "品种": cell("品种", _str),
                "颜色": cell("颜色", _str),
                "数量_条": cell("数量_条", _num),
                "数量_SF": cell("数量_SF", _num),
                "皮源": py,
                "原责任": cell("原责任", _str),
                "raw_row": i + 1,
            }
            _attach_pi_yuan_split(row, py)
            rows.append(row)
    return rows


def build_qc_dai_zhi_xiao_hua(conn):
    rows = []
    for month in [1, 3, 4]:  # 2 月 = 1 月，跳过
        df = pd.read_excel(SRC / QC_FILES[month], sheet_name="Sheet2", header=None)
        rows.extend(_parse_dai_zhi(df, month=month))
    pd.DataFrame(rows).to_sql("品检_呆滞消化", conn, if_exists="replace", index=False)
    print(f"  品检_呆滞消化: {len(rows)} 行")

def build_qc_pi_yuan_cumulative(conn):
    rows = []
    df = pd.read_excel(SRC / QC_FILES[1], sheet_name="皮源入库", header=None)
    cur_date = cur_name = cur_level = None
    for i in range(4, df.shape[0]):
        r = df.iloc[i]
        if r.isna().all(): continue
        d = _date(r[0])
        if d: cur_date = d
        n = _str(r[1])
        if n: cur_name = n
        lv = _str(r[2])
        if lv: cur_level = lv
        zhang = _num(r[3])
        sf = _num(r[4])
        if zhang is None and sf is None: continue
        row = {
            "日期":cur_date,"名称":cur_name,"级别":cur_level,
            "张数":zhang,"尺码SF":sf,"raw_row":i+1,
        }
        # 名称里可能含批次/产地，也做拆分
        _attach_pi_yuan_split(row, cur_name)
        rows.append(row)
    pd.DataFrame(rows).to_sql("品检_皮源入库累积", conn, if_exists="replace", index=False)
    print(f"  品检_皮源入库累积: {len(rows)} 行")

def build_qc_inventory_snapshot(conn):
    rows = []
    df = pd.read_excel(SRC / QC_FILES[1], sheet_name="Sheet1", header=None)
    month_cols = [(8, [0,1,2,3,4,5]), (9, [6,7,8,9,10,11]), (10, [11,12,13,14,15,16])]
    for i in range(2, df.shape[0]):
        r = df.iloc[i]
        if r.isna().all(): continue
        for month, cols in month_cols:
            cc, cu, cq, cs, cdq, cds = cols
            cat = _str(r[cc]) if cc < df.shape[1] else None
            unit = _str(r[cu]) if cu < df.shape[1] else None
            qty = _num(r[cq]) if cq < df.shape[1] else None
            sf = _num(r[cs]) if cs < df.shape[1] else None
            dq = _num(r[cdq]) if cdq < df.shape[1] else None
            ds = _num(r[cds]) if cds < df.shape[1] else None
            if unit is None and qty is None and sf is None: continue
            rows.append({"month":month,"品类":cat,"单位":unit,"数量":qty,
                "SF":sf,"变动数量":dq,"变动SF":ds,"raw_row":i+1})
    df_out = pd.DataFrame(rows)
    if not df_out.empty:
        df_out["品类"] = df_out.groupby("month")["品类"].ffill()
    df_out.to_sql("品检_库存月度快照", conn, if_exists="replace", index=False)
    print(f"  品检_库存月度快照: {len(df_out)} 行")


# ---------- 4. Sanity Check ----------
def sanity_check(conn):
    """构建期校验：发现明显的数据异常立即告警"""
    issues = []
    cur = conn.cursor()
    # 1. 呆滞消化：数量_条 不应远大于 数量_SF（条数应远小于 SF）
    n = cur.execute("""
        SELECT COUNT(*) FROM "品检_呆滞消化"
        WHERE 数量_条 IS NOT NULL AND 数量_SF IS NOT NULL
          AND 数量_条 > 数量_SF AND 数量_条 > 1000
    """).fetchone()[0]
    if n > 0:
        issues.append(f"⚠ 呆滞消化表有 {n} 行 '数量_条 > 数量_SF 且 > 1000'，疑似字段错位")
    # 2. 皮胚检验：呆滞数量 ≤ 检验张数
    n = cur.execute("""
        SELECT COUNT(*) FROM "品检_皮胚检验"
        WHERE 呆滞数量 IS NOT NULL AND 呆滞数量 > 检验张数
    """).fetchone()[0]
    if n > 0:
        issues.append(f"⚠ 皮胚检验表有 {n} 行 '呆滞数量 > 检验张数'")
    # 3. 皮胚检验：呆滞数量 / 检验张数 ≈ 呆滞占比
    n = cur.execute("""
        SELECT COUNT(*) FROM "品检_皮胚检验"
        WHERE 呆滞数量 IS NOT NULL AND 呆滞占比 IS NOT NULL
          AND 检验张数 > 0
          AND ABS(呆滞数量*1.0/检验张数 - 呆滞占比) > 0.05
    """).fetchone()[0]
    if n > 0:
        issues.append(f"⚠ 皮胚检验表有 {n} 行 呆滞数量/占比 不自洽（差 >5pp）")
    # 4. 主表汇总呆滞率验证（应在 5-15% 之间）
    rate = cur.execute("""
        SELECT ROUND(SUM(呆滞数量) * 100.0 / SUM(检验张数), 2)
        FROM "品检_皮胚检验" WHERE 检验张数 > 0
    """).fetchone()[0]
    print(f"\n  整体加权呆滞率: {rate}%（健康区间约 5-15%）")
    return issues


def main():
    if DB_PATH.exists(): DB_PATH.unlink()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        print("="*60)
        print("[1/3] 采购侧:")
        build_purchase_pi_yuan(conn)
        print("\n[2/3] 进口毛皮:")
        build_import_fur(conn)
        print("\n[3/3] 品检侧:")
        build_qc_pi_pei(conn)
        build_qc_cheng_pin(conn)
        build_qc_pi_pei_fa(conn)
        build_qc_cheng_pin_fa(conn)
        build_qc_dai_zhi_te_li(conn)
        build_qc_dai_zhi_xiao_hua(conn)
        build_qc_pi_yuan_cumulative(conn)
        build_qc_inventory_snapshot(conn)
        conn.commit()
        print("\n" + "="*60)
        print("[4/4] Sanity Check:")
        issues = sanity_check(conn)
        if issues:
            for s in issues:
                print(f"  {s}")
        else:
            print("  ✓ 全部硬约束通过")
        print("\n" + "="*60)
        print(f"完成: {DB_PATH}")
    finally:
        conn.close()

if __name__ == "__main__":
    main()
