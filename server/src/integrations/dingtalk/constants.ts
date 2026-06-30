/**
 * 钉钉模块常量集中管理
 *
 * 将散布在各文件中的常量集中到此处，方便维护和修改。
 */

// ============ AI Card ============

export const AI_CARD_TEMPLATE_ID = 'b2df0e87-1c48-4838-af39-a3e474e29c93.schema';

/** AI Card 流式更新节流间隔（毫秒） */
export const AI_CARD_THROTTLE = 300;

// ============ 消息去重 ============

/** 消息去重 TTL（毫秒），5 分钟 */
export const MESSAGE_DEDUP_TTL = 5 * 60 * 1000;

// ============ 钉钉 API ============

export const DINGTALK_API = 'https://api.dingtalk.com';

/** 钉钉 API 请求超时（毫秒） */
export const API_TIMEOUT_MS = 15_000;

// ============ 媒体处理 ============

/** 默认媒体文件最大大小（20MB） */
export const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024;

/** 音频文件扩展名 */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'amr', 'ogg', 'aac', 'flac', 'm4a'];

/**
 * 媒体标记正则
 *
 * 注意：所有正则均带 /g 标志，仅适合 matchAll() 和 replace() 使用。
 * 请勿直接使用 test() 或 exec()，否则会因 lastIndex 状态导致间歇性匹配失败。
 */
export const FILE_MARKER_PATTERN = /\[FILE\](\{.*?\})\[\/FILE\]/g;
export const VIDEO_MARKER_PATTERN = /\[VIDEO\](\{.*?\})\[\/VIDEO\]/g;
export const AUDIO_MARKER_PATTERN = /\[AUDIO\](\{.*?\})\[\/AUDIO\]/g;

/** 用于 AI Card 流式更新中清理标记（不显示给用户） */
export const MEDIA_MARKER_CLEAN_RE = /\[(?:FILE|VIDEO|AUDIO)\]\{.*?\}\[\/(?:FILE|VIDEO|AUDIO)\]/g;

/** 本地图片路径检测正则（Markdown 语法中的本地路径） */
export const LOCAL_IMAGE_RE = /!\[([^\]]*)\]\(((?:file:\/\/\/|MEDIA:|attachment:\/\/\/)[^)]+|\/(?:tmp|var|private|Users|home|root)[^)]+|[A-Za-z]:[\\/ ][^)]+)\)/g;

/** 纯文本中的本地图片路径（非 markdown 语法） */
export const BARE_IMAGE_PATH_RE = /`?((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp))`?/gi;
