/**
 * 定制软件宿主（WP4，规范 §5）。
 *
 * **Phase A 是占位实现**：只负责「壳里有这么一块区域、它被惰性挂载、切走只隐藏不卸载」。
 * 握手状态机（`loading → attesting → ready → init → active`）、消息路由器、401 续期、
 * `agent.open` / `link.open`、积分耗尽降级、frame-busting、失败文案全表都在 Phase B，
 * 按 `packages/ky-app-cli/assets/shell.html` 逐条移植，本文件此处不预先猜实现。
 *
 * 本文件被 `lazy()` 加载：startup 只有 1 个 JS chunk 且 `largestJsGzipBytes`
 * 距上限只剩约 95 KB，AppHost 及其依赖（消息路由器、握手状态机、契约包）
 * 一旦进主 chunk 必然撑破预算。
 */
import { useState } from 'react';

import type { AppsRouteState } from '@/lib/urlSync';

/**
 * 挂载序号：每次真正 mount 自增一次。
 * §5.5 承诺「切走再切回保留页面与滚动位置」，实现手段是隐藏而不是卸载；
 * 把序号渲染到 DOM 上，测试才能钉死「切走再切回没有重挂载」，
 * 否则这条承诺只能靠肉眼看。
 */
let mountSequence = 0;

export interface AppHostProps {
  /** 当前壳路由；为 null 表示壳还没停在任何安装实例上。 */
  appsRoute: AppsRouteState | null;
}

export function AppHost({ appsRoute }: AppHostProps) {
  const [mountId] = useState(() => {
    mountSequence += 1;
    return mountSequence;
  });

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      data-testid="app-host"
      data-app-host-mount={mountId}
      data-installation-id={appsRoute?.installationId ?? ''}
      data-app-path={appsRoute?.appPath ?? ''}
    >
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {appsRoute ? '正在打开定制软件…' : '请选择一个定制软件'}
      </div>
    </div>
  );
}

export default AppHost;
