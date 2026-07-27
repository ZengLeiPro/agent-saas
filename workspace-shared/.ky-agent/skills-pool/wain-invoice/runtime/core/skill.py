"""
主 skill — 通用 1.1-1.8 八步流程。

默认客户流程在 POC 期只跑 1.1-1.6；拥有 run_workflow() 的客户模块可实现
自己的完整闭环，并通过 commit_reference 对最终不可逆动作做单据级授权。

用法：
    python -m core.skill --client stepelectric --mode mock
    python -m core.skill --client stepelectric --mode real
"""

from __future__ import annotations
import argparse
import asyncio
import importlib
import os
from pathlib import Path

import yaml
from playwright.async_api import async_playwright

from core.safety import SafePage, RedlineViolation, assert_not_submitted
from core.audit import Audit, redact_sensitive
from core.selectors import SelectorResolver
from core.self_repair import SelfRepair


def load_config(client: str) -> dict:
    p = Path(__file__).parent.parent / "clients" / client / "config.yaml"
    return yaml.safe_load(p.read_text(encoding="utf-8"))


def load_credentials(client: str) -> dict:
    """凭据查找链（按优先级，命中即返回）：
       1. ~/.config/wain-invoice/credentials/<client>.env 文件（开发/老配置）
       2. 环境变量 <CLIENT>_USER / <CLIENT>_PASS（client-specific；entrypoint 从 .env 映射注入）
    绝不入 git。
    **不要 fallback 到通用 USERNAME 环境变量**——Windows 自带 USERNAME=登录用户名，会污染。"""
    try:
        from dotenv import dotenv_values
        p = Path.home() / ".config" / "wain-invoice" / "credentials" / f"{client}.env"
        if p.exists():
            d = dotenv_values(p)
            if d.get("USERNAME") and d.get("PASSWORD"):
                return {"username": d["USERNAME"], "password": d["PASSWORD"]}
    except ImportError:
        pass

    prefix = client.upper().replace("-", "_")
    return {
        "username": os.environ.get(f"{prefix}_USER"),
        "password": os.environ.get(f"{prefix}_PASS"),
    }


def load_adapter(adapter_name: str, mode: str, cfg: dict):
    """按 mode 加载 t100 / share_drive 的 mock 或 real 实现。"""
    mod = importlib.import_module(f"adapters.{adapter_name}.{mode}")
    return mod.create(cfg)


async def run(
    client: str,
    mode: str,
    headed: bool = False,
    slow_mo: int = 100,
    channel: str = None,
    task_reference: str | None = None,
    commit_reference: str | None = None,
    preflight_only: bool = False,
    interactive: bool = False,
    captcha_value: str | None = None,
    challenge_file: str | None = None,
):
    cfg = load_config(client)
    creds = load_credentials(client)
    audit = Audit(client)
    os.environ["WAIN_INVOICE_ACTIVE_RUN_DIR"] = str(audit.dir)
    audit.info(f"mode={mode} client={client} cfg.url={cfg.get('url')!r} headed={headed} slow_mo={slow_mo} channel={channel!r}")

    if (
        mode == "real"
        and not cfg.get("credentials_from_t100")
        and (not creds.get("username") or not creds.get("password"))
    ):
        raise RuntimeError(
            f"real 模式但未找到凭据。请创建 "
            f"~/.config/wain-invoice/credentials/{client}.env（含 USERNAME/PASSWORD）"
        )

    t100 = load_adapter("t100", mode, cfg)
    share = load_adapter("share_drive", mode, cfg)
    client_flow = importlib.import_module(f"clients.{client}.flow")

    # 施耐德等客户不是“上传 PDF”的通用模型，由客户模块负责完整业务闭环。
    # 最终不可逆动作必须同时满足：客户模块显式支持 + 精确 commit_reference。
    if hasattr(client_flow, "run_workflow"):
        try:
            await client_flow.run_workflow(
                cfg=cfg,
                t100=t100,
                share=share,
                audit=audit,
                credentials=creds,
                task_reference=task_reference,
                commit_reference=commit_reference,
                preflight_only=preflight_only,
                interactive=interactive,
                captcha_value=captcha_value,
                challenge_file=challenge_file,
            )
        except Exception as exc:
            audit.error(f"流程异常：{exc}")
            raise
        finally:
            await audit.close()
        return

    sel = SelectorResolver(client, audit=audit)
    repair = SelfRepair(audit=audit)  # vision_client=None → POC stub

    async with async_playwright() as pw:
        # headed=True 时 headless=False（看得见浏览器跑），向客户/老板演示用
        # slow_mo 控制每个操作的延迟（ms），演示时建议 500-800 让人眼能跟上
        # channel='chrome'/'msedge' 用系统浏览器（不带 playwright 自带 chromium，绕开 200MB 下载）
        launch_kwargs = {"headless": not headed, "slow_mo": slow_mo}
        if channel:
            launch_kwargs["channel"] = channel
        browser = await pw.chromium.launch(**launch_kwargs)
        ctx_kwargs = {
            "viewport": {"width": 1440, "height": 900},
            # 强制 en-US locale，避免 Chrome/Edge 用系统中文 locale 导致 SRM i18n 切换成中文
            # （selectors.json 是按英文 UI 写的，i18n 切换会让所有 nav.* 选不中）
            "locale": "en-US",
        }
        # 视频录像需要 ffmpeg；PyInstaller 打包默认不收 ffmpeg，由 entrypoint 设环境变量跳过
        if not os.environ.get("WAIN_INVOICE_DISABLE_VIDEO"):
            ctx_kwargs["record_video_dir"] = str(audit.video_dir)
        ctx = await browser.new_context(**ctx_kwargs)
        page = await ctx.new_page()
        safe = SafePage(page, audit=audit, allow=cfg.get("allow_selectors", []))

        try:
            # 1.1 取数
            tasks = await t100.fetch_pending_invoices()
            audit.info(f"[1.1] 取到 {len(tasks)} 条待开票任务")
            if not tasks:
                audit.warn("无待开票任务，退出")
                return

            # 单单据闭环：POC 期跑第一条即可
            task = tasks[0]
            audit.info(f"[1.1] 处理任务：{redact_sensitive(task)}")

            # 1.2 登录
            await step_1_2_login(safe, sel, repair, cfg, creds)
            audit.info("[1.2] 登录完成")

            # 1.3 定位待开票单据（客户特殊步骤）
            await client_flow.locate(safe, sel, repair, task, audit)
            audit.info("[1.3] 已定位到目标单据")

            # 1.4 准备文件 + 业务数据
            files = await t100.download_invoice_files(task)
            biz = await client_flow.prepare_business_data(t100, share, task, audit)
            audit.info(f"[1.4] 准备完成 files={[Path(f).name for f in files]} biz={biz}")

            # 1.5 POC 演示模式：定位 file input 但不真上传（已结束单跑 set_input_files 不安全）
            #     真生产场景在「供应商开票」状态单上 + 主流程会真调 set_input_files()
            file_input_sel = await sel.resolve_or_repair(page, "upload.file_input", repair)
            audit.info(f"[1.5/DEMO] 已定位 file input selector={file_input_sel!r}")
            audit.info(f"[1.5/DEMO] 真生产场景这里会执行：safe.set_input_files({file_input_sel!r}, {[str(f) for f in files]})")
            audit.info(f"[1.5/DEMO] POC 跑已结束单不真传，跳过实际上传动作")
            await page.screenshot(path=str(audit.dir / "DEMO_1_5_before_upload.png"), full_page=True)

            # 1.6 演示核对：读 Invoice Details tab 已存在的发票表格，对比 mock biz
            ok = await step_1_6_demo_verify(page, biz, audit)
            audit.info(f"[1.6/DEMO] 核对演示完成 ok={ok}")
            await page.screenshot(path=str(audit.dir / "DEMO_1_6_after_verify.png"), full_page=True)

            # 1.7 红线触发演示：故意尝试点 Upload，证明 SafePage 真的能拦
            audit.info("[REDLINE_DEMO] 准备演示红线机制：故意尝试点 Upload 按钮")
            try:
                await safe.click("button:has-text('Upload')")
                audit.error("[REDLINE_DEMO] !!! 红线没拦住！这是严重 bug")
            except RedlineViolation as e:
                audit.info(f"[REDLINE_DEMO] ✅ SafePage 当场拦截：{e}")
                await page.screenshot(path=str(audit.dir / "DEMO_REDLINE_blocked.png"), full_page=True)

            # 流程末尾红线复核
            await assert_not_submitted(page)
            audit.info("[POST_CHECK] 红线复核通过：未跳转到任何提交/成功页")

            # 1.7 / 1.8 真生产期：1.7 写动作（提交/保存）POC 期禁用；1.8 收尾登记
            audit.info("[1.7/1.8] POC 期跳过实际提交与收尾登记")

        except RedlineViolation as e:
            audit.error(f"红线违反！立即终止：{e}")
            await page.screenshot(path=str(audit.dir / "REDLINE_VIOLATION.png"), full_page=True)
            raise
        except Exception as e:
            audit.error(f"流程异常：{e}")
            try:
                await page.screenshot(path=str(audit.dir / "ERROR.png"), full_page=True)
            except Exception:
                pass
            raise
        finally:
            await audit.close()
            await ctx.close()
            await browser.close()


async def step_1_2_login(safe, sel, repair, cfg, creds):
    await safe.goto(cfg["url"], wait_until="domcontentloaded")
    # Angular SPA 加载等待
    try:
        await safe._page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    await safe._page.wait_for_timeout(2000)
    # 显式等 username 输入框出现（SPA 路由渲染需要时间）
    await safe._page.wait_for_selector("input[placeholder*='Account'], input[type='password']", timeout=15000)

    user_sel = await sel.resolve_or_repair(safe._page, "login.username", repair)
    pass_sel = await sel.resolve_or_repair(safe._page, "login.password", repair)
    btn_sel = await sel.resolve_or_repair(safe._page, "login.login_button", repair)
    await safe.fill(user_sel, creds["username"])
    await safe.fill(pass_sel, creds["password"])
    await safe.click(btn_sel)
    # 关弹窗
    try:
        await safe._page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    await safe._page.wait_for_timeout(2500)


async def step_1_6_verify(safe, sel, biz, cfg, audit):
    """真生产：读 verify.* 字段对比 biz。POC 期走 demo 版。"""
    fields = ["invoice_no", "amount_excl_tax", "tax", "amount_incl_tax"]
    tolerance = float(cfg.get("verify_tolerance", 1.0))
    diffs = []
    for f in fields:
        page_val_sel = await sel.resolve(safe._page, f"verify.{f}")
        if not page_val_sel:
            diffs.append((f, "<未找到字段>", biz.get(f)))
            continue
        page_val = (await safe._page.inner_text(page_val_sel)).strip()
        if not _match(page_val, biz.get(f), tolerance):
            diffs.append((f, page_val, biz.get(f)))
    if diffs:
        audit.warn(f"[1.6] 核对不一致：{diffs}")
        return False
    return True


async def step_1_6_demo_verify(page, biz, audit):
    """
    POC demo 版核对：从 Invoice Details tab 已显示的发票表格里读已有发票，
    用作"假装上传后系统解析出来的字段"，跟 mock biz 对比。
    返回 (ok, diffs)。
    """
    table_data = await page.evaluate(r"""() => {
        // Invoice Details 面板的发票表格特征：列含「发票号码 / Amount(No Tax) / Tax / Amount(Tax) / 附件」
        const tables = Array.from(document.querySelectorAll('.ant-table'));
        for (const t of tables) {
            const headers = Array.from(t.querySelectorAll('.ant-table-thead th, [role="columnheader"]'))
                .map(h => h.innerText.trim());
            const headerText = headers.join('|');
            if (/发票号码|Amount.*Tax|附件/.test(headerText)) {
                const rows = Array.from(t.querySelectorAll('.ant-table-tbody tr')).filter(r => r.querySelector('td'));
                const firstRow = rows[0];
                if (firstRow) {
                    const cells = Array.from(firstRow.querySelectorAll('td')).map(td => td.innerText.trim());
                    return {headers, firstRowCells: cells, rowCount: rows.length};
                }
            }
        }
        return null;
    }""")

    if not table_data:
        audit.warn("[1.6/DEMO] 没找到发票表格——可能不是已结束单或表格 selector 变化")
        return False

    audit.info(f"[1.6/DEMO] 发票表格表头：{table_data['headers']}")
    audit.info(f"[1.6/DEMO] 第一行（脱敏后）：")
    masked = [c[:3] + "***" if len(c) > 6 else c for c in table_data["firstRowCells"]]
    audit.info(f"          {masked}")

    # 精确匹配表头（"Tax" 是 "Amount(No Tax)" 的子串，不能用子串匹配）
    def find_exact(target):
        for i, h in enumerate(table_data["headers"]):
            if h == target:
                return i
        return None

    def cell(col_idx):
        if col_idx is None or col_idx >= len(table_data["firstRowCells"]):
            return None
        return table_data["firstRowCells"][col_idx]

    page_invoice_no = cell(find_exact("发票号码"))
    page_no_tax = cell(find_exact("Amount(No Tax)"))
    page_tax = cell(find_exact("Tax"))
    page_inc_tax = cell(find_exact("Amount(Tax)"))

    audit.info(f"[1.6/DEMO] 页面发票号 vs mock：{page_invoice_no!r} vs {biz['invoice_no']!r}")
    audit.info(f"[1.6/DEMO] 页面不含税 vs mock：{page_no_tax!r} vs {biz['amount_excl_tax']!r}")
    audit.info(f"[1.6/DEMO] 页面税额   vs mock：{page_tax!r} vs {biz['tax']!r}")
    audit.info(f"[1.6/DEMO] 页面含税   vs mock：{page_inc_tax!r} vs {biz['amount_incl_tax']!r}")
    audit.info(f"[1.6/DEMO] （已结束单的字段是该单原始发票，跟 mock biz 数值不一致是预期——演示核对逻辑跑通即可）")
    return True


def _match(page_val, expected, tolerance):
    if expected is None:
        return False
    try:
        return abs(float(str(page_val).replace(",", "")) - float(expected)) <= tolerance
    except Exception:
        return str(page_val).strip() == str(expected).strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client", required=True, help="clients/ 下子目录名")
    p.add_argument("--mode", default="mock", choices=["mock", "real"])
    p.add_argument("--headed", action="store_true", help="可见浏览器跑（演示模式，需在 GUI 桌面）")
    p.add_argument("--slow-mo", type=int, default=100, help="每步延迟 ms，演示建议 500-800")
    p.add_argument("--channel", default=None, choices=[None, "chrome", "msedge", "chromium"],
                   help="浏览器渠道：chrome/msedge=用系统已装的浏览器（绕开 playwright 200MB chromium）；不传=默认 chromium")
    p.add_argument(
        "--task-reference",
        default=None,
        help="指定处理的对账单号或开票单号；待办超过一条时必须提供",
    )
    p.add_argument(
        "--commit-reference",
        default=None,
        help="最终提交授权：必须填写当前对账单号或开票单号；不传则止步于最终确认页",
    )
    p.add_argument(
        "--preflight-only",
        action="store_true",
        help="只验证 T100 数据、对账 Excel 和业务规则，不启动客户网站",
    )
    p.add_argument(
        "--interactive",
        action="store_true",
        help="交互选择待办，并在最终确认页要求人工输入对账单号",
    )
    p.add_argument(
        "--captcha",
        default=None,
        help="人工读取的施耐德登录验证码；必须与 --challenge-file 属于同一会话",
    )
    p.add_argument(
        "--challenge-file",
        default=None,
        help="captcha 步骤生成的 challenge.json",
    )
    args = p.parse_args()
    asyncio.run(
        run(
            args.client,
            args.mode,
            headed=args.headed,
            slow_mo=args.slow_mo,
            channel=args.channel,
            task_reference=args.task_reference,
            commit_reference=args.commit_reference,
            preflight_only=args.preflight_only,
            interactive=args.interactive,
            captcha_value=args.captcha,
            challenge_file=args.challenge_file,
        )
    )


if __name__ == "__main__":
    main()
