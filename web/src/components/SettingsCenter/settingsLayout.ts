/**
 * 设置工作区统一布局令牌。
 *
 * 设置侧栏不复用会话侧栏的可拖拽宽度，避免在路由切换时因布局模式和本地缓存
 * 变化而产生横向抖动。内容区则统一占满成员页所使用的可用宽度。
 */
export const SETTINGS_SIDEBAR_WIDTH = 256;
export const SETTINGS_CONTENT_WIDTH = 'w-full';
export const SETTINGS_PRODUCT_SURFACE_CLASS = 'settings-product-surface';
