"""施耐德 Vendor Web Portal 完整发票录入流程。"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import date
from pathlib import Path

from clients.schneider.business import load_match_data, merge_result_report
from clients.schneider.portal_playwright import (
    WebsiteResult,
    _excel_suffix,
    _prompt_commit_reference,
    _verify_confirmation_page,
    create_login_challenge,
    run_portal_workflow,
)
from core.audit import redact_sensitive


async def run_workflow(
    cfg: dict,
    t100,
    audit,
    task_reference: str | None = None,
    commit_reference: str | None = None,
    preflight_only: bool = False,
    interactive: bool = False,
    captcha_value: str | None = None,
    challenge_file: str | None = None,
    **_,
):
    tasks = await t100.fetch_pending_invoices()
    pending = [task for task in tasks if str(task.get("uploaded") or "").upper() != "Y"]
    if not pending:
        audit.warn(
            "[1.1] 查询接口当前没有待联调数据。客户已说明这代表业务部门可能已处理，"
            "请在群里联系客户重新创建一条数据。"
        )
        return

    selection_reference = task_reference or commit_reference
    if not selection_reference and len(pending) > 1 and interactive:
        selection_reference = _prompt_task_reference(pending)
    task = _select_task(pending, selection_reference)
    _validate_task(task)
    audit.info_data("[1.1] 当前任务", _public_task(task))

    has_t100_writeback = getattr(t100, "supports_mark_uploaded", False)
    allow_poc_without_writeback = bool(
        cfg.get("poc_allow_website_commit_without_t100_writeback")
    )
    if commit_reference and not has_t100_writeback and not allow_poc_without_writeback:
        raise RuntimeError(
            "已请求生产确认，但 T100 尚未提供“客户系统发票已录”回写接口。"
            "为避免施耐德已入账、T100 未勾选造成双边状态不一致，本次禁止进入确认。"
        )
    if commit_reference and not has_t100_writeback:
        audit.warn(
            "[POC阶段授权] 客户已允许施耐德网页最终确认；本轮确认成功后不会回写 T100。"
        )

    excel_path = await t100.get_match_excel(task)
    match = load_match_data(
        excel_path,
        task["invoice_remark"],
        task.get("reconciliation_name", ""),
    )
    audit.info(
        f"[1.2] Excel 匹配完成：company={match.company_code} "
        f"kind={match.invoice_kind} rows={len(match.rows)} "
        f"receipt={match.receipt_start}~{match.receipt_end}"
    )
    if preflight_only:
        audit.info("[PREFLIGHT] 业务预检通过，按要求未启动施耐德客户网站")
        return

    result = await asyncio.to_thread(
        run_portal_workflow,
        cfg,
        task,
        match,
        audit,
        commit_reference,
        interactive,
        has_t100_writeback or allow_poc_without_writeback,
        captcha_value,
        challenge_file,
    )

    if result.committed:
        if has_t100_writeback:
            await t100.mark_uploaded(task)
            audit.info(f"[T100] 已回写客户系统发票已录：{task['statement_no']}")
        elif allow_poc_without_writeback:
            audit.warn(
                f"[T100] 按客户 POC 阶段安排，施耐德已确认但暂不回写 T100："
                f"{task['statement_no']}"
            )
        else:
            raise RuntimeError("施耐德已确认，但当前既无 T100 回写能力也无 POC 阶段授权。")
        if match.invoice_kind == "non_consignment":
            if not result.downloaded_report:
                raise RuntimeError("施耐德已确认，但未取得非寄售录入结果报表。")
            target_dir = _email_download_dir(cfg, audit)
            target, appended = merge_result_report(
                result.downloaded_report,
                target_dir,
                _invoice_date(task),
            )
            audit.info(f"[结果报表] 已合并 {appended} 行 → {target}")


async def prepare_captcha(
    cfg: dict,
    t100,
    task_reference: str,
    output_root: Path,
) -> dict:
    """为跨 Agent 轮次的人工验证码接力建立同一份 JSESSIONID。"""
    tasks = await t100.fetch_pending_invoices()
    pending = [task for task in tasks if str(task.get("uploaded") or "").upper() != "Y"]
    task = _select_task(pending, task_reference)
    _validate_task(task)
    return await asyncio.to_thread(create_login_challenge, cfg, task, output_root)


def _select_task(tasks: list[dict], reference: str | None) -> dict:
    if not reference:
        if len(tasks) != 1:
            available = [
                task.get("statement_no") or task.get("billing_no") for task in tasks
            ]
            raise RuntimeError(
                f"当前有 {len(tasks)} 条待办，必须用 --task-reference 精确指定："
                f"{available}"
            )
        return tasks[0]
    matches = [
        task
        for task in tasks
        if reference in {task.get("statement_no"), task.get("billing_no")}
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"reference={reference!r} 匹配到 {len(matches)} 条任务，"
            "必须精确且唯一。"
        )
    return matches[0]


def _prompt_task_reference(tasks: list[dict]) -> str:
    if not os.isatty(0):
        raise RuntimeError("当前有多条待办且不是交互终端，必须用 --task-reference 指定。")
    print("\n查询到多条可联调发票：")
    for index, task in enumerate(tasks, 1):
        reference = task.get("statement_no") or task.get("billing_no")
        print(
            f"  {index}. {reference} | {task.get('customer', '')} | "
            f"发票号 {task.get('invoice_no', '')}"
        )
    choice = input(f"请选择序号（1-{len(tasks)}）：").strip()
    if not choice.isdigit() or not 1 <= int(choice) <= len(tasks):
        raise RuntimeError("选择序号无效，未启动客户网站。")
    task = tasks[int(choice) - 1]
    return task.get("statement_no") or task.get("billing_no")


def _public_task(task: dict) -> dict:
    keys = [
        "customer",
        "customer_code",
        "statement_no",
        "billing_no",
        "invoice_no",
        "invoice_remark",
        "amount_excl_tax",
        "tax",
        "amount_incl_tax",
        "invoice_date",
        "reconciliation_name",
        "portal_username",
        "portal_password",
    ]
    return redact_sensitive({key: task.get(key) for key in keys})


def _validate_task(task: dict):
    required = {
        "customer": "客户简称",
        "customer_code": "客户编号",
        "statement_no": "对账单号/开票单号",
        "invoice_no": "发票号码",
        "invoice_remark": "发票备注",
        "amount_excl_tax": "原币税前",
        "tax": "原币税额",
        "amount_incl_tax": "原币含税",
        "invoice_date": "发票日期",
        "portal_url": "客户系统网址",
        "portal_username": "客户系统账号",
        "portal_password": "客户系统密码",
    }
    missing = [label for key, label in required.items() if task.get(key) in (None, "")]
    if missing:
        raise RuntimeError(f"T100 订单接口缺少必填字段：{', '.join(missing)}")


def _invoice_date(task: dict) -> date:
    return date.fromisoformat(task["invoice_date"])


def _email_download_dir(cfg: dict, audit) -> Path:
    configured = os.environ.get("WAIN_EMAIL_DOWNLOAD_DIR") or cfg.get(
        "email_download_dir"
    )
    path = Path(configured) if configured else Path(audit.dir) / "邮件下载"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_reference(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "_", value).strip("._") or "task"
