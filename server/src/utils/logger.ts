/**
 * 统一的日志管理模块
 *
 * 使用方式:
 *   import { createLogger } from './utils/logger.js';
 *   const logger = createLogger('Chat');
 *   logger.info('消息处理完成');
 *   logger.error('处理失败', error);
 */

import { getRequestContext } from './requestContext.js';

// ============================================
// ANSI 颜色码
// ============================================
const colors = {
  reset: '\x1b[0m',
  // 前景色
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  // 样式
  bold: '\x1b[1m',
  dim: '\x1b[2m',
} as const;

// 日志级别定义
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// 日志级别配置
const levelConfig: Record<LogLevel, { color: string; label: string; priority: number }> = {
  debug: { color: colors.gray, label: 'DEBUG', priority: 0 },
  info: { color: colors.cyan, label: 'INFO', priority: 1 },
  warn: { color: colors.yellow, label: 'WARN', priority: 2 },
  error: { color: colors.red, label: 'ERROR', priority: 3 },
};

// 模块颜色映射（循环使用）
const moduleColors = [
  colors.cyan,
  colors.green,
  colors.magenta,
  colors.blue,
  colors.yellow,
];

// 全局配置
interface LoggerConfig {
  /** 是否启用颜色输出 */
  colorEnabled: boolean;
  /** 是否显示时间戳 */
  showTimestamp: boolean;
  /** 最低日志级别 */
  minLevel: LogLevel;
  /** 时间戳格式: 'full' | 'time' | 'none' */
  timestampFormat: 'full' | 'time' | 'none';
}

// 默认配置
const defaultConfig: LoggerConfig = {
  // 仅 TTY 显式为 true 才启用颜色；stdout 重定向到日志文件时 isTTY 为 undefined,
  // 旧逻辑 `!== false` 会把 undefined 也判为真,导致 ANSI 颜色码被写进日志文件,
  // 后续 grep/解析必须先 strip,故收紧为 `=== true`。
  colorEnabled: process.stdout.isTTY === true,
  showTimestamp: false,  // 默认不显示时间戳（保持简洁）
  minLevel: 'debug',
  timestampFormat: 'time',
};

// 全局配置实例
let globalConfig: LoggerConfig = { ...defaultConfig };

// 模块颜色缓存
const moduleColorCache = new Map<string, string>();
let colorIndex = 0;

/**
 * 获取模块的颜色
 */
function getModuleColor(module: string): string {
  if (!moduleColorCache.has(module)) {
    moduleColorCache.set(module, moduleColors[colorIndex % moduleColors.length]);
    colorIndex++;
  }
  return moduleColorCache.get(module)!;
}

/**
 * 格式化时间戳
 */
function formatTimestamp(format: LoggerConfig['timestampFormat']): string {
  if (format === 'none') return '';

  const now = new Date();
  if (format === 'time') {
    return now.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
  // full format
  return now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * 格式化日志消息
 */
function formatMessage(
  level: LogLevel,
  module: string,
  message: string,
  config: LoggerConfig,
  runId?: string,
  sessionId?: string,
): string {
  const { colorEnabled, showTimestamp, timestampFormat } = config;
  const levelCfg = levelConfig[level];
  const moduleColor = getModuleColor(module);

  const parts: string[] = [];

  // 时间戳
  if (showTimestamp && timestampFormat !== 'none') {
    const timestamp = formatTimestamp(timestampFormat);
    if (colorEnabled) {
      parts.push(`${colors.dim}${timestamp}${colors.reset}`);
    } else {
      parts.push(timestamp);
    }
  }

  // 级别标签
  if (colorEnabled) {
    parts.push(`${levelCfg.color}[${levelCfg.label}]${colors.reset}`);
  } else {
    parts.push(`[${levelCfg.label}]`);
  }

  // 模块标签
  if (colorEnabled) {
    parts.push(`${moduleColor}[${module}]${colors.reset}`);
  } else {
    parts.push(`[${module}]`);
  }

  // 请求追踪 ID（runId 取时间戳前缀 13 位；sessionId 取 uuid 前 8 位,
  // 足够人辨识 + 用作 grep 前缀过滤）。
  // 格式：(runId) | (runId/sessionId8) | (s:sessionId8)
  if (runId || sessionId) {
    const shortRun = runId ? runId.slice(0, 13) : '';
    const shortSession = sessionId ? sessionId.slice(0, 8) : '';
    const trace = runId && sessionId
      ? `${shortRun}/${shortSession}`
      : runId
        ? shortRun
        : `s:${shortSession}`;
    if (colorEnabled) {
      parts.push(`${colors.dim}(${trace})${colors.reset}`);
    } else {
      parts.push(`(${trace})`);
    }
  }

  // 消息内容
  parts.push(message);

  return parts.join(' ');
}

/**
 * 检查日志级别是否应该输出
 */
function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return levelConfig[level].priority >= levelConfig[minLevel].priority;
}

/**
 * Logger 类型定义
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** 输出分隔线 */
  separator(char?: string, length?: number): void;
  /** 创建子 logger（带有子模块名） */
  child(subModule: string): Logger;
}

/**
 * 创建 Logger 实例
 *
 * @param module 模块名称，如 'Chat', 'DingTalk', 'TTS'
 * @param config 可选的配置覆盖
 * @returns Logger 实例
 *
 * @example
 * const logger = createLogger('Chat');
 * logger.info('服务启动');
 * logger.error('处理失败', error);
 *
 * // 创建子 logger
 * const sessionLogger = logger.child('Session');
 * sessionLogger.debug('Session created');
 */
export function createLogger(module: string, config?: Partial<LoggerConfig>): Logger {
  // 只保存实例级覆盖，每次调用时从 globalConfig 合并，确保 configureLogger() 生效
  const instanceOverrides = config;

  const getEffective = (): LoggerConfig => ({ ...globalConfig, ...instanceOverrides });

  const log = (level: LogLevel, message: string, ...args: unknown[]): void => {
    const effective = getEffective();
    if (!shouldLog(level, effective.minLevel)) return;

    const ctx = getRequestContext();
    const formattedMessage = formatMessage(level, module, message, effective, ctx?.runId, ctx?.sessionId);

    // 选择输出方法
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

    if (args.length > 0) {
      logFn(formattedMessage, ...args);
    } else {
      logFn(formattedMessage);
    }
  };

  return {
    debug: (message: string, ...args: unknown[]) => log('debug', message, ...args),
    info: (message: string, ...args: unknown[]) => log('info', message, ...args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
    error: (message: string, ...args: unknown[]) => log('error', message, ...args),

    separator(char = '━', length = 40): void {
      const effective = getEffective();
      const line = char.repeat(length);
      if (effective.colorEnabled) {
        const moduleColor = getModuleColor(module);
        console.log(`${moduleColor}${line}${colors.reset}`);
      } else {
        console.log(line);
      }
    },

    child(subModule: string): Logger {
      return createLogger(`${module}:${subModule}`, config);
    },
  };
}

/**
 * 配置全局 Logger 设置
 *
 * @example
 * configureLogger({ showTimestamp: true, minLevel: 'info' });
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

/**
 * 获取当前全局配置
 */
export function getLoggerConfig(): Readonly<LoggerConfig> {
  return { ...globalConfig };
}

// ============================================
// 预定义的模块 Logger（便捷导出）
// ============================================

/** 主服务 Logger */
export const serverLogger = createLogger('Server');

/** 聊天处理 Logger */
export const chatLogger = createLogger('Chat');

/** 钉钉集成 Logger */
export const dingtalkLogger = createLogger('DingTalk');

/** TTS 语音 Logger */
export const ttsLogger = createLogger('TTS');

/** 会话管理 Logger */
export const sessionLogger = createLogger('Session');

/** API 调用 Logger */
export const apiLogger = createLogger('API');

/** 上传处理 Logger */
export const uploadLogger = createLogger('Upload');

/** 语音发送 Logger */
export const voiceLogger = createLogger('Voice');

/** Cron 调度 Logger */
export const cronLogger = createLogger('Cron');

/** 数据持久化 Logger */
export const dataLogger = createLogger('Data');

/** 认证 Logger */
export const authLogger = createLogger('Auth');
