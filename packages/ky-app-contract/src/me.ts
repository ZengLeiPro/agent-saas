/** 附录 C：`/ky/v1/me` 结构校验 + 语义校验。 */
import { validateMeSchema } from './schemas/index.js';
import { PathError, normalizeAppPath } from './path.js';
import { MENU_MAX_DEPTH } from './types/constants.js';
import type { MeResponse, MenuItem } from './types/me.js';
import type { Manifest } from './types/manifest.js';

export interface MeValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * 语义校验（附录 C）：
 * - `key` 全树唯一；深度 ≤ 3；父必有 ≥ 1 子；
 * - `landing` 非空时必须 ∈ 叶子 `path`，menus 为空时必须为 null；
 * - `capabilities[].id` 不重复，传入 manifest 时必须 ∈ manifest 能力集合；
 * - 所有 `path` 过 §5.2 共用规范化函数。
 */
export function validateMe(me: unknown, manifest?: Manifest): MeValidationResult {
  const schemaResult = validateMeSchema(me);
  if (!schemaResult.ok) {
    return { ok: false, errors: schemaResult.errors.map((item) => `schema: ${item}`) };
  }

  const errors: string[] = [];
  const value = me as MeResponse;
  const keys = new Set<string>();
  const leafPaths = new Set<string>();

  walkMenus(value.menus, 1, '', { keys, leafPaths, errors });
  checkLanding(value, leafPaths, errors);
  checkCapabilities(value, manifest, errors);

  return { ok: errors.length === 0, errors };
}

interface WalkContext {
  keys: Set<string>;
  leafPaths: Set<string>;
  errors: string[];
}

function walkMenus(
  menus: MenuItem[],
  depth: number,
  parentLabel: string,
  context: WalkContext,
): void {
  for (const menu of menus) {
    const label = parentLabel === '' ? `menus[${menu.key}]` : `${parentLabel} > ${menu.key}`;
    if (depth > MENU_MAX_DEPTH) {
      context.errors.push(`${label}: 菜单深度 ${depth} 超过 ${MENU_MAX_DEPTH}`);
      continue;
    }
    if (context.keys.has(menu.key)) context.errors.push(`${label}: key 在全树内重复`);
    context.keys.add(menu.key);

    let normalized: string | undefined;
    try {
      normalized = normalizeAppPath(menu.path);
    } catch (error) {
      context.errors.push(`${label}.path 不满足 §5.2：${(error as PathError).message}`);
    }

    const children = menu.children;
    if (children === undefined) {
      if (normalized !== undefined) context.leafPaths.add(normalized);
      continue;
    }
    if (children.length === 0) {
      context.errors.push(`${label}: 声明了 children 但为空，父节点必须有 ≥ 1 个可见子节点`);
      continue;
    }
    walkMenus(children, depth + 1, label, context);
  }
}

function checkLanding(me: MeResponse, leafPaths: Set<string>, errors: string[]): void {
  if (me.menus.length === 0) {
    if (me.landing !== null) errors.push('landing: menus 为空时必须是 null');
    return;
  }
  if (me.landing === null) {
    errors.push('landing: menus 非空时不得为 null');
    return;
  }
  let normalized: string;
  try {
    normalized = normalizeAppPath(me.landing);
  } catch (error) {
    errors.push(`landing 不满足 §5.2：${(error as PathError).message}`);
    return;
  }
  if (!leafPaths.has(normalized)) errors.push(`landing ${me.landing} 不是任何叶子菜单的 path`);
}

function checkCapabilities(me: MeResponse, manifest: Manifest | undefined, errors: string[]): void {
  const seen = new Set<string>();
  const declared = manifest
    ? new Set(manifest.capabilities.map((capability) => capability.id))
    : undefined;
  for (const capability of me.capabilities) {
    if (seen.has(capability.id)) errors.push(`capabilities: ${capability.id} 重复`);
    seen.add(capability.id);
    if (declared && !declared.has(capability.id)) {
      errors.push(`capabilities: ${capability.id} 不在 manifest 中`);
    }
  }
}
