"""
T100 ERP 适配器。

接口契约（所有 mode 实现必须满足）：
  - async fetch_pending_invoices() -> list[dict]
      返回待开票任务列表，每条 dict 至少含：
        customer:        客户代号
        statement_no:    对账单号（部分客户从发票备注栏提）
        invoice_no:      发票号
        amount_excl_tax: 不含税金额
        tax:             税额
        amount_incl_tax: 含税金额
        invoice_url:     电子发票 URL（PDF/OFD/ZIP）
        invoice_type:    发票类型（从 axmm200.客户系统发票上传格式 取）
        billing_dt:      开票日期时间（字段名/格式待 T100 确认 → 见李总清单 #1）
        delay_days:      延迟启动天数（客户系统发票指定录入时间）

  - async download_invoice_files(task) -> list[str]
      下载 task["invoice_url"] 指向的发票文件到本地，返回本地路径列表。

  - async get_match_excel(task) -> str
      取 cist310 里名称含「对账结果」的 Excel，返回本地路径。

  - supports_mark_uploaded -> bool
      是否具备“客户系统发票已录”回写能力。

  - async mark_uploaded(task)
      客户系统最终确认成功后，在 T100 将当前对账单标记为已录。
      没有正式接口契约时必须失败，禁止猜字段。
"""

from .mock import create as _mock_create
from .real import create as _real_create

__all__ = ["_mock_create", "_real_create"]
