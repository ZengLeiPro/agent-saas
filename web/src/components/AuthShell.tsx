import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { AuthFlowLines } from "@/components/AuthFlowLines";

/**
 * 登录/注册共用门面（07-20 改版，对标 LangSmith 登录页布局）：
 * 桌面端左右分栏——左栏品牌叙事（wordmark + 大标题 + 副标题 + 实名客户墙），
 * 右栏登录卡片；背景为浅蓝渐变 + 线束汇流动画（小球沿线滑动，各线速度不同）。
 * 移动端退化为单卡片布局，品牌区收进卡片内。
 * 表单区由 children 提供，登录/注册两页只维护各自的表单逻辑。
 */

/** 已授权公开的实名客户（口径与官网 kaiyan.net /cases/ REAL_CASES 一致，勿自行增减） */
const TRUSTED_CUSTOMERS = ["瑞鹰", "嗨玩购", "经典世家", "德林智能", "汉荣石业", "华恒"];

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative min-h-screen overflow-hidden bg-gradient-to-br from-[#F5F8FF] via-[#EAF1FF] to-[#DFE9FD]"
      style={{ paddingTop: "var(--sat)" }}
    >
      {/* 左上亮部 + 右下辅光：撑起浅蓝底的空间层次 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-52 -top-56 h-[700px] w-[700px] rounded-full blur-[80px]"
        style={{
          background:
            "radial-gradient(circle, rgba(255,255,255,0.9), rgba(221,229,255,0.4) 55%, transparent 75%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-48 -right-40 h-[600px] w-[600px] rounded-full blur-[80px]"
        style={{
          background:
            "radial-gradient(circle, rgba(147,169,255,0.28), rgba(189,204,255,0.16) 55%, transparent 72%)",
        }}
      />
      {/*
       * 线束只延伸到卡片左缘：中段最大偏移 12px；窄桌面左栏收缩时取
       * calc(44vw - 440px)，超宽屏百分比 padding 增长时取 calc(200px - 6vw)。
       * 用 clip-path 硬切，避免动画和背景层引入 JS 测量或 resize 抖动。
       */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden lg:block"
        style={{
          clipPath:
            "inset(0 calc(50% - min(12px, calc(44vw - 440px), calc(200px - 6vw))) 0 0)",
        }}
      >
        <AuthFlowLines className="h-full w-full" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1280px] items-center justify-center px-4 py-8 lg:gap-6 lg:px-[6%]">
        {/* 左栏品牌叙事（lg+）：整体上移让背景主干线从副标题与客户墙之间的空白穿过 */}
        <div className="hidden flex-1 flex-col lg:flex lg:max-w-[440px] lg:-translate-y-16">
          <div className="flex items-center gap-3">
            <img
              src="/kaikai-avatar.png"
              alt="开开"
              className="h-10 w-10 rounded-full border-2 border-white shadow-[0_4px_12px_-2px_rgba(46,86,225,0.35)]"
            />
            <span className="text-[21px] font-bold tracking-tight text-brand-900">
              开沿 AI 员工
            </span>
          </div>
          <h1 className="mt-10 text-[52px] font-bold leading-[1.16] tracking-tight text-brand-900">
            每个岗位，
            <br />
            一个 <span className="text-brand-600">AI 同事</span>
          </h1>
          <p className="mt-6 text-[15px] leading-7 tracking-wide text-slate-600">
            按业务场景打通钉钉与现有系统，不推倒重做。
            <br />
            让每个岗位，都配上真正能干活的 AI 同事。
          </p>
          {/* 客户墙：留出大间距，让背景主干线从中穿过（对标原稿中线） */}
          <div className="mt-24">
            <p className="text-[13px] tracking-[0.08em] text-slate-500">他们都在用</p>
            <div className="mt-5 grid max-w-[440px] grid-cols-3 gap-x-10 gap-y-4">
              {TRUSTED_CUSTOMERS.map((name) => (
                <span
                  key={name}
                  className="whitespace-nowrap text-[17px] font-semibold tracking-wide text-brand-900/75"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* 右栏：登录/注册卡片 */}
        <div className="w-full max-w-[420px] lg:w-[440px] lg:max-w-none lg:shrink-0">
          <Card data-auth-card className="animate-login-rise rounded-3xl border-brand-100 bg-white/85 shadow-[0_14px_32px_rgba(46,86,225,0.14),0_40px_90px_-30px_rgba(46,86,225,0.25)] backdrop-blur-lg">
            <CardContent className="px-8 pb-7 pt-9 sm:px-9">
              {/* 移动端品牌区：桌面端品牌叙事移到左栏，此处隐藏 */}
              <div className="mb-7 flex flex-col items-center text-center lg:hidden">
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
    </div>
  );
}
