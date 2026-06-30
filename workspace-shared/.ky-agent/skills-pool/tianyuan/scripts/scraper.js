/**
 * 钉钉天元服务平台 - 通用分页表格数据抓取脚本
 * 在 Safari Web Inspector 控制台粘贴执行
 * 适用于：订单管理、商机管理、Leads 等所有带分页表格的页面
 *
 * 支持自动导航：脚本执行前通过 window.__TARGET_MODULE__ 指定目标模块名
 * 例如：window.__TARGET_MODULE__ = '订单管理';
 * 如果已在目标页面（有表格数据），跳过导航直接抓取
 */
(async function DingTalkScraper() {
  'use strict';

  const DELAY_BETWEEN_PAGES = 1500;
  const MAX_PAGES = 500;
  const TARGET_MODULE = window.__TARGET_MODULE__ || '';

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getHeaders() {
    const headerRow = document.querySelector('table tr');
    if (!headerRow) return [];
    return [...headerRow.cells].map(c => c.textContent.trim()).filter(h => h);
  }

  function getRows() {
    const rows = [...document.querySelectorAll('table tr')];
    return rows.slice(1).filter(row => {
      const cells = [...row.cells].map(c => c.textContent.trim());
      return cells.some(c => c && c !== '');
    }).map(row => [...row.cells].map(c => c.textContent.trim()));
  }

  function clickNextPage() {
    const selectors = [
      '.ant-pagination-next:not(.ant-pagination-disabled)',
      '[class*="pagination"] .next:not(.disabled)',
      'button[aria-label="next"]',
      '.next-btn:not(.disabled)',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); return true; }
    }
    const allBtns = document.querySelectorAll('button, a, li, span');
    for (const btn of allBtns) {
      const text = btn.textContent.trim();
      if ((text === '>' || text === '›' || text === '下一页') && !btn.disabled && !btn.classList.contains('disabled')) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function isLastPage() {
    const disabled = document.querySelectorAll(
      '.ant-pagination-next.ant-pagination-disabled, [class*="pagination"] .next.disabled'
    );
    if (disabled.length > 0) return true;
    const allBtns = document.querySelectorAll('button, a, li, span');
    for (const btn of allBtns) {
      if (btn.textContent.trim() === '>' && (btn.disabled || btn.classList.contains('disabled'))) {
        return true;
      }
    }
    return false;
  }

  // ========== 导航逻辑 ==========
  // 在 DOM 中查找并点击左侧菜单项，比 peekaboo accessibility 点击可靠得多
  function navigateToModule(moduleName) {
    // 侧边栏菜单项通常是 <a> 或带 click 的 <span>/<div>
    const candidates = document.querySelectorAll('a, span, div, li');
    for (const el of candidates) {
      // 精确匹配文本内容（排除包含子元素文本的父容器）
      if (el.childElementCount === 0 && el.textContent.trim() === moduleName) {
        el.click();
        console.log('🧭 已点击菜单: ' + moduleName);
        return true;
      }
    }
    // 兜底：匹配含文本的最小元素
    for (const el of candidates) {
      if (el.textContent.trim() === moduleName) {
        el.click();
        console.log('🧭 已点击菜单(兜底): ' + moduleName);
        return true;
      }
    }
    console.warn('⚠️ 未找到菜单项: ' + moduleName);
    return false;
  }

  // ========== 主逻辑 ==========
  console.log('%c🚀 钉钉天元数据抓取开始', 'color: #1890ff; font-size: 16px; font-weight: bold;');

  // 如果指定了目标模块，先导航
  if (TARGET_MODULE) {
    console.log('🧭 目标模块: ' + TARGET_MODULE);
    navigateToModule(TARGET_MODULE);
    // 等待页面加载
    await sleep(3000);
  }

  const headers = getHeaders();
  if (headers.length === 0) {
    console.error('❌ 未找到表格，请确保当前页面有数据表格');
    return;
  }
  console.log('📋 表头(' + headers.length + '): ' + headers.join(', '));

  const allData = [];
  let pageNum = 0;
  let consecutiveEmpty = 0;

  while (pageNum < MAX_PAGES) {
    pageNum++;
    const rows = getRows();

    if (rows.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) {
        console.log('⚠️ 连续3页无数据，停止');
        break;
      }
    } else {
      consecutiveEmpty = 0;
      allData.push(...rows);
      console.log('📄 第' + pageNum + '页: ' + rows.length + '条 (累计: ' + allData.length + '条)');
    }

    if (isLastPage()) {
      console.log('✅ 已到最后一页 (第' + pageNum + '页)');
      break;
    }

    if (!clickNextPage()) {
      console.log('⚠️ 无法翻页，停止于第' + pageNum + '页');
      break;
    }

    await sleep(DELAY_BETWEEN_PAGES);
  }

  // ========== 输出 ==========
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').substring(0, 14);
  const filename = 'dingtalk-tianyuan-' + ts + '.json';

  const result = {
    scraped_at: now.toISOString(),
    page_url: location.href,
    headers: headers,
    total_rows: allData.length,
    total_pages: pageNum,
    data: allData
  };

  window.__SCRAPER_RESULT__ = result;
  window.__SCRAPER_DONE__ = true;

  console.log('%c✅ 完成: ' + allData.length + '条, ' + pageNum + '页', 'color: green; font-size: 14px; font-weight: bold;');
  console.log('💾 数据已存入 window.__SCRAPER_RESULT__');
  console.log('📋 如需手动复制: copy(JSON.stringify(window.__SCRAPER_RESULT__))');

  return result;
})();
