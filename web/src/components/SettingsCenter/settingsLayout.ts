/**
 * 设置工作区统一布局令牌。
 *
 * 设置侧栏不复用会话侧栏的可拖拽宽度，避免在路由切换时因布局模式和本地缓存
 * 变化而产生横向抖动。内容区则统一占满成员页所使用的可用宽度。
 */
/** PC 主界面与设置工作区共用同一条一级侧栏宽度基线。 */
export const DESKTOP_PRIMARY_SIDEBAR_WIDTH = 256;

export const SETTINGS_SIDEBAR_WIDTH = DESKTOP_PRIMARY_SIDEBAR_WIDTH;
export const SETTINGS_CONTENT_WIDTH = 'w-full';
export const SETTINGS_PRODUCT_SURFACE_CLASS = 'settings-product-surface';

export type SettingsPageWidth = 'compact' | 'standard' | 'wide';

/**
 * 页面宽度按信息密度分级；同一页面的标题、标签和内容必须放在同一个容器内。
 */
export function settingsPageWidthClass(width: SettingsPageWidth) {
  if (width === 'compact') return 'mx-auto w-full max-w-6xl';
  if (width === 'standard') return 'mx-auto w-full max-w-7xl';
  return 'w-full';
}
