/**
 * 钉钉授权等待页——写入 device flow 触发时同步 window.open 出来的 about:blank 弹窗。
 *
 * 为什么单独一个页面：从「点击连接钉钉」到弹窗被替换成钉钉官方授权页的间隔
 * 包含 ACS sandbox 冷启动（首次可达 1-3 分钟）+ dws CLI 启动 + 向钉钉申请
 * device code。弹窗必须在用户手势的同步栈里 window.open，此时还没有 URL，
 * 拿不到 authorizationUrl。若放任 about:blank，用户会盯白屏干等。
 *
 * 弹窗是独立 window，拿不到项目 CSS 变量与 Tailwind，样式全部内联；配色与主
 * 应用（brand-600 #2E56E1）保持一致，字体族对齐 PingFang SC，支持深色模式。
 */

// 与 assets/connector-brands/dingtalk.svg 同来源（Remix Icon dingding-fill，Apache 2.0）。
// 弹窗页无法引用打包资源，因此以 data URI 内联同一图形。
const DINGTALK_LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
  <path fill="#2E56E1" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10s10-4.477 10-10S17.523 2 12 2m4.49 9.04l-.006.014c-.42.898-1.516 2.66-1.516 2.66l-.005-.012l-.32.558h1.543l-2.948 3.919l.67-2.666h-1.215l.422-1.763a17 17 0 0 0-1.223.349s-.646.378-1.862-.729c0 0-.82-.722-.344-.902c.202-.077.981-.175 1.595-.257a80 80 0 0 1 1.338-.172s-2.555.039-3.161-.057c-.606-.095-1.375-1.107-1.539-1.996c0 0-.253-.488.545-.257s4.101.9 4.101.9S8.27 9.312 7.983 8.99c-.286-.32-.841-1.754-.769-2.634c0 0 .031-.22.257-.16c0 0 3.176 1.45 5.339 2.202c2.163.75 4.019 1.134 3.68 2.642"/>
</svg>
`.trim();

export function writeDingtalkAuthorizingPopup(popup: Window): void {
  const html = renderPopupHtml();
  try {
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  } catch {
    // 部分浏览器 write 失败时退化到纯文本，避免用户看到崩溃的白屏。
    try {
      popup.document.title = "正在连接钉钉";
      popup.document.body.textContent = "正在打开钉钉官方授权页面…";
    } catch {
      /* 忽略：popup 可能已经被浏览器策略关闭。 */
    }
  }
}

function renderPopupHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>正在连接钉钉 · 开沿</title>
<style>
  :root {
    color-scheme: light dark;
    --brand-50: #EEF2FF;
    --brand-100: #DDE5FF;
    --brand-600: #2E56E1;
    --brand-700: #2444C0;
    --page-bg: #F5F7FB;
    --card-bg: #FFFFFF;
    --border: rgba(15, 23, 42, 0.08);
    --text: #0F172A;
    --muted: #64748B;
    --step-idle-bg: #F1F5F9;
    --step-idle-border: rgba(15, 23, 42, 0.08);
    --step-idle-text: #94A3B8;
    --brand-shadow: 0 20px 45px -20px rgba(46, 86, 225, 0.35), 0 8px 20px -12px rgba(15, 23, 42, 0.12);
    --tip-bg: #EEF2FF;
    --tip-text: #2444C0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page-bg: #0B1220;
      --card-bg: #111827;
      --border: rgba(148, 163, 184, 0.16);
      --text: #E2E8F0;
      --muted: #94A3B8;
      --step-idle-bg: rgba(148, 163, 184, 0.12);
      --step-idle-border: rgba(148, 163, 184, 0.18);
      --step-idle-text: #64748B;
      --brand-shadow: 0 20px 45px -20px rgba(46, 86, 225, 0.55), 0 8px 20px -12px rgba(0, 0, 0, 0.5);
      --tip-bg: rgba(46, 86, 225, 0.16);
      --tip-text: #BDCCFF;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    background: var(--page-bg);
    color: var(--text);
    font-family: "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .stage {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 20px;
  }
  .card {
    width: min(420px, 100%);
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 36px 32px 28px;
    box-shadow: var(--brand-shadow);
    text-align: center;
  }
  .badge {
    position: relative;
    width: 72px;
    height: 72px;
    margin: 0 auto 20px;
    border-radius: 22px;
    background: #FFFFFF;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 0 1px var(--brand-100), 0 12px 24px -12px rgba(46, 86, 225, 0.4);
  }
  .badge svg { width: 44px; height: 44px; }
  .badge::after {
    content: "";
    position: absolute;
    inset: -6px;
    border-radius: 26px;
    border: 2px solid var(--brand-600);
    opacity: 0.4;
    animation: pulse 1.8s ease-out infinite;
  }
  @keyframes pulse {
    0%   { transform: scale(1);   opacity: 0.45; }
    70%  { transform: scale(1.12); opacity: 0;    }
    100% { transform: scale(1.12); opacity: 0;    }
  }
  h1 {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .subtitle {
    margin: 0 0 24px;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.7;
  }
  .subtitle strong {
    color: var(--text);
    font-weight: 600;
  }
  ol.steps {
    list-style: none;
    padding: 0;
    margin: 0 0 20px;
    text-align: left;
    display: grid;
    gap: 10px;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 4px;
    color: var(--step-idle-text);
    transition: color 0.2s;
  }
  .step.active { color: var(--brand-700); }
  .step-icon {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--card-bg);
    border: 1.5px solid currentColor;
    font-size: 12px;
    font-weight: 600;
    color: inherit;
  }
  .step.active .step-icon {
    background: var(--brand-600);
    border-color: var(--brand-600);
    color: #FFFFFF;
  }
  .step-icon .spinner {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 2px solid rgba(255, 255, 255, 0.45);
    border-top-color: #FFFFFF;
    animation: spin 0.85s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .step-label {
    font-size: 13.5px;
    font-weight: 500;
  }
  .step.active .step-label { font-weight: 600; }
  .tip {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--tip-bg);
    color: var(--tip-text);
    font-size: 12.5px;
    line-height: 1.55;
    text-align: left;
  }
  .tip svg { flex: none; margin-top: 2px; }
  @media (prefers-reduced-motion: reduce) {
    .badge::after,
    .step-icon .spinner {
      animation: none;
    }
  }
</style>
</head>
<body>
  <main class="stage">
    <section class="card" role="status" aria-live="polite">
      <div class="badge" aria-hidden="true">${DINGTALK_LOGO_SVG}</div>
      <h1>正在准备钉钉授权</h1>
      <p class="subtitle">
        平台正在为你的账号启动<strong>专属执行环境</strong>，随后会自动打开钉钉官方授权页面。<br />
        首次连接约需 <strong>1-3 分钟</strong>，请保持本窗口打开。
      </p>

      <ol class="steps">
        <li class="step active">
          <span class="step-icon"><span class="spinner" aria-hidden="true"></span></span>
          <span class="step-label">启动你的专属执行环境</span>
        </li>
        <li class="step">
          <span class="step-icon">2</span>
          <span class="step-label">向钉钉申请授权码</span>
        </li>
        <li class="step">
          <span class="step-icon">3</span>
          <span class="step-label">跳转钉钉官方授权页</span>
        </li>
      </ol>

      <div class="tip" role="note">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 16v-4"></path>
          <path d="M12 8h.01"></path>
        </svg>
        <span>首次授权较慢是因为要为你启动独立容器；后续再连接会在几秒内打开钉钉页面。</span>
      </div>
    </section>
  </main>
</body>
</html>`;
}
