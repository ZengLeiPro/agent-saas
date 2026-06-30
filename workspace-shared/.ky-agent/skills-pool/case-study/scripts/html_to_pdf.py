#!/usr/bin/env python3
"""Render a local self-contained HTML case study to PDF with Playwright."""

import asyncio
import sys
from pathlib import Path


async def render_pdf(html_path: Path, pdf_path: Path) -> None:
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:
        raise SystemExit(
            "Missing dependency: Python Playwright is not available in this runtime. "
            "Use an ACS image with Playwright/Chromium installed; do not install global dependencies during a user task."
        ) from exc

    html_path = html_path.resolve()
    pdf_path = pdf_path.resolve()
    if not html_path.exists():
        raise SystemExit(f"HTML file not found: {html_path}")

    pdf_path.parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto(html_path.as_uri(), wait_until="networkidle")
        await page.pdf(
            path=str(pdf_path),
            format="A4",
            print_background=True,
            margin={"top": "12mm", "right": "10mm", "bottom": "12mm", "left": "10mm"},
        )
        await browser.close()

    print(f"PDF: {pdf_path}")


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: python3 html_to_pdf.py <input.html> <output.pdf>", file=sys.stderr)
        raise SystemExit(2)

    asyncio.run(render_pdf(Path(sys.argv[1]), Path(sys.argv[2])))


if __name__ == "__main__":
    main()
