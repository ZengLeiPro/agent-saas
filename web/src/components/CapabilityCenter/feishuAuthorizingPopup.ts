/** 飞书 device flow 启动期间的品牌等待页；样式全部内联，随后会被官方授权页替换。 */
export function writeFeishuAuthorizingPopup(popup: Window): void {
  try {
    popup.document.open();
    popup.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>正在连接飞书 · 开沿</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fb;--card:#fff;--text:#0f172a;--muted:#64748b;--blue:#3370ff;--line:rgba(15,23,42,.08)}
@media(prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#111827;--text:#e2e8f0;--muted:#94a3b8;--line:rgba(148,163,184,.16)}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.65 "PingFang SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{width:min(420px,100%);padding:36px 32px 30px;border:1px solid var(--line);border-radius:20px;background:var(--card);box-shadow:0 20px 45px -20px rgba(51,112,255,.35);text-align:center}
.logo{position:relative;width:72px;height:72px;margin:0 auto 20px;display:grid;place-items:center;border-radius:22px;background:#fff;box-shadow:0 0 0 1px #dbe7ff,0 12px 24px -12px rgba(51,112,255,.5)}
.logo:after{content:"";position:absolute;inset:-6px;border:2px solid var(--blue);border-radius:27px;animation:pulse 1.8s ease-out infinite}.mark{font-size:24px;font-weight:750;letter-spacing:-2px;color:#3370ff}.mark i{font-style:normal;color:#00b8d9}
h1{margin:0 0 8px;font-size:20px}.sub{margin:0 0 24px;color:var(--muted)}ol{list-style:none;margin:0;padding:0;display:grid;gap:10px;text-align:left}.step{display:flex;align-items:center;gap:12px;padding:8px 4px;color:#94a3b8}.step:first-child{color:var(--blue);font-weight:600}.dot{width:22px;height:22px;display:grid;place-items:center;border:1.5px solid currentColor;border-radius:50%;font-size:12px}.step:first-child .dot{background:var(--blue);border-color:var(--blue);color:#fff}.spin{width:11px;height:11px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:spin .85s linear infinite}.tip{margin-top:20px;padding:10px 12px;border-radius:12px;background:rgba(51,112,255,.1);color:#245bdb;font-size:12.5px;text-align:left}
@keyframes pulse{70%,100%{transform:scale(1.12);opacity:0}}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.logo:after,.spin{animation:none}}
</style>
</head>
<body><main class="card" role="status" aria-live="polite">
  <div class="logo" aria-hidden="true"><span class="mark">飞<i>书</i></span></div>
  <h1>正在准备飞书授权</h1>
  <p class="sub">平台正在启动你的专属执行环境，随后会自动打开<strong>飞书官方授权页面</strong>。请保持本窗口打开。</p>
  <ol>
    <li class="step"><span class="dot"><span class="spin"></span></span><span>启动你的专属执行环境</span></li>
    <li class="step"><span class="dot">2</span><span>向飞书申请一次性授权链接</span></li>
    <li class="step"><span class="dot">3</span><span>跳转飞书官方授权页</span></li>
  </ol>
  <div class="tip">你的飞书用户 Token 只保存在独立工作区，浏览器与平台数据库都不会保存它。</div>
</main></body></html>`);
    popup.document.close();
  } catch {
    try {
      popup.document.title = "正在连接飞书";
      popup.document.body.textContent = "正在打开飞书官方授权页面…";
    } catch {
      /* popup 可能已被浏览器关闭。 */
    }
  }
}
