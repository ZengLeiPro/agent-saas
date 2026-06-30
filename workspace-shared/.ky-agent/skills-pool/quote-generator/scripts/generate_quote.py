#!/usr/bin/env python3
"""报价书生成器
读取 JSON 数据 → 渲染 HTML → 转换 PDF

Usage:
    python3 generate_quote.py <input.json> [output_dir]

输出三个文件到 output_dir:
    - {customer}_报价书.html
    - {customer}_报价书.pdf
    - {customer}_报价书.json
"""

import json
import sys
import os
import re
import base64
import html as html_lib
import shutil
import subprocess
import tempfile
from pathlib import Path

import mistune

SCRIPT_DIR = Path(__file__).parent
LOGOS_DIR = SCRIPT_DIR / "logos"
PLACEHOLDER_IMAGE = "data:image/svg+xml;base64," + base64.b64encode(
    b'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="100%" height="100%" fill="#f5f5f5"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#777" font-size="24">image unavailable</text></svg>'
).decode("utf-8")


def esc(value):
    """HTML-escape user supplied text fields."""
    return html_lib.escape(str(value), quote=True)


def today_ymd():
    from datetime import datetime
    return datetime.now().strftime("%Y%m%d")


def default_output_dir():
    return os.path.join(os.getcwd(), "assets", today_ymd(), "quotes")


def safe_file_stem(value, fallback):
    stem = re.sub(r"\s+", "", str(value or ""))
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", stem)
    stem = re.sub(r"[^0-9A-Za-z\u3400-\u9fff._-]+", "_", stem)
    stem = re.sub(r"_+", "_", stem).strip("._-")
    if not stem:
        stem = fallback
    return stem[:24]


def resolve_inside(base_dir, filename):
    base = Path(base_dir).resolve()
    target = (base / filename).resolve()
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise ValueError(f"Refusing to write outside output directory: {filename}") from exc
    return str(target)


def unique_output_paths(output_dir, base_name):
    from datetime import datetime
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    for i in range(100):
        suffix = "" if i == 0 else f"_{stamp}" if i == 1 else f"_{stamp}_{i}"
        name = f"{base_name}{suffix}"
        html_path = resolve_inside(output_dir, f"{name}.html")
        pdf_path = resolve_inside(output_dir, f"{name}.pdf")
        json_path = resolve_inside(output_dir, f"{name}.json")
        if not any(os.path.exists(p) for p in (html_path, pdf_path, json_path)):
            return html_path, pdf_path, json_path
    raise RuntimeError("Unable to find a non-conflicting output filename")


def load_logo_base64(name):
    """从 logos 目录加载图片并转为 base64"""
    path = LOGOS_DIR / name
    if not path.exists():
        return ""
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def fmt_price(price):
    """格式化价格：整数用千分位，0 显示为 0"""
    if price == 0:
        return "0"
    if price == int(price):
        return f"{int(price):,}"
    return f"{price:,.2f}"


def embed_images(html, base_dir):
    """将 HTML 中的 img src 转换为 base64 内嵌"""
    base = Path(base_dir).resolve()

    def _replace(match):
        src = match.group(1)
        if src.startswith("data:"):
            return match.group(0)
        try:
            if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", src) or os.path.isabs(src):
                raise ValueError("only relative image paths under the Markdown directory are allowed")

            clean_src = src.split("?", 1)[0].split("#", 1)[0]
            path = (base / clean_src).resolve()
            path.relative_to(base)
            with open(path, "rb") as f:
                data = f.read()

            ext = src.rsplit(".", 1)[-1].lower().split("?")[0]
            mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                        "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml"}
            mime = mime_map.get(ext, "image/png")
            b64 = base64.b64encode(data).decode("utf-8")
            return f'src="data:{mime};base64,{b64}"'
        except Exception as e:
            print(f"Warning: 图片嵌入失败 {src}: {e}", file=sys.stderr)
            return f'src="{PLACEHOLDER_IMAGE}"'

    return re.sub(r'src="([^"]+)"', _replace, html)


def render_solution(solution_data, json_dir):
    """读取 Markdown 文件并渲染为 HTML，图片自动 base64 内嵌"""
    md_file = solution_data.get("file", "")
    if not md_file:
        return ""

    # 相对路径基于 JSON 文件所在目录解析，不允许绝对路径或跳出目录。
    json_base = Path(json_dir).resolve()
    if os.path.isabs(md_file):
        print(f"Warning: 方案文件必须是 JSON 目录下的相对路径，已忽略 {md_file}", file=sys.stderr)
        return ""
    try:
        md_path = (json_base / md_file).resolve()
        md_path.relative_to(json_base)
    except ValueError:
        print(f"Warning: 方案文件路径不能跳出 JSON 目录，已忽略 {md_file}", file=sys.stderr)
        return ""
    md_file = str(md_path)

    if not os.path.exists(md_file):
        print(f"Warning: 方案文件不存在 {md_file}", file=sys.stderr)
        return ""

    with open(md_file, encoding="utf-8") as f:
        md_content = f.read()

    md = mistune.create_markdown(plugins=["table", "strikethrough"], escape=True)
    html = md(md_content)
    html = embed_images(html, os.path.dirname(os.path.abspath(md_file)))

    title = solution_data.get("title", "")
    title_html = f'<div class="solution-main-title">{esc(title)}</div>' if title else ""

    return f"""
    <hr class="solution-divider">
    {title_html}
    <div class="solution-content">
        {html}
    </div>"""


def build_service_table(table):
    """构建单个服务报价表 HTML"""
    # 检测是否有 remark 列
    has_remark = any(item.get("remark") is not None for item in table["items"])
    total_cols = 8 if has_remark else 7
    content_colspan = 4
    summary_colspan = total_cols - 1

    remark_header = '<td class="center bold" style="width:10%">备注</td>' if has_remark else ""

    rows = ""
    for idx, item in enumerate(table["items"], 1):
        desc = ""
        if item.get("description"):
            desc = f'<br><span class="item-desc">{esc(item["description"])}</span>'
        remark_cell = f'<td class="center">{esc(item.get("remark", "-"))}</td>' if has_remark else ""
        rows += f"""
            <tr>
                <td class="center">{idx}</td>
                <td colspan="{content_colspan}">{esc(item["name"])}{desc}</td>
                <td class="center">{esc(item["chargeType"])}</td>
                <td class="right bold">{fmt_price(item["price"])}</td>
                {remark_cell}
            </tr>"""

    summary = ""
    for row in table.get("summaryRows", []):
        if row.get("highlight") and has_remark:
            summary += f"""
            <tr class="summary-row highlight-row">
                <td colspan="{total_cols - 2}" class="right bold">{esc(row["label"])}</td>
                <td class="right bold" colspan="2">{fmt_price(row["value"])}</td>
            </tr>"""
        else:
            remark_empty = '<td class="center">-</td>' if has_remark else ""
            summary += f"""
            <tr class="summary-row">
                <td colspan="{summary_colspan - (1 if has_remark else 0)}" class="right bold">{esc(row["label"])}</td>
                <td class="right bold">{fmt_price(row["value"])}</td>
                {remark_empty}
            </tr>"""

    return f"""
        <table class="price-table">
            <tr class="section-header">
                <td colspan="{total_cols}" class="bold">{esc(table["title"])}</td>
            </tr>
            <tr class="col-header">
                <td class="center bold" style="width:8%">序号</td>
                <td colspan="{content_colspan}" class="bold">项目</td>
                <td class="center bold" style="width:12%">收费方式</td>
                <td class="center bold" style="width:14%">总价（元）</td>
                {remark_header}
            </tr>
            {rows}
            {summary}
        </table>"""


def build_detailed_table(table):
    """构建详细报价表 HTML（含规格、单价、数量列，用于软件/硬件类报价）"""
    rows = ""
    for idx, item in enumerate(table["items"], 1):
        desc = ""
        if item.get("description"):
            desc = f'<br><span class="item-desc">{esc(item["description"])}</span>'
        remark = item.get("remark", "-")
        rows += f"""
            <tr>
                <td class="center">{idx}</td>
                <td>{esc(item["name"])}{desc}</td>
                <td class="center">{esc(item.get("spec", ""))}</td>
                <td class="center">{esc(item["chargeType"])}</td>
                <td class="right">{fmt_price(item["unitPrice"])}</td>
                <td class="center">{esc(item["quantity"])}</td>
                <td class="right bold">{fmt_price(item["total"])}</td>
                <td class="center">{esc(remark)}</td>
            </tr>"""

    summary = ""
    for row in table.get("summaryRows", []):
        if row.get("highlight"):
            summary += f"""
            <tr class="summary-row highlight-row">
                <td colspan="6" class="right bold">{esc(row["label"])}</td>
                <td class="right bold" colspan="2">{fmt_price(row["value"])}</td>
            </tr>"""
        else:
            summary += f"""
            <tr class="summary-row">
                <td colspan="6" class="right bold">{esc(row["label"])}</td>
                <td class="right bold">{fmt_price(row["value"])}</td>
                <td class="center">-</td>
            </tr>"""

    return f"""
        <table class="price-table">
            <tr class="section-header">
                <td colspan="8" class="bold">{esc(table["title"])}</td>
            </tr>
            <tr class="col-header">
                <td class="center bold" style="width:6%">序号</td>
                <td class="center bold">项目</td>
                <td class="center bold" style="width:10%">规格</td>
                <td class="center bold" style="width:11%">收费方式</td>
                <td class="center bold" style="width:12%">单价（元）</td>
                <td class="center bold" style="width:7%">数量</td>
                <td class="center bold" style="width:12%">总价（元）</td>
                <td class="center bold" style="width:8%">备注</td>
            </tr>
            {rows}
            {summary}
        </table>"""


def build_attachment(att):
    """构建附件说明表 HTML"""
    modules = att["modules"]
    has_category = any(mod.get("category") for mod in modules)
    if has_category:
        return _build_attachment_with_category(att)
    return _build_attachment_simple(att)


def _build_attachment_with_category(att):
    """构建带功能分类的附件表（三列：功能分类、业务模块、功能描述）"""
    modules = att["modules"]
    groups = []
    current_cat = None
    current_group = []
    for mod in modules:
        cat = mod.get("category", "")
        if cat != current_cat:
            if current_group:
                groups.append((current_cat, current_group))
            current_cat = cat
            current_group = [mod]
        else:
            current_group.append(mod)
    if current_group:
        groups.append((current_cat, current_group))

    rows = ""
    for cat, mods in groups:
        for i, mod in enumerate(mods):
            features = "<ol>" + "".join(f"<li>{esc(f)}</li>" for f in mod["features"]) + "</ol>"
            cat_cell = ""
            if i == 0:
                cat_cell = f'<td class="center module-category" rowspan="{len(mods)}">{esc(cat)}</td>'
            rows += f"""
                <tr>
                    {cat_cell}
                    <td class="module-name">{esc(mod["name"])}</td>
                    <td class="module-desc">{features}</td>
                </tr>"""

    return f"""
        <div class="attachment-title bold">{esc(att["title"])}</div>
        <table class="att-table">
            <tr class="col-header">
                <td class="center bold" style="width:12%">功能分类</td>
                <td class="center bold" style="width:15%">业务模块</td>
                <td class="bold">功能描述</td>
            </tr>
            {rows}
        </table>"""


def _build_attachment_simple(att):
    """构建简单附件表（两列：业务模块、功能详细描述，向后兼容）"""
    modules = ""
    for mod in att["modules"]:
        features = "<ul>" + "".join(f"<li>{esc(f)}</li>" for f in mod["features"]) + "</ul>"
        modules += f"""
            <tr>
                <td class="module-name">{esc(mod["name"])}</td>
                <td class="module-desc">{features}</td>
            </tr>"""

    return f"""
        <div class="attachment-title bold">{esc(att["title"])}</div>
        <table class="att-table">
            <tr class="col-header">
                <td class="bold" style="width:25%">业务模块</td>
                <td class="bold">功能详细描述</td>
            </tr>
            {modules}
        </table>"""


def generate_html(data, json_dir):
    """根据 JSON 数据生成完整 HTML"""
    customer = data["customer"]
    title = data.get("title", "钉钉数字化解决方案报价书")
    quoter = data["quoter"]
    date = data["date"]
    valid_days = data.get("validDays", 30)

    kaiyan_b64 = load_logo_base64("kaiyan.png")
    show_dingtalk = data.get("showDingtalkLogo", True)
    dingtalk_b64 = load_logo_base64("dingtalk.png") if show_dingtalk else ""

    # 服务报价表
    tables_html = ""
    for i, tbl in enumerate(data.get("serviceTables", [])):
        if i > 0:
            tables_html += '<div class="table-gap"></div>'
        if tbl.get("type") == "detailed":
            tables_html += build_detailed_table(tbl)
        else:
            tables_html += build_service_table(tbl)

    # 报价表后的补充说明
    extra_notes = data.get("extraNotes", "")
    extra_notes_html = ""
    if extra_notes:
        md = mistune.create_markdown(plugins=["table", "strikethrough"], escape=True)
        extra_notes_html = f'<div class="extra-notes">{md(extra_notes)}</div>'

    # 附件说明
    att_html = ""
    for att in data.get("attachments", []):
        att_html += build_attachment(att)

    # 解决方案文档（可选）
    solution_html = ""
    if data.get("solution"):
        solution_html = render_solution(data["solution"], json_dir)

    # 页脚备注
    notes = data.get("footerNotes", [
        "如有任何问题，欢迎随时致电。",
        "此报价表为意向性报价，有效期内可参照查看。贵方应严守保密义务，不得向第三方披露。"
    ])
    notes_html = "".join(f"<li>{esc(n)}</li>" for n in notes)

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{esc(customer)} - {esc(title)}</title>
<style>
/* === 基础 === */
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
    font-family: "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "Heiti SC", "STHeiti", "PingFang SC", Arial, sans-serif;
    font-size: 13px;
    color: #333;
    background: #f5f5f5;
    -webkit-font-smoothing: antialiased;
}}
.page {{
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto;
    padding: 22mm 20mm 20mm 20mm;
    background: #fff;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
}}

/* === 头部 === */
.header {{
    margin-bottom: 28px;
    padding-bottom: 18px;
    border-bottom: 1px solid #2E56E1;
}}
.header-top {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
}}
.header-title {{
    flex: 1;
}}
.customer-name {{
    font-size: 18px;
    font-weight: 700;
    color: #2E56E1;
    line-height: 1.5;
    margin-bottom: 4px;
}}
.doc-title {{
    font-size: 18px;
    font-weight: 700;
    color: #2E56E1;
    line-height: 1.5;
}}
.header-logos {{
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
    padding-top: 2px;
}}
.logo-kaiyan {{
    height: 52px;
    width: auto;
}}
.logo-dingtalk {{
    height: 36px;
    width: auto;
}}
.header-meta {{
    padding-top: 4px;
}}
.meta-item {{
    font-size: 13px;
    color: #595959;
    line-height: 2;
}}

/* === 报价清单标题 === */
.section-title {{
    text-align: center;
    font-size: 15px;
    font-weight: 700;
    color: #595959;
    margin: 10px 0 18px;
}}

/* === 报价表 === */
.price-table {{
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 0;
}}
.price-table td {{
    border: 1px solid #d9d9d9;
    padding: 9px 12px;
    font-size: 13px;
    color: #333;
    vertical-align: middle;
}}
.price-table .section-header td {{
    background: #eef2ff;
    font-size: 13.5px;
    padding: 10px 12px;
}}
.price-table .col-header td {{
    background: #fafafa;
    text-align: center;
}}
.price-table .summary-row td {{
    background: #fafafa;
}}
.item-desc {{
    font-size: 12px;
    color: #888;
}}
.center {{ text-align: center; }}
.right {{ text-align: right; }}
.bold {{ font-weight: 700; }}

.table-gap {{
    height: 40px;
}}

/* === 补充说明 === */
.extra-notes {{
    margin: 20px 0 0;
    font-size: 13px;
    color: #333;
    line-height: 1.8;
}}
.extra-notes p {{
    margin-bottom: 6px;
}}

/* === 附件 === */
.attachment-title {{
    font-size: 14px;
    color: #333;
    margin: 30px 0 14px;
}}
.att-table {{
    width: 100%;
    border-collapse: collapse;
}}
.att-table td {{
    border: 1px solid #d9d9d9;
    padding: 10px 14px;
    font-size: 13px;
    color: #333;
    vertical-align: top;
}}
.att-table .col-header td {{
    background: #fafafa;
}}
.module-name {{
    font-weight: 500;
}}
.module-desc ul {{
    margin: 0;
    padding-left: 18px;
}}
.module-desc li {{
    margin-bottom: 6px;
    line-height: 1.7;
}}
.module-desc ol {{
    margin: 0;
    padding-left: 18px;
}}
.highlight-row td {{
    background: #eef2ff !important;
}}
.module-category {{
    font-weight: 500;
    vertical-align: middle;
}}

/* === 解决方案文档 === */
.solution-divider {{
    border: none;
    border-top: 1px solid #d9d9d9;
    margin: 36px 0 24px;
}}
.solution-main-title {{
    font-size: 16px;
    font-weight: 700;
    color: #333;
    text-align: center;
    margin-bottom: 24px;
}}
.solution-content {{
    font-size: 13.5px;
    color: #333;
    line-height: 1.8;
}}
.solution-content h1 {{
    font-size: 18px;
    font-weight: 700;
    margin: 28px 0 14px;
    color: #222;
}}
.solution-content h2 {{
    font-size: 15px;
    font-weight: 700;
    margin: 24px 0 12px;
    color: #222;
}}
.solution-content h3 {{
    font-size: 14px;
    font-weight: 700;
    margin: 18px 0 10px;
    color: #333;
}}
.solution-content h4 {{
    font-size: 13.5px;
    font-weight: 700;
    margin: 14px 0 8px;
    color: #333;
}}
.solution-content p {{
    margin-bottom: 10px;
}}
.solution-content ul, .solution-content ol {{
    padding-left: 22px;
    margin-bottom: 12px;
}}
.solution-content li {{
    margin-bottom: 5px;
}}
.solution-content li > ul, .solution-content li > ol {{
    margin-top: 4px;
    margin-bottom: 4px;
}}
.solution-content img {{
    max-width: 100%;
    height: auto;
    margin: 14px 0;
    border-radius: 4px;
}}
.solution-content table {{
    width: 100%;
    border-collapse: collapse;
    margin: 14px 0;
    font-size: 12.5px;
}}
.solution-content table th,
.solution-content table td {{
    border: 1px solid #d9d9d9;
    padding: 8px 12px;
    vertical-align: top;
    text-align: left;
}}
.solution-content table th {{
    background: #fafafa;
    font-weight: 700;
}}
.solution-content table ul {{
    margin: 0;
    padding-left: 16px;
}}
.solution-content table li {{
    margin-bottom: 4px;
    line-height: 1.6;
}}
.solution-content blockquote {{
    border-left: 3px solid #2E56E1;
    padding: 8px 16px;
    margin: 12px 0;
    color: #555;
    background: #f9f9ff;
}}
.solution-content hr {{
    border: none;
    border-top: 1px solid #e5e5e5;
    margin: 20px 0;
}}
.solution-content a {{
    color: #2E56E1;
    text-decoration: none;
}}

/* === 页脚 === */
.divider {{
    border: none;
    border-top: 1px solid #d9d9d9;
    margin: 32px 0 14px;
}}
.footer-notes {{
    list-style: disc;
    padding-left: 18px;
    color: #7F7F7F;
    font-size: 12px;
    line-height: 1.9;
}}

/* === 打印 === */
@media print {{
    body {{ background: #fff; }}
    .page {{
        width: 100%;
        margin: 0;
        padding: 0;
        box-shadow: none;
        min-height: auto;
    }}
    .price-table, .att-table {{
        page-break-inside: avoid;
    }}
    .solution-divider {{
        page-break-before: always;
    }}
}}
</style>
</head>
<body>
<div class="page">

    <!-- 头部 -->
    <div class="header">
        <div class="header-top">
            <div class="header-title">
                <div class="customer-name">{esc(customer)}</div>
                <div class="doc-title">{esc(title)}</div>
            </div>
            <div class="header-logos">
                <img src="data:image/png;base64,{kaiyan_b64}" class="logo-kaiyan" alt="开沿科技">
                {'<img src="data:image/png;base64,' + dingtalk_b64 + '" class="logo-dingtalk" alt="钉钉">' if dingtalk_b64 else ''}
            </div>
        </div>
        <div class="header-meta">
            <div class="meta-item">报价方：{esc(quoter["company"])}</div>
            <div class="meta-item">报价人：{esc(quoter["name"])}</div>
            <div class="meta-item">电话：{esc(quoter["phone"])}</div>
            <div class="meta-item">报价日期：{esc(date)}</div>
            <div class="meta-item">有效期：{esc(valid_days)} 天</div>
        </div>
    </div>

    <!-- 报价清单 -->
    <div class="section-title">报价清单明细表</div>

    {tables_html}

    {extra_notes_html}

    <!-- 附件 -->
    {att_html}

    <!-- 解决方案文档 -->
    {solution_html}

    <!-- 页脚 -->
    <hr class="divider">
    <ul class="footer-notes">
        {notes_html}
    </ul>

</div>
</body>
</html>"""
    return html


def html_to_pdf(html_path, pdf_path):
    """将 HTML 转换为 PDF。

    优先 Playwright(chromium)；如果当前 ACS 镜像缺少 Node Playwright、
    浏览器启动失败或运行超时，则自动降级到 weasyprint。
    """
    if _chromium_pdf(html_path, pdf_path):
        return
    print("chromium 不可用，降级使用 weasyprint 生成 PDF...", file=sys.stderr)
    if _weasyprint_pdf(html_path, pdf_path):
        return
    print("PDF 生成失败：chromium 与 weasyprint 均不可用，仅产出 HTML。", file=sys.stderr)
    sys.exit(1)


def _chromium_pdf(html_path, pdf_path):
    """用 Playwright(chromium) 渲染 PDF，成功返回 True，失败返回 False。"""
    abs_html = Path(html_path).resolve()
    abs_pdf = str(Path(pdf_path).resolve())
    html_url = abs_html.as_uri()
    script = f"""
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: true }});
    const page = await browser.newPage();
    await page.goto({json.dumps(html_url)}, {{ waitUntil: 'networkidle' }});
    await page.pdf({{
        path: {json.dumps(abs_pdf)},
        format: 'A4',
        margin: {{ top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' }},
        printBackground: true
    }});
    await browser.close();
    console.log('PDF generated: ' + {json.dumps(abs_pdf)});
}})();
"""
    try:
        result = subprocess.run(
            ["node", "-e", script],
            capture_output=True, text=True, timeout=60
        )
    except Exception as e:
        print(f"chromium 调用异常: {e}", file=sys.stderr)
        return False
    if result.returncode != 0:
        print(f"chromium 渲染失败: {result.stderr.strip()}", file=sys.stderr)
        return False
    print(result.stdout.strip())
    return True


def _weasyprint_pdf(html_path, pdf_path):
    """用 weasyprint 渲染 PDF（chromium 的兜底路径）。成功返回 True，失败返回 False。"""
    # fontconfig 缓存目录指向可写临时目录，消除受限环境下的缓存写入报错
    os.environ.setdefault("XDG_CACHE_HOME", os.path.join(tempfile.gettempdir(), "fccache"))
    try:
        from weasyprint import HTML, CSS
    except Exception as e:
        print(f"weasyprint 不可用（未安装或导入失败）: {e}", file=sys.stderr)
        return False
    try:
        # 补 @page 边距，对齐 chromium 路径的页边距（上下 18mm / 左右 16mm）
        page_css = CSS(string="@page { size: A4; margin: 18mm 16mm; }")
        HTML(filename=os.path.abspath(html_path)).write_pdf(
            os.path.abspath(pdf_path), stylesheets=[page_css]
        )
    except Exception as e:
        print(f"weasyprint 渲染失败: {e}", file=sys.stderr)
        return False
    print(f"PDF generated (weasyprint): {os.path.abspath(pdf_path)}")
    return True


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    input_file = sys.argv[1]
    output_dir = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else default_output_dir())

    with open(input_file, encoding="utf-8") as f:
        data = json.load(f)

    json_dir = os.path.dirname(os.path.abspath(input_file))
    os.makedirs(output_dir, exist_ok=True)

    # 文件名
    customer_short = safe_file_stem(data["customer"], "customer")
    base_name = f"{customer_short}_报价书"
    html_path, pdf_path, json_path = unique_output_paths(output_dir, base_name)

    # 生成 HTML
    html = generate_html(data, json_dir)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"HTML: {html_path}")

    # 复制 JSON（输入输出同文件时跳过）
    if os.path.abspath(input_file) != os.path.abspath(json_path):
        shutil.copy2(input_file, json_path)
    print(f"JSON: {json_path}")

    # 转换 PDF
    html_to_pdf(html_path, pdf_path)


if __name__ == "__main__":
    main()
