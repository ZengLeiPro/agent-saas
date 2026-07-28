from __future__ import annotations

from adapters.t100.real import normalize_order
from core.audit import redact_sensitive


def test_t100_order_normalization_uses_beijing_invoice_date():
    task = normalize_order(
        {
            "客户简称": "测试客户",
            "客户编号": "C001",
            "对账单号": "S001",
            "开票单号": "B001",
            "发票号码": "I001",
            "发票备注": "非寄售测试",
            "原币税前": 100,
            "原币税额": 13,
            "原币含税": 113,
            "发票日期": "2026-07-25T16:30:00.000Z",
            "客户系统密码": "secret",
        }
    )

    assert task["invoice_date"] == "2026-07-26"
    assert task["statement_no"] == "S001"
    assert task["amount_incl_tax"] == "113"


def test_recursive_redaction_covers_portal_password():
    value = {"task": {"portal_password": "secret", "invoice_no": "I001"}}
    assert redact_sensitive(value) == {
        "task": {"portal_password": "<redacted>", "invoice_no": "I001"}
    }
