/**
 * 极简 prompt 模板渲染器
 *
 * 支持两种语法：
 *   {{VAR}}                           — 变量替换
 *   {{#IF_FLAG}}...{{/IF_FLAG}}       — 条件块（vars.IF_FLAG 为 truthy 时保留块体）
 *
 * 不引模板引擎是有意的——这里的 prompt 模板只需要替换和条件，加更多语法会让
 * workspace-shared/prompts/*.md 失去"普通 markdown，编辑器友好"的属性。
 *
 * 模板从 `<sharedDir>/prompts/<name>.md` 读取；命中后缓存在进程内，重启或调用
 * `clearPromptCache()` 才会重读。开发期想热更可以直接重启 dev server。
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const cache = new Map<string, string>();

export type PromptVars = Record<string, string | number | boolean | null | undefined>;

export function renderPrompt(template: string, vars: PromptVars): string {
  // 先处理条件块（嵌套不支持——当前模板用不到，引入会复杂化）
  let result = template.replace(
    /\{\{#(IF_\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, key: string, body: string) => (vars[key] ? body : ''),
  );
  // 再处理变量。未定义的占位符保留原样，让模板调试时一眼能看出漏配。
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return match;
    return String(v);
  });
  return result;
}

export function loadPrompt(sharedDir: string, name: string): string {
  const cacheKey = `${sharedDir}::${name}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const path = resolve(sharedDir, 'prompts', `${name}.md`);
  const content = readFileSync(path, 'utf-8').trim();
  cache.set(cacheKey, content);
  return content;
}

export function loadAndRenderPrompt(sharedDir: string, name: string, vars: PromptVars): string {
  return renderPrompt(loadPrompt(sharedDir, name), vars);
}

export function clearPromptCache(): void {
  cache.clear();
}
