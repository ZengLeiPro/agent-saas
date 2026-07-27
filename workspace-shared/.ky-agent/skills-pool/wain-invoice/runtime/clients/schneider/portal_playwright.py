"""在 ACS Linux 容器中用 HTTP 登录 + Playwright Chromium 操作施耐德旧门户。"""

from __future__ import annotations

import json
import os
import re
import stat
import time
import urllib.parse
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

import requests

from clients.schneider.business import MatchData, money, normalize_key, parse_consignment_range
from core.safety import RedlineViolation


IE11_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko"
)
CHALLENGE_MAX_AGE_SECONDS = 10 * 60


@dataclass(frozen=True)
class WebsiteResult:
    reached_confirmation: bool
    committed: bool
    downloaded_report: str | None = None


def create_login_challenge(cfg: dict, task: dict, output_root: Path) -> dict:
    """获取验证码并持久化同一 HTTP 会话，供下一轮 Agent 继续登录。"""
    reference = task["statement_no"]
    challenge_dir = output_root / "登录接力" / _safe_name(reference)
    challenge_dir.mkdir(parents=True, exist_ok=True)
    login_url = task.get("portal_url") or cfg["url"]

    session = requests.Session()
    headers = {"User-Agent": IE11_USER_AGENT}
    response = session.get(login_url, headers=headers, timeout=30)
    response.raise_for_status()
    html = _decode_portal_html(response)
    form_action = _find_attribute(
        html,
        r"<form\b[^>]*\bname=[\"']userInfoForm[\"'][^>]*>",
        "action",
        "登录表单 action",
    )
    captcha_tag = re.search(
        r"<img\b[^>]*\bid=[\"']imgObj[\"'][^>]*>",
        html,
        re.IGNORECASE,
    )
    if not captcha_tag:
        raise RuntimeError("施耐德登录页未找到验证码图片 imgObj。")
    captcha_src = _attribute(captcha_tag.group(0), "src")
    if not captcha_src:
        raise RuntimeError("施耐德登录页验证码缺少 src。")

    captcha_url = urllib.parse.urljoin(response.url, captcha_src)
    captcha_response = session.get(
        captcha_url,
        headers={**headers, "Referer": response.url},
        timeout=30,
    )
    captcha_response.raise_for_status()
    if not captcha_response.content:
        raise RuntimeError("施耐德验证码响应为空。")

    captcha_path = challenge_dir / "登录验证码.png"
    challenge_path = challenge_dir / "challenge.json"
    captcha_path.write_bytes(captcha_response.content)
    state = {
        "version": 1,
        "taskReference": reference,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "loginUrl": response.url,
        "formAction": urllib.parse.urljoin(response.url, form_action),
        "userAgent": IE11_USER_AGENT,
        "cookies": [_serialize_cookie(cookie) for cookie in session.cookies],
    }
    challenge_path.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.chmod(challenge_path, stat.S_IRUSR | stat.S_IWUSR)
    return {
        "status": "captcha_required",
        "taskReference": reference,
        "captchaPath": str(captcha_path),
        "challengeFile": str(challenge_path),
        "expiresInSeconds": CHALLENGE_MAX_AGE_SECONDS,
        "message": "请人工查看验证码图片；不要使用 OCR 或第三方打码。",
    }


def run_portal_workflow(
    cfg: dict,
    task: dict,
    match: MatchData,
    audit,
    commit_reference: str | None,
    interactive: bool,
    website_commit_allowed: bool,
    captcha_value: str | None,
    challenge_file: str | None,
) -> WebsiteResult:
    """真实网页流程完全运行在 ACS 的 Linux Chromium 中。"""
    if not captcha_value or not challenge_file:
        raise RuntimeError(
            "缺少人工验证码接力。请先执行 captcha 生成验证码，再把验证码和 "
            "challengeFile 传给 run/commit。"
        )
    cookies = _login_with_challenge(
        task,
        captcha_value,
        Path(challenge_file),
        audit,
    )

    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            locale="zh-CN",
            user_agent=IE11_USER_AGENT,
            accept_downloads=True,
        )
        context.add_cookies(cookies)
        page = context.new_page()
        try:
            result = _process_invoice(
                page,
                cfg,
                task,
                match,
                audit,
                commit_reference,
                interactive,
                website_commit_allowed,
            )
            return result
        finally:
            context.close()
            browser.close()


def _login_with_challenge(
    task: dict,
    captcha_value: str,
    challenge_path: Path,
    audit,
) -> list[dict]:
    if not re.fullmatch(r"[0-9A-Za-z]{4,6}", captcha_value):
        raise RuntimeError("验证码格式异常，禁止提交登录。")
    if not challenge_path.exists():
        raise RuntimeError(f"验证码会话文件不存在：{challenge_path}")
    state = json.loads(challenge_path.read_text(encoding="utf-8"))
    if state.get("taskReference") != task["statement_no"]:
        raise RuntimeError("验证码会话与当前对账单号不一致。")
    created = datetime.fromisoformat(state["createdAt"])
    age = (datetime.now(timezone.utc) - created).total_seconds()
    if age > CHALLENGE_MAX_AGE_SECONDS:
        raise RuntimeError("验证码会话已超过 10 分钟，请重新执行 captcha。")

    session = requests.Session()
    for item in state.get("cookies") or []:
        session.cookies.set(
            item["name"],
            item["value"],
            domain=item.get("domain") or None,
            path=item.get("path") or "/",
            secure=bool(item.get("secure")),
        )
    headers = {
        "User-Agent": state.get("userAgent") or IE11_USER_AGENT,
        "Referer": state["loginUrl"],
    }
    response = session.post(
        state["formAction"],
        headers=headers,
        data={
            "method": "loginProcess",
            "loginName": task["portal_username"],
            "password": task["portal_password"],
            "veryCode": captcha_value,
        },
        timeout=30,
        allow_redirects=True,
    )
    response.raise_for_status()
    html = _decode_portal_html(response)
    if (
        "weblogin.jsp" in response.url
        or re.search(r"\bname=[\"']loginName[\"']", html, re.IGNORECASE)
    ):
        raise RuntimeError("施耐德登录未成功，可能是验证码或账号密码错误。")
    audit.info(f"[登录] HTTP 会话登录成功，URL={response.url}")
    return [_playwright_cookie(cookie, response.url) for cookie in session.cookies]


def _process_invoice(
    page,
    cfg: dict,
    task: dict,
    match: MatchData,
    audit,
    commit_reference: str | None,
    interactive: bool,
    website_commit_allowed: bool,
) -> WebsiteResult:
    base = _portal_base(task.get("portal_url") or cfg["url"])
    page.goto(
        f"{base}/webPortalSystem/apInvoice/index.jsp",
        wait_until="domcontentloaded",
        timeout=30_000,
    )
    _wait_text(page, "生成发票信息")

    _select_company_and_kind(page, match.company_code, match.invoice_kind)
    _capture(page, audit, "02-公司与业务类型")
    _click_if_present(page, "下一步")

    if match.invoice_kind == "non_consignment":
        _process_non_consignment_rows(page, match, audit)
    else:
        _process_consignment_summary(page, cfg, task, match, audit)

    total = _extract_labeled_amount(page, "货款总额")
    expected_excl_tax = money(task["amount_excl_tax"])
    if total != expected_excl_tax:
        mismatch = _mismatch_screenshot_path(cfg, audit, task)
        page.screenshot(path=str(mismatch), full_page=True)
        raise RuntimeError(
            f"施耐德货款总额 {total} != T100 原币税前 {expected_excl_tax}；"
            f"截图已保存：{mismatch}"
        )
    audit.info(f"[金额核对] 货款总额={total}，与 T100 原币税前一致")
    _capture(page, audit, "05-金额核对一致")

    _fill_invoice_fields(page, task)
    _capture(page, audit, "06-发票字段已填")
    _click_text(page, "检查")
    _wait_until(
        lambda: _check_result_is_zero(page),
        timeout=15,
        message="点击检查后结果未变为 0。",
    )
    audit.info("[检查] 结果为 0")
    _capture(page, audit, "07-检查结果为零")

    _click_text(page, "生成")
    page.wait_for_url(re.compile(r".*generateSubmit\.jsp.*"), timeout=20_000)
    _verify_confirmation_page(page, task)
    _capture(page, audit, "08-最终确认页-未提交")
    audit.info("[生成] 已到最终确认页，四个发票字段复核一致")

    commit_reference = _prompt_commit_reference(task, commit_reference, interactive)
    if not commit_reference:
        audit.info("[COMMIT_GATE] 未提供 commit_reference，止步于最终确认页")
        return WebsiteResult(reached_confirmation=True, committed=False)
    if not website_commit_allowed:
        raise RedlineViolation(
            "[COMMIT_GATE] 当前既无 T100 回写能力，也无客户 POC 阶段网页提交授权。"
        )
    reference = task["statement_no"]
    if commit_reference not in {reference, task.get("billing_no")}:
        raise RedlineViolation(
            f"[COMMIT_GATE] 批准单据 {commit_reference!r} 与当前任务不一致。"
        )

    audit.info(f"[COMMIT_GATE] 批准最终确认：{commit_reference}")
    _confirm_and_require_success(page)
    audit.info("[最终确认] 施耐德页面已执行确认")
    _capture(page, audit, "09-最终确认后")

    report = None
    if match.invoice_kind == "non_consignment":
        report = _download_non_consignment_report(page, cfg, task, audit)
    return WebsiteResult(
        reached_confirmation=True,
        committed=True,
        downloaded_report=report,
    )


def _prompt_commit_reference(
    task: dict,
    commit_reference: str | None,
    interactive: bool,
) -> str | None:
    if commit_reference or not interactive:
        return commit_reference
    reference = task["statement_no"]
    print("\n已到施耐德最终确认页，四个发票字段已复核一致。")
    print("客户已授权本阶段可提交，但本次不会回写 T100。")
    print(f"如确认提交，请完整输入当前对账单号：{reference}")
    entered = input("对账单号（直接回车则停止，不提交）：").strip()
    return entered or None


def _select_company_and_kind(page, company_code: str, kind: str):
    selects = page.locator("select")
    company_found = False
    for index in range(selects.count()):
        select = selects.nth(index)
        options = [text.strip() for text in select.locator("option").all_inner_texts()]
        target = next((text for text in options if company_code in text), None)
        if target:
            select.select_option(label=target)
            company_found = True
            break
    if not company_found:
        raise RuntimeError(f"公司下拉框没有包含 {company_code!r} 的选项。")

    expected = "非寄售" if kind == "non_consignment" else "寄售"
    for index in range(selects.count()):
        select = selects.nth(index)
        options = [text.strip() for text in select.locator("option").all_inner_texts()]
        if expected in options:
            select.select_option(label=expected)
            return
    raise RuntimeError(f"业务类型下拉框没有 {expected!r}。")


def _process_non_consignment_rows(page, match: MatchData, audit):
    start, end = _search_date_inputs(page, "收货日期")
    start.fill(f"{match.receipt_start:%Y.%m.%d}")
    end.fill(f"{match.receipt_end:%Y.%m.%d}")
    _click_text(page, "搜索")
    _set_page_size_100(page)

    remaining = set(match.row_keys)
    matched_on_web = set()
    seen_pages = 0
    while remaining:
        seen_pages += 1
        if seen_pages > 100:
            raise RuntimeError("网页分页超过 100 页，疑似分页识别失效。")
        table, header_map = _find_order_table(page)
        selected = 0
        rows = table.locator("tr")
        for row_index in range(rows.count()):
            cells = rows.nth(row_index).locator("td")
            if not cells.count():
                continue
            order_no = normalize_key(cells.nth(header_map["订单号"]).inner_text())
            line_no = normalize_key(cells.nth(header_map["行号"]).inner_text())
            key = (order_no, line_no)
            if key in matched_on_web:
                raise RuntimeError(f"网页出现重复的订单号+行号：{key}")
            if key not in remaining:
                continue
            boxes = rows.nth(row_index).locator("input[type='checkbox']")
            if not boxes.count():
                raise RuntimeError(f"网页订单行 {key} 没有选择框。")
            box = boxes.last
            if not box.is_checked():
                box.check()
            remaining.remove(key)
            matched_on_web.add(key)
            selected += 1
        if selected:
            _click_text(page, "放入发票篮")
            audit.info(f"[明细匹配] 当前页放入 {selected} 行，剩余 {len(remaining)} 行")
        if not remaining:
            break
        if not _go_next_page(page):
            break

    if remaining:
        sample = sorted(remaining)[:10]
        raise RuntimeError(
            f"网页缺少 Excel 指定的 {len(remaining)} 个订单行，示例：{sample}"
        )
    _click_text(page, "发票篮")
    _capture(page, audit, "03-非寄售明细已入发票篮")


def _process_consignment_summary(
    page, cfg: dict, task: dict, match: MatchData, audit
):
    start_date, end_date = parse_consignment_range(task["invoice_remark"])
    start, end = _search_date_inputs(page, "凭证日期")
    start.fill(f"{start_date:%Y.%m.%d}")
    end.fill(f"{end_date:%Y.%m.%d}")
    _click_text(page, "搜索")

    table = _find_table_with_headers(page, {"汇总金额"})
    rows = table.locator("tr").filter(has=page.locator("td"))
    if rows.count() != 1:
        raise RuntimeError(f"寄售日期区间应返回 1 行，实际 {rows.count()} 行。")
    headers = _header_map(table)
    amount = money(rows.first.locator("td").nth(headers["汇总金额"]).inner_text())
    expected = money(task["amount_excl_tax"])
    if amount != expected:
        mismatch = _mismatch_screenshot_path(cfg, audit, task)
        page.screenshot(path=str(mismatch), full_page=True)
        raise RuntimeError(
            f"寄售汇总金额 {amount} != T100 原币税前 {expected}；"
            f"截图已保存：{mismatch}"
        )
    audit.info(f"[寄售汇总] {start_date}~{end_date} 金额={amount}，核对一致")
    _capture(page, audit, "03-寄售汇总核对一致")
    _click_text(page, "发票篮")


def _fill_invoice_fields(page, task: dict):
    values = {
        "发票号码": task["invoice_no"],
        "开票日期": f"{_invoice_date(task):%Y.%m.%d}",
        "发票总额（含税）": task["amount_incl_tax"],
        "增值税额": task["tax"],
    }
    for label, value in values.items():
        _input_after_label(page, label).fill(str(value))


def _verify_confirmation_page(page, task: dict):
    body = re.sub(r"\s+", " ", _body_text(page).replace(",", ""))
    missing = []
    invoice_pattern = (
        rf"发票号码\s*[:：]?\s*{re.escape(str(task['invoice_no']))}(?:\s|$)"
    )
    if not re.search(invoice_pattern, body):
        missing.append(f"发票号码={task['invoice_no']}")

    date_value = f"{_invoice_date(task):%Y.%m.%d}"
    date_pattern = (
        r"(?:开票日期|发票日期)\s*[:：]?\s*"
        + re.escape(date_value).replace(r"\.", r"[./-]")
        + r"(?:\s|$)"
    )
    if not re.search(date_pattern, body):
        missing.append(f"开票日期/发票日期={date_value}")

    for labels, expected in (
        (("发票总额（含税）", "发票总额(含税)"), money(task["amount_incl_tax"])),
        (("增值税额",), money(task["tax"])),
    ):
        value = _extract_amount_after_any_label(body, labels)
        if value != expected:
            missing.append(f"{'/'.join(labels)}={expected}（页面={value}）")
    if missing:
        raise RuntimeError(f"最终确认页字段未按标签复核通过：{missing}")


def _extract_amount_after_any_label(body: str, labels: tuple[str, ...]):
    for label in labels:
        found = re.search(
            rf"{re.escape(label)}\s*[:：]?\s*(-?[\d,]+(?:\.\d+)?)",
            body,
        )
        if found:
            return money(found.group(1))
    return None


def _extract_labeled_amount(page, label: str):
    body = _body_text(page).replace("\n", " ")
    match = re.search(rf"{re.escape(label)}\s*([\d,]+(?:\.\d+)?)", body)
    if not match:
        raise RuntimeError(f"页面未找到 {label} 金额。")
    return money(match.group(1))


def _check_result_is_zero(page) -> bool:
    body = _body_text(page).replace("\n", " ")
    return bool(
        re.search(r"(?:检查结果|检查|结果)\s*[:：]?\s*0(?:\.0+)?(?:\s|$)", body)
    )


def _search_date_inputs(page, label: str):
    selectors = [
        (
            f"xpath=//*[normalize-space()='{label}']/following::input"
            "[not(@type='hidden')][position() <= 2]"
        ),
        (
            "xpath=//*[self::td or self::th or self::label]"
            f"[contains(normalize-space(.),'{label}')]/following::input"
            "[not(@type='hidden')][position() <= 2]"
        ),
    ]
    for selector in selectors:
        fields = page.locator(selector)
        visible = [
            fields.nth(index)
            for index in range(fields.count())
            if fields.nth(index).is_visible() and fields.nth(index).is_enabled()
        ]
        if len(visible) >= 2:
            return visible[0], visible[1]
    raise RuntimeError(f"未找到 {label} 的起止日期输入框。")


def _find_order_table(page):
    table = _find_table_with_headers(page, {"订单号", "行号"})
    return table, _header_map(table)


def _find_table_with_headers(page, required: set[str]):
    tables = page.locator("table")
    for index in range(tables.count()):
        table = tables.nth(index)
        headers = set(_header_map(table))
        if required <= headers:
            return table
    raise RuntimeError(f"页面未找到含表头 {sorted(required)} 的表格。")


def _header_map(table) -> dict[str, int]:
    headers = table.locator("th")
    if not headers.count():
        rows = table.locator("tr")
        headers = rows.first.locator("td") if rows.count() else table.locator(".__none__")
    return {
        headers.nth(index).inner_text().strip(): index
        for index in range(headers.count())
    }


def _go_next_page(page) -> bool:
    candidates = page.locator(
        "xpath=//*[normalize-space()='[下一页]' or normalize-space()='下一页']"
    )
    for index in range(candidates.count()):
        candidate = candidates.nth(index)
        if not candidate.is_visible() or not candidate.is_enabled():
            continue
        classes = candidate.get_attribute("class") or ""
        if "disabled" in classes.lower():
            continue
        candidate.click()
        page.wait_for_load_state("domcontentloaded")
        return True
    return False


def _set_page_size_100(page):
    selects = page.locator("select")
    for index in range(selects.count()):
        select = selects.nth(index)
        if not select.is_visible() or not select.is_enabled():
            continue
        options = {text.strip() for text in select.locator("option").all_inner_texts()}
        if "100" in options and len(options & {"10", "15", "20", "30", "50", "100"}) >= 2:
            select.select_option(label="100")
            return
    raise RuntimeError("未找到每页数量下拉框中的 100 选项。")


def _input_after_label(page, label: str):
    fields = page.locator(
        f"xpath=//*[normalize-space()='{label}']/following::input[1]"
    )
    for index in range(fields.count()):
        field = fields.nth(index)
        if field.is_visible() and field.is_enabled():
            return field
    raise RuntimeError(f"未找到字段 {label!r} 的输入框。")


def _click_text(page, text: str):
    candidates = page.locator(
        "xpath=//*[self::button or self::a or self::input or @onclick]"
        f"[normalize-space()='{text}' or @value='{text}']"
    )
    for index in range(candidates.count()):
        candidate = candidates.nth(index)
        if candidate.is_visible() and candidate.is_enabled():
            candidate.click()
            return
    raise RuntimeError(f"页面未找到可点击的 {text!r}。")


def _click_if_present(page, text: str) -> bool:
    try:
        _click_text(page, text)
        return True
    except RuntimeError:
        return False


def _has_visible_click_target(page, text: str) -> bool:
    candidates = page.locator(
        "xpath=//*[self::button or self::a or self::input or @onclick]"
        f"[normalize-space()='{text}' or @value='{text}']"
    )
    return any(
        candidates.nth(index).is_visible() and candidates.nth(index).is_enabled()
        for index in range(candidates.count())
    )


def _confirm_and_require_success(page):
    dialog_messages: list[str] = []

    def handle_dialog(dialog):
        dialog_messages.append(dialog.message or "")
        dialog.accept()

    page.on("dialog", handle_dialog)
    pages_before = set(page.context.pages)
    url_before = page.url
    _click_text(page, "确认")

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        for message in dialog_messages:
            if any(word in message for word in ("失败", "错误", "异常")):
                raise RuntimeError(f"最终确认弹窗返回失败：{message}")
            if any(word in message for word in ("成功", "完成")):
                return

        new_pages = [item for item in page.context.pages if item not in pages_before]
        if new_pages:
            popup = new_pages[0]
            popup.wait_for_load_state("domcontentloaded")
            body = _body_text(popup)
            if any(word in body for word in ("失败", "错误", "异常")):
                raise RuntimeError(f"最终确认结果窗口返回失败：{body[:200]}")
            if any(word in body for word in ("成功", "完成")):
                popup.close()
                return
            popup.close()
            raise RuntimeError(f"最终确认结果窗口没有成功标志：{body[:200]}")

        if page.url != url_before and "generateSubmit.jsp" not in page.url:
            return
        body = _body_text(page)
        if any(text in body for text in ("成功", "处理完成", "已生成")):
            return
        if not _has_visible_click_target(page, "确认"):
            return
        page.wait_for_timeout(300)
    raise RuntimeError("点击最终确认后 20 秒内没有观察到明确成功结果。")


def _download_non_consignment_report(page, cfg: dict, task: dict, audit) -> str:
    base = _portal_base(task.get("portal_url") or cfg["url"])
    page.goto(
        f"{base}/webPortalSystem/apInvoice/index.jsp",
        wait_until="domcontentloaded",
        timeout=30_000,
    )
    start, end = _search_date_inputs(page, "收货日期")
    invoice_date = _invoice_date(task)
    start.fill(f"{invoice_date:%Y.%m.%d}")
    end.fill(f"{invoice_date:%Y.%m.%d}")
    _click_text(page, "搜索")

    link = page.get_by_text("下载该报告", exact=True).first
    target_dir = Path(audit.dir) / "downloads"
    target_dir.mkdir(parents=True, exist_ok=True)
    href = link.get_attribute("href")
    if href and not href.lower().startswith("javascript:"):
        url = urllib.parse.urljoin(page.url, href)
        response = page.context.request.get(url, timeout=30_000)
        if not response.ok:
            raise RuntimeError(f"下载施耐德报告失败：HTTP {response.status}")
        payload = response.body()
        target = target_dir / f"施耐德下载报告{_excel_suffix(payload)}"
        target.write_bytes(payload)
        return str(target)

    with page.expect_download(timeout=30_000) as download_info:
        link.click()
    download = download_info.value
    suffix = Path(download.suggested_filename).suffix.lower() or ".xlsx"
    target = target_dir / f"施耐德下载报告{suffix}"
    download.save_as(str(target))
    _excel_suffix(target.read_bytes())
    return str(target)


def _capture(page, audit, name: str):
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name).strip(" .")
    screenshot = Path(audit.screenshot_dir) / f"{safe_name}.png"
    dom = Path(audit.dom_dir) / f"{safe_name}.html"
    page.screenshot(path=str(screenshot), full_page=True)
    dom.write_text(page.content(), encoding="utf-8")


def _wait_text(page, text: str, timeout: int = 20):
    page.get_by_text(text, exact=False).first.wait_for(
        state="visible",
        timeout=timeout * 1000,
    )


def _wait_until(check, timeout: int, message: str):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except Exception as exc:
            last_error = exc
        time.sleep(0.3)
    suffix = f"；最后错误：{last_error}" if last_error else ""
    raise RuntimeError(message + suffix)


def _body_text(page) -> str:
    if hasattr(page, "locator"):
        return page.locator("body").inner_text()
    body = page.find_element("tag name", "body")
    return body.text


def _portal_base(url: str) -> str:
    match = re.match(r"(https?://[^/]+)", url)
    if not match:
        raise ValueError(f"无效 portal URL：{url!r}")
    return match.group(1)


def _excel_suffix(payload: bytes) -> str:
    if payload.startswith(b"PK\x03\x04"):
        return ".xlsx"
    if payload.startswith(b"\xd0\xcf\x11\xe0"):
        return ".xls"
    raise RuntimeError("下载报告不是有效的 .xlsx/.xls 文件。")


def _invoice_date(task: dict) -> date:
    return date.fromisoformat(task["invoice_date"])


def _mismatch_screenshot_path(cfg: dict, audit, task: dict) -> Path:
    safe_customer = re.sub(
        r'[<>:"/\\|?*\x00-\x1f]+',
        "_",
        f"{task['customer']}+{task['customer_code']}",
    ).strip(" .")
    configured = os.environ.get("WAIN_EMAIL_DOWNLOAD_DIR") or cfg.get(
        "email_download_dir"
    )
    target_dir = Path(configured) if configured else Path(audit.dir) / "邮件下载"
    target_dir.mkdir(parents=True, exist_ok=True)
    return target_dir / (
        f"客户系统金额与发票金额不一致，请人工核对={safe_customer}.png"
    )


def _decode_portal_html(response: requests.Response) -> str:
    response.encoding = "gbk"
    return response.text


def _find_attribute(html: str, tag_pattern: str, name: str, label: str) -> str:
    tag = re.search(tag_pattern, html, re.IGNORECASE)
    if not tag:
        raise RuntimeError(f"施耐德登录页未找到{label}。")
    value = _attribute(tag.group(0), name)
    if not value:
        raise RuntimeError(f"施耐德登录页{label}缺少 {name}。")
    return value


def _attribute(tag: str, name: str) -> str | None:
    match = re.search(
        rf"\b{re.escape(name)}\s*=\s*[\"']([^\"']+)[\"']",
        tag,
        re.IGNORECASE,
    )
    return match.group(1) if match else None


def _serialize_cookie(cookie) -> dict:
    return {
        "name": cookie.name,
        "value": cookie.value,
        "domain": cookie.domain,
        "path": cookie.path or "/",
        "secure": bool(cookie.secure),
    }


def _playwright_cookie(cookie, response_url: str) -> dict:
    host = urllib.parse.urlparse(response_url).hostname or ""
    return {
        "name": cookie.name,
        "value": cookie.value,
        "domain": cookie.domain.lstrip(".") if cookie.domain else host,
        "path": cookie.path or "/",
        "secure": bool(cookie.secure),
        "httpOnly": bool(cookie.has_nonstandard_attr("HttpOnly")),
    }


def _safe_name(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "_", value).strip("._") or "task"
