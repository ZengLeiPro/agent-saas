"""施耐德 Vendor Web Portal 完整发票录入流程。"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from clients.schneider.business import load_match_data
from clients.schneider.portal_playwright import (
    WebsiteResult,
    _verify_confirmation_page,
    create_login_challenge,
    run_portal_workflow,
)
from core.audit import redact_sensitive


def _evidence_dir(audit) -> str | None:
    value = getattr(audit, "dir", None)
    return str(value) if value is not None else None


async def run_workflow(
    cfg: dict,
    t100,
    audit,
    task_reference: str | None = None,
    commit_reference: str | None = None,
    preflight_only: bool = False,
    prepare_only: bool = False,
    interactive: bool = False,
    captcha_value: str | None = None,
    challenge_file: str | None = None,
    **_,
):
    tasks = await t100.fetch_pending_invoices()
    pending = [task for task in tasks if str(task.get("uploaded") or "").upper() != "Y"]
    if not pending:
        message = (
            "查询接口当前没有待联调数据。客户已说明这代表业务部门可能已处理，"
            "请在群里联系客户重新创建一条数据。"
        )
        audit.warn(f"[1.1] {message}")
        return {
            "outcome": "no_pending_data",
            "message": message,
            "taskReference": task_reference or commit_reference,
            "preflightPassed": False,
            "excelDownloaded": False,
            "websiteReached": False,
            "websiteCommitted": False,
            "t100WrittenBack": False,
            "evidenceDir": _evidence_dir(audit),
        }

    selection_reference = task_reference or commit_reference
    if not selection_reference and len(pending) > 1 and interactive:
        selection_reference = _prompt_task_reference(pending)
    task = _select_task(pending, selection_reference)
    _validate_task(task)
    audit.info_data("[1.1] 当前任务", _public_task(task))

    if prepare_only and commit_reference:
        raise RuntimeError("prepare 模式禁止携带 commit_reference。")
    if commit_reference:
        raise RuntimeError(
            "当前执行环境不具备 Microsoft Edge IE 模式，生产提交已禁用；"
            "请使用 prepare 自动制单到最终确认页。"
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
        return {
            "outcome": "preflight_passed",
            "message": "T100 数据、对账 Excel 和业务规则核对通过；未启动施耐德网站。",
            "taskReference": task.get("statement_no") or task.get("billing_no"),
            "preflightPassed": True,
            "excelDownloaded": True,
            "excelPath": str(excel_path),
            "websiteReached": False,
            "websiteCommitted": False,
            "t100WrittenBack": False,
            "evidenceDir": _evidence_dir(audit),
        }

    result = await asyncio.to_thread(
        run_portal_workflow,
        cfg,
        task,
        match,
        audit,
        None,
        False,
        False,
        captcha_value,
        challenge_file,
    )

    t100_written_back = False
    if result.committed:
        raise RuntimeError(
            "安全边界被突破：提交前制单模式不得确认施耐德页面，也不得回写 T100。"
        )

    return {
        "outcome": "confirmation_reached",
        "message": "已到达施耐德最终确认页，按要求未点击最终确认。",
        "taskReference": task.get("statement_no") or task.get("billing_no"),
        "preflightPassed": True,
        "excelDownloaded": True,
        "excelPath": str(excel_path),
        "websiteReached": result.reached_confirmation,
        "websiteCommitted": result.committed,
        "t100WrittenBack": t100_written_back,
        "evidenceDir": _evidence_dir(audit),
    }


async def prepare_captcha(
    cfg: dict,
    t100,
    task_reference: str,
    output_root: Path,
) -> dict:
    """为跨 Agent 轮次的验证码识别接力建立同一份 JSESSIONID。"""
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
