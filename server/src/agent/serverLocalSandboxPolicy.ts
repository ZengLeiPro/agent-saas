import { isAbsolute, relative, resolve } from 'node:path';

import type { WorkspaceRef } from './toolRuntime.js';

export function assertSandboxReadAllowed(workspace: WorkspaceRef, fullPath: string): void {
  const deniedPath = workspace.sandboxPolicy?.denyRead.find((entry) =>
    isPathInside(resolve(entry), fullPath),
  );
  if (deniedPath) throw new Error(`server-local sandbox denied path: ${deniedPath}`);
}

/**
 * server-local Shell 的字符串级 sandbox 防御（P5 升级，2026-06-22）。
 *
 * 历史实现：`command.includes(resolve(entry))` 只挡"字面完整路径"命中，对常见
 * 路径变形（双斜杠 //、单点 /./、尾随斜杠）一刀不挡。
 *
 * 本升级覆盖：
 *   - 字面完整路径（baseline）
 *   - 双斜杠变形：/Users//admin/workspace 等同于 /Users/admin/workspace
 *   - 单点 /./ 变形：/Users/./admin/workspace 等同
 *   - 尾随斜杠
 *
 * 已知**未挡**的 bypass（honest limitations，需要更深防御才能挡，详见
 * docs/tenant-isolation-e2e-test-2026-06-21.md 疑点 2）：
 *   - 动态构造：`cat $HOME/../kaiyan/admin/MEMORY.md` / `cat $(echo /Users/...)`
 *     / `P=/path; cat $P/...` —— 需要 shell parse + 变量展开后再 normalize
 *   - 引号分段：`cat "/Users"/admin/workspace` —— 需要 shell-quote tokenize
 *   - symlink：`ln -s /Users/admin/... /tmp/x; cat /tmp/x/MEMORY.md` —— 需要
 *     realpath 二次校验子进程访问的真实路径
 *   - base64/heredoc/find -exec 等
 *
 * 当前 toolRuntime gate（toolRuntime.ts:608-626）已经把非平台用户挡在
 * server-local 之外（fail-closed），所以这条 guard 实际是给平台 admin 自防
 * prompt-injection 的兜底——平台 admin 是开沿员工，跨组织读取在产品语义下合规。
 * 完整覆盖动态构造 bypass 需要 shell-quote / realpath + sandbox 重设计，
 * 留作后续 ticket。
 */
export function findDeniedPathMention(
  workspace: WorkspaceRef,
  command: string,
): string | undefined {
  const denyEntries = workspace.sandboxPolicy?.denyRead ?? [];
  for (const entry of denyEntries) {
    const normalized = resolve(entry);
    for (const variant of pathBypassVariants(normalized)) {
      if (command.includes(variant)) return entry;
    }
  }
  return undefined;
}

/**
 * 生成一个 path 的常见变形列表，覆盖 normalize 后等价但字面不同的 bypass。
 *
 * 注意只生成 path 本身的变形，不做 shell 语义展开（那需要 shell-quote）。
 * 任何"动态构造路径"bypass（$VAR、$(...)、symlink）这一层挡不住。
 */
function pathBypassVariants(normalized: string): string[] {
  const variants = new Set<string>();
  variants.add(normalized);
  // 1. 双斜杠：/Users/admin/workspace → /Users//admin//workspace
  //    cat /Users//admin/workspace 在 shell 下与 cat /Users/admin/workspace 等同
  variants.add(normalized.replace(/\//g, '//'));
  // 2. 单点 /./：/Users/admin/workspace → /Users/./admin/./workspace
  //    cat /Users/./admin/./workspace 在 shell 下与 cat /Users/admin/workspace 等同
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length > 0) {
    variants.add(`/${segments.map((s) => `./${s}`).join('/')}`);
    variants.add(`/${segments.join('/./')}`);
  }
  // 3. 尾随斜杠：cat /Users/admin/workspace/MEMORY.md 与 cat /Users/admin/workspace//MEMORY.md
  //    虽然 includes 字面命中已挡，但若 deny entry 是目录形态而命令访问其下文件，加 / 触发更多匹配场景
  variants.add(`${normalized}/`);
  return [...variants];
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
