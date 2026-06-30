/**
 * Logger Module Tests
 *
 * 测试日志模块的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  configureLogger,
  getLoggerConfig,
  type Logger,
} from '../utils/logger.js';

describe('Logger', () => {
  // 保存原始的 console 方法
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  beforeEach(() => {
    // Mock console methods
    console.log = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    // Restore console methods
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  });

  describe('createLogger', () => {
    it('should create a logger with all log methods', () => {
      const logger = createLogger('Test');

      expect(logger).toHaveProperty('debug');
      expect(logger).toHaveProperty('info');
      expect(logger).toHaveProperty('warn');
      expect(logger).toHaveProperty('error');
      expect(logger).toHaveProperty('separator');
      expect(logger).toHaveProperty('child');

      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.separator).toBe('function');
      expect(typeof logger.child).toBe('function');
    });

    it('should log messages at different levels', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      // debug, info 使用 console.log
      expect(console.log).toHaveBeenCalledTimes(2);
      // warn 使用 console.warn
      expect(console.warn).toHaveBeenCalledTimes(1);
      // error 使用 console.error
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should include module name in log output', () => {
      const logger = createLogger('MyModule', { colorEnabled: false });

      logger.info('test message');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[MyModule]')
      );
    });

    it('should include level label in log output', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.info('test message');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[INFO]')
      );
    });

    it('should include the actual message in log output', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.info('hello world');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('hello world')
      );
    });

    it('should pass additional arguments to console', () => {
      const logger = createLogger('Test', { colorEnabled: false });
      const extraData = { key: 'value' };

      logger.info('message with data', extraData);

      expect(console.log).toHaveBeenCalledWith(
        expect.any(String),
        extraData
      );
    });
  });

  describe('child logger', () => {
    it('should create a child logger with combined module name', () => {
      const parentLogger = createLogger('Parent', { colorEnabled: false });
      const childLogger = parentLogger.child('Child');

      childLogger.info('test');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[Parent:Child]')
      );
    });

    it('should inherit parent logger configuration', () => {
      const parentLogger = createLogger('Parent', {
        colorEnabled: false,
        minLevel: 'warn',
      });
      const childLogger = parentLogger.child('Child');

      // debug 和 info 应该被过滤掉
      childLogger.debug('debug');
      childLogger.info('info');

      expect(console.log).not.toHaveBeenCalled();

      // warn 应该正常输出
      childLogger.warn('warn');

      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe('separator', () => {
    it('should output a separator line', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.separator();

      expect(console.log).toHaveBeenCalled();
    });

    it('should use custom character for separator', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.separator('-', 20);

      expect(console.log).toHaveBeenCalledWith('--------------------');
    });

    it('should use custom length for separator', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.separator('=', 10);

      expect(console.log).toHaveBeenCalledWith('==========');
    });
  });

  describe('log level filtering', () => {
    it('should filter logs below minimum level', () => {
      const logger = createLogger('Test', {
        colorEnabled: false,
        minLevel: 'warn',
      });

      logger.debug('should not appear');
      logger.info('should not appear');

      expect(console.log).not.toHaveBeenCalled();

      logger.warn('should appear');
      expect(console.warn).toHaveBeenCalled();

      logger.error('should appear');
      expect(console.error).toHaveBeenCalled();
    });

    it('should show all logs when minLevel is debug', () => {
      const logger = createLogger('Test', {
        colorEnabled: false,
        minLevel: 'debug',
      });

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(console.log).toHaveBeenCalledTimes(2); // debug + info
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should only show error when minLevel is error', () => {
      const logger = createLogger('Test', {
        colorEnabled: false,
        minLevel: 'error',
      });

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');

      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();

      logger.error('error');
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('timestamp', () => {
    it('should include timestamp when showTimestamp is true', () => {
      const logger = createLogger('Test', {
        colorEnabled: false,
        showTimestamp: true,
        timestampFormat: 'time',
      });

      logger.info('test');

      // 检查输出包含时间格式 (HH:MM:SS)
      expect(console.log).toHaveBeenCalledWith(
        expect.stringMatching(/\d{2}:\d{2}:\d{2}/)
      );
    });

    it('should not include timestamp when showTimestamp is false', () => {
      const logger = createLogger('Test', {
        colorEnabled: false,
        showTimestamp: false,
      });

      logger.info('test');

      // 输出不应该包含时间格式
      const callArg = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(callArg).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('configureLogger', () => {
    it('should update global logger configuration', () => {
      const originalConfig = getLoggerConfig();

      configureLogger({ showTimestamp: true });

      const newConfig = getLoggerConfig();
      expect(newConfig.showTimestamp).toBe(true);

      // Restore original config
      configureLogger(originalConfig);
    });

    it('should merge with existing configuration', () => {
      const originalConfig = getLoggerConfig();

      configureLogger({ minLevel: 'warn' });

      const config = getLoggerConfig();
      expect(config.minLevel).toBe('warn');
      // Other properties should remain
      expect(config).toHaveProperty('colorEnabled');
      expect(config).toHaveProperty('timestampFormat');

      // Restore original config
      configureLogger(originalConfig);
    });
  });

  describe('getLoggerConfig', () => {
    it('should return a copy of the global configuration', () => {
      const config1 = getLoggerConfig();
      const config2 = getLoggerConfig();

      // Should be equal but not the same object
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });

    it('should not allow modification of the returned config to affect global config', () => {
      const config = getLoggerConfig() as any;
      config.minLevel = 'error';

      const newConfig = getLoggerConfig();
      // Global config should not be affected
      expect(newConfig.minLevel).not.toBe('error');
    });
  });

  describe('color output', () => {
    it('should include ANSI color codes when colorEnabled is true', () => {
      const logger = createLogger('Test', { colorEnabled: true });

      logger.info('test');

      // 检查输出包含 ANSI 转义序列
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('\x1b[')
      );
    });

    it('should not include ANSI color codes when colorEnabled is false', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.info('test');

      // 检查输出不包含 ANSI 转义序列
      const callArg = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(callArg).not.toContain('\x1b[');
    });
  });

  describe('edge cases', () => {
    it('should handle empty message', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.info('');

      expect(console.log).toHaveBeenCalled();
    });

    it('should handle special characters in message', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.info('Message with special chars: \n\t "quotes" \'single\'');

      expect(console.log).toHaveBeenCalled();
    });

    it('should handle unicode characters in module name', () => {
      const logger = createLogger('', { colorEnabled: false });

      logger.info('test message');

      expect(console.log).toHaveBeenCalled();
    });

    it('should handle very long messages', () => {
      const logger = createLogger('Test', { colorEnabled: false });
      const longMessage = 'a'.repeat(10000);

      logger.info(longMessage);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(longMessage)
      );
    });

    it('should handle null and undefined in extra arguments', () => {
      const logger = createLogger('Test', { colorEnabled: false });

      logger.info('message', null, undefined, { obj: true });

      expect(console.log).toHaveBeenCalledWith(
        expect.any(String),
        null,
        undefined,
        { obj: true }
      );
    });
  });
});
