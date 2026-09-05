/**
 * TeX → MathML（KaTeX，本地渲染，无网络）。
 *
 * 选 MathML 而不是 KaTeX 的 HTML 输出：HTML 输出必须配 katex.min.css 与
 * KaTeX 字体文件才有正确排版，移动端既不能远程加载字体，也不打算把字体
 * 打进包；MathML 由 WebKit / Chromium 原生排版，零 CSS 零字体零脚本。
 *
 * katex 目前是仓库根 node_modules 的提升依赖（web 声明、mobile 未声明），
 * metro 的 nodeModulesPaths 含 monorepo 根因此可解析；正式化需要在
 * mobile/package.json 里补 katex 依赖（见任务回报的依赖缺口）。
 * 动态 import 让它不进启动路径，解析或渲染失败时调用侧降级为等宽源码。
 */
import type { KatexOptions } from 'katex';

interface KatexModule {
  renderToString: (tex: string, options?: KatexOptions) => string;
}

let loader: Promise<KatexModule> | null = null;

function loadKatex(): Promise<KatexModule> {
  loader ??= import('katex').then((mod) => {
    const candidate = mod as unknown as { default?: KatexModule } & Partial<KatexModule>;
    const resolved = candidate.default ?? (candidate as KatexModule);
    if (typeof resolved?.renderToString !== 'function') {
      throw new Error('katex renderToString 不可用');
    }
    return resolved;
  });
  return loader;
}

/**
 * 渲染成 MathML 片段。`trust: false` + `strict: 'ignore'`：
 * 不放行 \href / \url 等可注入外链的宏，未知命令按原样忽略而不是抛错。
 */
export async function renderTexToMathml(tex: string, displayMode: boolean): Promise<string> {
  const katex = await loadKatex();
  return katex.renderToString(tex, {
    output: 'mathml',
    displayMode,
    throwOnError: true,
    strict: 'ignore',
    trust: false,
  });
}
