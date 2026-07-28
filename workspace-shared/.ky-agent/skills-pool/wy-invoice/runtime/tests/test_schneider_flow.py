from __future__ import annotations

from pathlib import Path

import pytest

from clients.schneider.flow import (
    _excel_suffix,
    _prompt_commit_reference,
    _prompt_task_reference,
    _select_task,
    _validate_task,
    _verify_confirmation_page,
    WebsiteResult,
    run_workflow,
)
from entrypoint import prepare_interactive_launch


TASK = {
    "customer": "测试客户",
    "customer_code": "TEST001",
    "statement_no": "STATEMENT001",
    "billing_no": "BILLING001",
    "invoice_no": "INVOICE001",
    "invoice_remark": "非寄售测试",
    "amount_excl_tax": "100",
    "tax": "13",
    "amount_incl_tax": "113",
    "invoice_date": "2026-07-26",
    "portal_url": "https://example.invalid/login",
    "portal_username": "user",
    "portal_password": "password",
    "uploaded": "N",
}


def test_multiple_tasks_require_reference():
    with pytest.raises(RuntimeError, match="--task-reference"):
        _select_task([TASK, {**TASK, "statement_no": "STATEMENT002"}], None)


def test_task_reference_must_be_unique():
    assert _select_task([TASK], "BILLING001") == TASK
    with pytest.raises(RuntimeError, match="匹配到 0 条"):
        _select_task([TASK], "UNKNOWN")


def test_interactive_task_selection(monkeypatch):
    second = {**TASK, "statement_no": "STATEMENT002", "billing_no": "BILLING002"}
    monkeypatch.setattr("clients.schneider.flow.os.isatty", lambda _: True)
    monkeypatch.setattr("builtins.input", lambda _: "2")

    assert _prompt_task_reference([TASK, second]) == "STATEMENT002"


def test_interactive_commit_requires_typing_current_reference(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda _: "STATEMENT001")
    assert _prompt_commit_reference(TASK, None, True) == "STATEMENT001"
    assert _prompt_commit_reference(TASK, None, False) is None


def test_double_click_prepares_schneider_interactive_args():
    argv = ["wain-invoice-demo.exe"]
    assert prepare_interactive_launch(argv) is True
    assert argv == [
        "wain-invoice-demo.exe",
        "--client",
        "schneider",
        "--mode",
        "real",
        "--interactive",
    ]


def test_required_t100_fields_are_checked():
    with pytest.raises(RuntimeError, match="客户系统密码"):
        _validate_task({**TASK, "portal_password": ""})


@pytest.mark.asyncio
async def test_empty_pending_data_returns_blocked_result_without_excel_or_website():
    class EmptyT100:
        async def fetch_pending_invoices(self):
            return []

        async def get_match_excel(self, _):
            raise AssertionError("空数据时不应下载 Excel")

    class Audit:
        dir = Path("evidence")

        def __init__(self):
            self.messages = []

        def warn(self, message):
            self.messages.append(message)

    audit = Audit()
    result = await run_workflow(
        cfg={},
        t100=EmptyT100(),
        audit=audit,
        task_reference="STATEMENT001",
        preflight_only=True,
    )

    assert result["outcome"] == "no_pending_data"
    assert result["preflightPassed"] is False
    assert result["excelDownloaded"] is False
    assert result["websiteReached"] is False
    assert result["websiteCommitted"] is False
    assert any("没有待联调数据" in message for message in audit.messages)


def test_downloaded_report_format_is_verified_by_magic_bytes():
    assert _excel_suffix(b"PK\x03\x04rest") == ".xlsx"
    assert _excel_suffix(b"\xd0\xcf\x11\xe0rest") == ".xls"
    with pytest.raises(RuntimeError, match="不是有效"):
        _excel_suffix(b"<html>not a workbook</html>")


def test_confirmation_page_verifies_values_with_their_labels():
    class Body:
        text = (
            "发票号码 INVOICE001\n"
            "开票日期 2026.07.26\n"
            "发票总额（含税） 113.00\n"
            "增值税额 13.00"
        )

    class Driver:
        def find_element(self, *_):
            return Body()

    _verify_confirmation_page(Driver(), TASK)


def test_confirmation_page_rejects_unlabeled_number_collision():
    class Body:
        text = (
            "发票号码 INVOICE001\n"
            "开票日期 2026.07.26\n"
            "发票总额（含税） 113.00\n"
            "增值税额 99.00\n"
            "备注 13.00"
        )

    class Driver:
        def find_element(self, *_):
            return Body()

    with pytest.raises(RuntimeError, match="增值税额"):
        _verify_confirmation_page(Driver(), TASK)


@pytest.mark.asyncio
async def test_commit_is_blocked_before_browser_without_t100_writeback():
    class T100WithoutWriteback:
        supports_mark_uploaded = False

        async def fetch_pending_invoices(self):
            return [TASK]

    class Audit:
        def info_data(self, *_):
            pass

        def warn(self, *_):
            pass

    with pytest.raises(RuntimeError, match="T100.*回写接口"):
        await run_workflow(
            cfg={},
            t100=T100WithoutWriteback(),
            audit=Audit(),
            commit_reference="STATEMENT001",
        )


@pytest.mark.asyncio
async def test_customer_authorized_poc_submit_skips_t100_writeback(
    monkeypatch, tmp_path
):
    from openpyxl import Workbook

    task = {
        **TASK,
        "invoice_remark": "寄售P厂2026.07.10-2026.07.11",
        "reconciliation_name": "PP-AVXP-测试.xlsx",
    }
    excel = tmp_path / "PP-AVXP-测试.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["发票备注栏", "收货日期", "订单号", "行号"])
    sheet.append([task["invoice_remark"], "2026-07-10", "PO001", "10"])
    workbook.save(excel)
    workbook.close()

    class T100WithoutWriteback:
        supports_mark_uploaded = False

        async def fetch_pending_invoices(self):
            return [task]

        async def get_match_excel(self, _):
            return str(excel)

        async def mark_uploaded(self, _):
            raise AssertionError("POC 阶段不应回写 T100")

    class Audit:
        def __init__(self):
            self.messages = []

        def info_data(self, *args):
            self.messages.append(str(args))

        def warn(self, message):
            self.messages.append(message)

        def info(self, message):
            self.messages.append(message)

    monkeypatch.setattr(
        "clients.schneider.flow.run_portal_workflow",
        lambda *args: WebsiteResult(reached_confirmation=True, committed=True),
    )
    audit = Audit()
    result = await run_workflow(
        cfg={"poc_allow_website_commit_without_t100_writeback": True},
        t100=T100WithoutWriteback(),
        audit=audit,
        commit_reference="STATEMENT001",
    )

    assert result["outcome"] == "website_committed"
    assert result["preflightPassed"] is True
    assert result["excelDownloaded"] is True
    assert Path(result["excelPath"]).exists()
    assert result["websiteReached"] is True
    assert result["websiteCommitted"] is True
    assert result["t100WrittenBack"] is False
    assert any("暂不回写 T100" in message for message in audit.messages)
