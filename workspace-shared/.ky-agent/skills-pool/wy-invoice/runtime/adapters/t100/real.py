"""T100 HTTP 接口实现。"""

from __future__ import annotations

import json
import os
import re
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


BEIJING = ZoneInfo("Asia/Shanghai")


def _money(value) -> str:
    if value is None:
        return ""
    return str(value)


def _beijing_date(value: str | None) -> str:
    if not value:
        return ""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=BEIJING)
    return parsed.astimezone(BEIJING).date().isoformat()


def normalize_order(row: dict) -> dict:
    """把客户中文字段归一成主流程契约，密码只保留在受脱敏保护的专用键。"""
    statement_no = row.get("对账单号") or row.get("开票单号")
    remark = row.get("发票备注") or row.get("备注") or ""
    return {
        "customer": row.get("客户简称") or "",
        "customer_code": str(row.get("客户编号") or ""),
        "statement_no": str(statement_no or ""),
        "billing_no": str(row.get("开票单号") or ""),
        "invoice_no": str(row.get("发票号码") or ""),
        "invoice_remark": str(remark).strip(),
        "amount_excl_tax": _money(row.get("原币税前")),
        "tax": _money(row.get("原币税额")),
        "amount_incl_tax": _money(row.get("原币含税")),
        "invoice_url": row.get("电子发票URL") or "",
        "invoice_date": _beijing_date(row.get("发票日期")),
        "reconciliation_name": row.get("客户系统对账名称") or "",
        "portal_url": row.get("客户系统网址") or "",
        "portal_username": row.get("客户系统账号") or "",
        "portal_password": row.get("客户系统密码") or "",
        "uploaded": row.get("客户系统发票是否已录"),
    }


class T100Http:
    def __init__(self, cfg: dict):
        api = cfg.get("t100", {})
        self.order_url = os.environ.get("WAIN_T100_ORDER_URL") or api.get("order_url")
        self.excel_url = os.environ.get("WAIN_T100_EXCEL_URL") or api.get("excel_url")
        self.mark_uploaded_url = (
            os.environ.get("WAIN_T100_MARK_UPLOADED_URL")
            or api.get("mark_uploaded_url")
        )
        self.timeout = float(api.get("timeout_seconds", api.get("timeout", 30)))

    @property
    def supports_mark_uploaded(self) -> bool:
        # 接口 URL 本身不等于接口契约；当前没有请求字段/成功响应定义。
        return False

    async def fetch_pending_invoices(self) -> list[dict]:
        if not self.order_url:
            raise RuntimeError("未配置 t100.order_url")
        payload, _ = await self._request(self.order_url)
        result = json.loads(payload.decode("utf-8"))
        if result.get("code") != 200 or not result.get("success"):
            raise RuntimeError(
                f"T100 订单接口失败：code={result.get('code')} "
                f"message={result.get('message')!r}"
            )
        return [normalize_order(row) for row in result.get("data") or []]

    async def download_invoice_files(self, task: dict) -> list[str]:
        url = task.get("invoice_url")
        if not url:
            return []
        payload, headers = await self._request(url, method="GET")
        suffix = _suffix_from_headers(headers, default=".pdf")
        path = self._run_dir() / f"电子发票-{_safe_name(task['invoice_no'])}{suffix}"
        path.write_bytes(payload)
        return [str(path)]

    async def get_match_excel(self, task: dict) -> str:
        if not self.excel_url:
            raise RuntimeError("未配置 t100.excel_url")
        query = urllib.parse.urlencode({"dh": task["statement_no"]})
        url = f"{self.excel_url}{'&' if '?' in self.excel_url else '?'}{query}"
        payload, headers = await self._request(url)
        if payload[:1] in (b"{", b"["):
            try:
                error = json.loads(payload.decode("utf-8"))
            except Exception:
                error = payload[:200].decode("utf-8", errors="replace")
            raise RuntimeError(f"T100 对账 Excel 接口返回了 JSON/错误内容：{error}")
        filename = _filename_from_headers(headers)
        suffix = Path(filename).suffix.lower() if filename else ".xlsx"
        if suffix not in {".xlsx", ".xls"}:
            suffix = ".xlsx"
        path = self._run_dir() / (
            filename if filename else f"{_safe_name(task['statement_no'])}-对账结果{suffix}"
        )
        path.write_bytes(payload)
        return str(path)

    async def mark_uploaded(self, task: dict):
        """
        当前客户只提供了查询与 Excel 下载接口，未提供 T100 勾选回写协议。

        即使配置了 URL，也不猜请求字段；拿到正式接口契约后再实现，避免网站已确认、
        T100 却误标其他单据。
        """
        raise NotImplementedError(
            "缺少“T100 客户系统发票已录”回写接口契约，禁止猜字段执行。"
        )

    async def _request(self, url: str, method: str = "POST"):
        import asyncio

        def do_request():
            req = urllib.request.Request(
                url,
                data=b"" if method == "POST" else None,
                method=method,
                headers={"Accept": "application/json, */*"},
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                return response.read(), response.headers

        return await asyncio.to_thread(do_request)

    @staticmethod
    def _run_dir() -> Path:
        configured = os.environ.get("WAIN_INVOICE_ACTIVE_RUN_DIR")
        if configured:
            path = Path(configured) / "downloads"
            path.mkdir(parents=True, exist_ok=True)
            return path
        return Path(tempfile.mkdtemp(prefix="wain-invoice-"))


def _safe_name(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "_", str(value)).strip("._") or "file"


def _filename_from_headers(headers) -> str | None:
    value = headers.get("Content-Disposition", "")
    encoded = re.search(r"filename\*=UTF-8''([^;]+)", value, re.IGNORECASE)
    if encoded:
        return Path(urllib.parse.unquote(encoded.group(1))).name
    plain = re.search(r'filename="?([^";]+)"?', value, re.IGNORECASE)
    if not plain:
        return None
    raw = plain.group(1)
    try:
        raw = raw.encode("latin1").decode("gbk")
    except Exception:
        pass
    return Path(raw).name


def _suffix_from_headers(headers, default: str) -> str:
    filename = _filename_from_headers(headers)
    if filename and Path(filename).suffix:
        return Path(filename).suffix.lower()
    content_type = headers.get_content_type()
    if content_type == "application/pdf":
        return ".pdf"
    return default


def create(cfg: dict):
    return T100Http(cfg)
