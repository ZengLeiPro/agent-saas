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
    challenge_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    challenge_dir = output_root / "登录接力" / _safe_name(reference) / challenge_id
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
        "message": (
            "验证码图片已保存；由 Agent 直接读取图片自动识别，"
            "连续失败 3 次再请用户人工读取；禁止上传外部 OCR 或第三方打码平台。"
        ),
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
            "缺少验证码接力。请先执行 captcha 生成验证码，再把验证码和 "
            "challengeFile 传给 prepare。"
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
        context_kwargs = {
            "viewport": {"width": 1440, "height": 900},
            "locale": "zh-CN",
            "user_agent": IE11_USER_AGENT,
            "accept_downloads": True,
        }
        if not os.environ.get("WAIN_INVOICE_DISABLE_VIDEO"):
            context_kwargs["record_video_dir"] = str(audit.video_dir)
            context_kwargs["record_video_size"] = {"width": 1440, "height": 900}
        context = browser.new_context(**context_kwargs)
        context.add_cookies(cookies)
        page = context.new_page()
        browser_events: list[dict[str, str]] = []
        page.on(
            "console",
            lambda message: browser_events.append(
                {"type": f"console:{message.type}", "message": message.text}
            )
            if message.type == "error"
            else None,
        )
        page.on(
            "pageerror",
            lambda error: browser_events.append(
                {"type": "pageerror", "message": str(error)}
            ),
        )
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
        except Exception:
            try:
                _capture_portal_state(page, audit, "99-异常现场", browser_events)
            except Exception as capture_error:
                audit.warn(f"[证据采集] 异常现场保存失败：{capture_error}")
            raise
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
    _capture_portal_state(page, audit, "01-发票页初始")
    scope = _wait_invoice_scope(page, match.company_code, match.invoice_kind)
    audit.info(
        f"[页面识别] 已找到可交互业务区域：{_scope_description(scope)}"
    )

    _select_company_and_kind(scope, match.company_code, match.invoice_kind)
    _capture(scope, audit, "02-公司与业务类型")
    existing_basket = _open_existing_basket(scope, task, match, audit)
    if not existing_basket:
        if _click_if_present(scope, "下一步"):
            date_label = (
                "收货日期"
                if match.invoice_kind == "non_consignment"
                else "凭证日期"
            )
            scope = _wait_date_scope(_root_page(scope), date_label)

        if match.invoice_kind == "non_consignment":
            _process_non_consignment_rows(scope, match, audit)
        else:
            _process_consignment_summary(scope, cfg, task, match, audit)

    total = _extract_labeled_amount(scope, "货款总额")
    expected_excl_tax = money(task["amount_excl_tax"])
    if total != expected_excl_tax:
        mismatch = _mismatch_screenshot_path(cfg, audit, task)
        _root_page(scope).screenshot(path=str(mismatch), full_page=True)
        raise RuntimeError(
            f"施耐德货款总额 {total} != T100 原币税前 {expected_excl_tax}；"
            f"截图已保存：{mismatch}"
        )
    audit.info(f"[金额核对] 货款总额={total}，与 T100 原币税前一致")
    _capture(scope, audit, "05-金额核对一致")

    if _has_visible_click_target(scope, "下一步"):
        _click_text(scope, "下一步")
        scope = _wait_invoice_fields_scope(_root_page(scope))

    _fill_invoice_fields(scope, task)
    _capture(scope, audit, "06-发票字段已填")
    _click_text(scope, "检查")
    _wait_until(
        lambda: _check_result_is_zero(scope),
        timeout=15,
        message="点击检查后结果未变为 0。",
    )
    audit.info("[检查] 结果为 0")
    _capture(scope, audit, "07-检查结果为零")

    _click_text(scope, "生成")
    _root_page(scope).wait_for_url(
        re.compile(r".*(?:generateSubmit|submit|confirm).*\.jsp.*"),
        timeout=20_000,
    )
    scope = _root_page(scope)
    _verify_confirmation_page(scope, task)
    _capture(scope, audit, "08-最终确认页-未提交")
    audit.info("[生成] 已到最终确认页，四个发票字段复核一致")

    if commit_reference:
        raise RedlineViolation(
            "[COMMIT_GATE] 当前 Chromium 执行器只允许提交前制单，禁止最终确认；"
            "生产提交需要 Microsoft Edge IE 模式。"
        )
    audit.info("[PREPARE_GATE] 已到最终确认页，硬性停止；未提交、未回写 T100")
    return WebsiteResult(reached_confirmation=True, committed=False)


def _root_page(scope):
    return scope if hasattr(scope, "context") else scope.page


def _portal_scopes(page):
    scopes = [page]
    for frame in page.frames:
        if frame != page.main_frame:
            scopes.append(frame)
    return scopes


def _scope_description(scope) -> str:
    if hasattr(scope, "context"):
        return f"top:{scope.url}"
    return f"frame:{scope.name or '<unnamed>'}:{scope.url}"


def _scope_has_invoice_controls(scope, company_code: str, kind: str) -> bool:
    has_company = False
    has_kind_select = False
    expected_kind = "非寄售" if kind == "non_consignment" else "寄售"
    selects = scope.locator("select")
    for index in range(selects.count()):
        select = selects.nth(index)
        if not select.is_visible() or not select.is_enabled():
            continue
        options = [
            text.strip() for text in select.locator("option").all_inner_texts()
        ]
        has_company = has_company or any(company_code in text for text in options)
        has_kind_select = has_kind_select or expected_kind in options

    kind_value = "0" if kind == "non_consignment" else "1"
    kind_control = scope.locator(
        f"input[name='vmiType'][value='{kind_value}']"
    )
    has_kind_radio = kind_control.count() > 0
    if has_kind_radio and hasattr(kind_control, "first"):
        has_kind_radio = (
            kind_control.first.is_visible() and kind_control.first.is_enabled()
        )
    return has_company and (has_kind_select or has_kind_radio)


def _wait_invoice_scope(
    page, company_code: str, kind: str, timeout: int = 30
):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        for scope in _portal_scopes(page):
            try:
                if _scope_has_invoice_controls(scope, company_code, kind):
                    return scope
            except Exception as exc:
                last_error = exc
        page.wait_for_timeout(300)
    frames = ", ".join(_scope_description(scope) for scope in _portal_scopes(page))
    suffix = f"；最后错误：{last_error}" if last_error else ""
    raise RuntimeError(
        f"页面未出现公司 {company_code} 与业务类型对应的可交互下拉框；"
        f"已检查：{frames}{suffix}"
    )


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
    kind_value = "0" if kind == "non_consignment" else "1"
    kind_control = page.locator(
        f"input[name='vmiType'][value='{kind_value}']"
    )
    if not kind_control.count():
        raise RuntimeError(f"业务类型控件没有 {expected!r}。")
    kind_control.first.check()


def _open_existing_basket(page, task: dict, match: MatchData, audit) -> bool:
    basket = page.locator("#toCkot")
    if not basket.count() or not basket.first.is_visible() or basket.first.is_disabled():
        return False
    basket.first.click()
    page.wait_for_url(re.compile(r".*checkOut\.jsp.*"), timeout=20_000)
    expected_total = money(task["amount_excl_tax"])
    total = _extract_labeled_amount(page, "货款总额")
    body = re.sub(r"\s+", " ", _body_text(page))
    count_match = re.search(r"共有\s*(\d+)\s*条数据", body)
    count = int(count_match.group(1)) if count_match else None
    if total == expected_total and count == len(match.row_keys):
        audit.info(f"[断点续跑] 复用现有发票篮：{count} 行，货款总额={total}")
        _capture(page, audit, "03-复用现有发票篮")
        return True
    raise RuntimeError(
        "当前发票篮已有其他或不完整数据："
        f"页面行数={count}、金额={total}；"
        f"期望行数={len(match.row_keys)}、金额={expected_total}。"
        "为避免覆盖他人数据，流程已停止。"
    )


def _process_non_consignment_rows(page, match: MatchData, audit):
    start, end = _search_date_inputs(page, "收货日期")
    _set_input_value(start, f"{match.receipt_start:%Y.%m.%d}")
    _set_input_value(end, f"{match.receipt_end:%Y.%m.%d}")
    _click_search(page)
    _wait_order_table(page)
    if _set_page_size_100(page):
        _wait_order_table(page)
        audit.info("[分页] 已切换为每页 100 条")
    else:
        audit.info("[分页] 未找到每页 100 控件，按当前页数逐页处理")

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
            selected_boxes = [
                rows.nth(row_index).locator("input[type='checkbox']").last
                for row_index in range(rows.count())
                if rows.nth(row_index).locator("input[type='checkbox']").count()
                and rows.nth(row_index).locator("input[type='checkbox']").last.is_checked()
                and not rows.nth(row_index).locator("input[type='checkbox']").last.is_disabled()
            ]
            _click_text(page, "放入发票篮")
            _wait_until(
                lambda: all(box.is_disabled() for box in selected_boxes),
                timeout=15,
                message="放入发票篮后，所选明细未变为已加入状态。",
            )
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
    _go_to_invoice_basket(page)
    _capture(page, audit, "03-非寄售明细已入发票篮")


def _process_consignment_summary(
    page, cfg: dict, task: dict, match: MatchData, audit
):
    start_date, end_date = parse_consignment_range(task["invoice_remark"])
    start, end = _search_date_inputs(page, "凭证日期")
    _set_input_value(start, f"{start_date:%Y.%m.%d}")
    _set_input_value(end, f"{end_date:%Y.%m.%d}")
    _click_search(page)

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
    _go_to_invoice_basket(page)


def _wait_invoice_fields_scope(page, timeout: int = 20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for scope in _portal_scopes(page):
            body = re.sub(r"\s+", " ", _body_text(scope))
            if "发票号码" in body and (
                "发票总额" in body or "增值税额" in body
            ):
                return scope
        page.wait_for_timeout(250)
    raise RuntimeError("点击发票篮下一步后，未进入发票字段填写页。")


def _fill_invoice_fields(page, task: dict):
    values = (
        ("#invoiceNumber", "发票号码", task["invoice_no"]),
        ("#invoiceDate", "开票日期", f"{_invoice_date(task):%Y.%m.%d}"),
        ("#totalAmount", "发票总额（含税）", task["amount_incl_tax"]),
        ("#vatAmount", "增值税额", task["tax"]),
    )
    for selector, label, value in values:
        field = page.locator(selector)
        field = field.first if field.count() else _input_after_label(page, label)
        if field.get_attribute("readonly") is not None:
            _set_input_value(field, str(value))
        else:
            field.fill(str(value))


def _verify_confirmation_page(page, task: dict):
    body = re.sub(r"\s+", " ", _body_text(page).replace(",", ""))
    missing = []

    if not hasattr(page, "locator"):
        _verify_confirmation_text(body, task)
        return

    invoice_field = page.locator("#invoiceNumber")
    invoice_value = (
        invoice_field.first.input_value().strip()
        if invoice_field.count()
        else None
    )
    if invoice_value != str(task["invoice_no"]):
        invoice_pattern = (
            rf"发票号码\s*[:：]?\s*{re.escape(str(task['invoice_no']))}(?:\s|$)"
        )
        if not re.search(invoice_pattern, body):
            missing.append(f"发票号码={task['invoice_no']}（页面={invoice_value}）")

    date_value = f"{_invoice_date(task):%Y.%m.%d}"
    date_field = page.locator("#invoiceDate")
    page_date = date_field.first.input_value().strip() if date_field.count() else None
    normalized_page_date = page_date.replace("/", ".").replace("-", ".") if page_date else None
    if normalized_page_date != date_value:
        date_pattern = (
            r"(?:开票日期|发票日期)\s*[:：]?\s*"
            + re.escape(date_value).replace(r"\.", r"[./-]")
            + r"(?:\s|$)"
        )
        if not re.search(date_pattern, body):
            missing.append(f"开票日期/发票日期={date_value}（页面={page_date}）")

    for selector, labels, expected in (
        ("#totalAmount", ("发票总额（含税）", "发票总额(含税)"), money(task["amount_incl_tax"])),
        ("#vatAmount", ("增值税额",), money(task["tax"])),
    ):
        field = page.locator(selector)
        value = money(field.first.input_value()) if field.count() else None
        if value is None:
            value = _extract_amount_after_any_label(body, labels)
        if value != expected:
            missing.append(f"{'/'.join(labels)}={expected}（页面={value}）")
    if missing:
        raise RuntimeError(f"最终确认页字段未按标签复核通过：{missing}")


def _verify_confirmation_text(body: str, task: dict):
    expected = (
        ("发票号码", str(task["invoice_no"])),
        ("开票日期", f"{_invoice_date(task):%Y.%m.%d}"),
        ("发票总额（含税）", f"{money(task['amount_incl_tax']):.2f}"),
        ("增值税额", f"{money(task['tax']):.2f}"),
    )
    missing = []
    for label, value in expected:
        pattern = rf"{re.escape(label)}\s*[:：]?\s*{re.escape(value)}(?:\s|$)"
        if not re.search(pattern, body):
            missing.append(f"{label}={value}")
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
    result = page.locator("#chkAmt")
    if result.count():
        value = result.first.input_value().strip()
        return bool(value) and money(value) == money("0")
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


def _set_input_value(field, value: str):
    field.evaluate(
        "(element, nextValue) => {"
        "element.removeAttribute('readonly');"
        "element.value = nextValue;"
        "element.dispatchEvent(new Event('input', {bubbles: true}));"
        "element.dispatchEvent(new Event('change', {bubbles: true}));"
        "}",
        value,
    )


def _click_search(page):
    try:
        _click_text(page, "搜索")
        return
    except RuntimeError:
        candidates = page.locator(
            "xpath=//*[@onclick and contains(translate(@onclick, "
            "'SEARCH', 'search'), 'search(')]"
        )
        for index in range(candidates.count()):
            candidate = candidates.nth(index)
            if candidate.is_visible() and candidate.is_enabled():
                candidate.click()
                return
    raise RuntimeError("页面未找到可点击的 '搜索'。")


def _go_to_invoice_basket(page):
    if _click_if_present(page, "发票篮"):
        page.wait_for_url(re.compile(r".*checkOut\.jsp.*"), timeout=20_000)
        return
    basket = page.locator("#toCkot")
    if basket.count() and basket.first.is_visible() and basket.first.is_enabled():
        basket.first.click()
        page.wait_for_url(re.compile(r".*checkOut\.jsp.*"), timeout=20_000)
        return
    raise RuntimeError("页面未找到进入发票篮的控件。")


def _wait_order_table(page, timeout: int = 20):
    _wait_until(
        lambda: page.locator("#dtList tr[name='infoLs']").count() > 0,
        timeout=timeout,
        message="日期搜索或分页后，订单明细表未加载完成。",
    )


def _find_order_table(page):
    table = page.locator("#dtList")
    if table.count():
        table = table.first
        header_map = _header_map(table)
        if {"订单号", "行号"} <= set(header_map):
            return table, header_map
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


def _set_page_size_100(page) -> bool:
    selects = page.locator("select")
    for index in range(selects.count()):
        select = selects.nth(index)
        if not select.is_visible() or not select.is_enabled():
            continue
        options = {text.strip() for text in select.locator("option").all_inner_texts()}
        if "100" in options and len(options & {"10", "15", "20", "30", "50", "100"}) >= 2:
            select.select_option(label="100")
            return True

    candidates = page.locator("[onclick]")
    for index in range(candidates.count()):
        candidate = candidates.nth(index)
        onclick = candidate.get_attribute("onclick") or ""
        if not re.search(r"\breload\s*\(\s*100\s*\)", onclick, re.I):
            continue
        if candidate.is_visible() and candidate.is_enabled():
            candidate.click()
            page.wait_for_load_state("domcontentloaded")
            return True
    return False


def _input_after_label(page, label: str):
    labels = [label]
    if label == "开票日期":
        labels.append("发票日期")
    if label == "发票总额（含税）":
        labels.extend(("发票总额(含税)", "发票总额"))

    for candidate_label in labels:
        fields = page.locator(
            "xpath=//*[self::td or self::th or self::label or self::span]"
            f"[contains(normalize-space(.),'{candidate_label}')]"
            "/following::input[not(@type='hidden')][1]"
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


def _capture(page, audit, name: str):
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name).strip(" .")
    screenshot = Path(audit.screenshot_dir) / f"{safe_name}.png"
    dom = Path(audit.dom_dir) / f"{safe_name}.html"
    _root_page(page).screenshot(path=str(screenshot), full_page=True)
    dom.write_text(page.content(), encoding="utf-8")


def _wait_date_scope(page, label: str, timeout: int = 30):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        for scope in _portal_scopes(page):
            try:
                _search_date_inputs(scope, label)
                return scope
            except Exception as exc:
                last_error = exc
        page.wait_for_timeout(300)
    frames = ", ".join(_scope_description(scope) for scope in _portal_scopes(page))
    suffix = f"；最后错误：{last_error}" if last_error else ""
    raise RuntimeError(
        f"页面未出现 {label} 起止输入框；已检查：{frames}{suffix}"
    )


def _capture_portal_state(
    page,
    audit,
    name: str,
    browser_events: list[dict[str, str]] | None = None,
):
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name).strip(" .")
    screenshot = Path(audit.screenshot_dir) / f"{safe_name}.png"
    _root_page(page).screenshot(path=str(screenshot), full_page=True)

    frames = []
    for index, scope in enumerate(_portal_scopes(_root_page(page))):
        entry = {
            "index": index,
            "kind": "top" if hasattr(scope, "context") else "frame",
            "name": "" if hasattr(scope, "context") else scope.name,
            "url": scope.url,
        }
        try:
            dom = Path(audit.dom_dir) / f"{safe_name}-{index:02d}.html"
            dom.write_text(scope.content(), encoding="utf-8")
            entry["domPath"] = str(dom)
        except Exception as exc:
            entry["captureError"] = str(exc)
        frames.append(entry)

    diagnostics = Path(audit.dom_dir) / f"{safe_name}-诊断.json"
    diagnostics.write_text(
        json.dumps(
            {
                "pageUrl": _root_page(page).url,
                "pageTitle": _root_page(page).title(),
                "frames": frames,
                "browserEvents": browser_events or [],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
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
