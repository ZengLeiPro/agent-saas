import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * 登录/注册共用门面（设计稿 B1「浅色光晕」，assets/20260714，07-14 拍板）：
 * 品牌网格 + 双光晕背景、开开品牌区（开沿 AI 员工 + slogan）、备案 footer。
 * 表单区由 children 提供，两页只维护各自的表单逻辑。
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-white px-4 py-8"
      style={{ paddingTop: "var(--sat)" }}
    >
      {/* 品牌网格：radial mask 向下淡出，只铺上半屏 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(189,204,255,0.38) 1px, transparent 1px), linear-gradient(90deg, rgba(189,204,255,0.38) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          WebkitMaskImage: "radial-gradient(120% 90% at 50% 0%, #000 20%, transparent 78%)",
          maskImage: "radial-gradient(120% 90% at 50% 0%, #000 20%, transparent 78%)",
        }}
      />
      {/* 双光晕：左上主光 + 右下辅光，缓慢漂移 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 -top-52 h-[640px] w-[640px] animate-glow-drift-a rounded-full blur-[72px]"
        style={{
          background:
            "radial-gradient(circle, rgba(147,169,255,0.55), rgba(189,204,255,0.25) 55%, transparent 72%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-44 -right-36 h-[560px] w-[560px] animate-glow-drift-b rounded-full blur-[72px]"
        style={{
          background:
            "radial-gradient(circle, rgba(221,229,255,0.85), rgba(221,229,255,0.35) 55%, transparent 72%)",
        }}
      />
      {/* 顶部品牌渐变 hairline */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-brand-600 to-transparent"
      />

      <div className="relative w-full max-w-[420px]">
        <Card className="animate-login-rise rounded-3xl border-brand-100 bg-white/80 shadow-[0_14px_32px_rgba(46,86,225,0.16),0_40px_90px_-30px_rgba(46,86,225,0.28)] backdrop-blur-lg">
          <CardContent className="px-8 pb-7 pt-10 sm:px-9">
            {/* 品牌区：开开 IP + 主品牌名（双层叙事 v2）+ slogan，登录/注册一致 */}
            <div className="mb-7 flex flex-col items-center text-center">
              <div className="mb-3.5 h-[84px] w-[84px] rounded-full bg-gradient-to-br from-brand-400 to-brand-700 p-[3px] shadow-[0_8px_20px_-6px_rgba(46,86,225,0.5)]">
                <img
                  src="/kaikai-avatar.png"
                  alt="开开"
                  className="h-full w-full rounded-full border-[2.5px] border-white"
                />
              </div>
              <h1 className="text-[22px] font-bold tracking-tight text-foreground">
                开沿 AI 员工
              </h1>
              <p className="mt-1.5 text-[13px] tracking-wide text-muted-foreground">
                每个岗位，一个 <span className="font-semibold text-brand-600">AI 同事</span>
              </p>
            </div>
            {children}
          </CardContent>
        </Card>

        <footer className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
          <p>© 2021–2026 福建开沿科技有限公司</p>
          <p>
            <a
              href="https://beian.miit.gov.cn/"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-brand-600"
            >
              闽ICP备2021018290号-1
            </a>
            <span className="mx-1.5">·</span>
            <a
              href="https://www.kaiyan.net/privacy/"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-brand-600"
            >
              隐私政策
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
