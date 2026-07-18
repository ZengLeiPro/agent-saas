/**
 * runtimeErrorMessage.ts 补充测试（既有 runtimeErrorMessage.test.ts 之外的未覆盖分支）
 *
 * 重点补：
 * - isModelRequestFailure 的匹配/不匹配/空值分支
 * - formatRuntimeFailureMessage 的模型 5xx 分支、默认分支、优先级顺序
 */
import { describe, expect, it } from 'vitest';
import {
  isModelRequestFailure,
  isInsufficientCreditsFailure,
  formatRuntimeFailureMessage,
  DEFAULT_RUNTIME_FAILURE_MESSAGE,
  MODEL_REQUEST_FAILURE_MESSAGE,
  INSUFFICIENT_CREDITS_FAILURE_MESSAGE,
} from './runtimeErrorMessage';

describe('isModelRequestFailure（补充分支）', () => {
  it('匹配 Responses API / Chat Completions 的 HTTP 5xx', () => {
    expect(isModelRequestFailure('Responses API HTTP 500 upstream error')).toBe(true);
    expect(isModelRequestFailure('Chat Completions HTTP 503')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isModelRequestFailure('responses api http 502')).toBe(true);
  });

  it('4xx 不算模型请求失败', () => {
    expect(isModelRequestFailure('Responses API HTTP 400 bad request')).toBe(false);
  });

  it('无匹配文本 / null / undefined / 空串返回 false', () => {
    expect(isModelRequestFailure('some random error')).toBe(false);
    expect(isModelRequestFailure(null)).toBe(false);
    expect(isModelRequestFailure(undefined)).toBe(false);
    expect(isModelRequestFailure('')).toBe(false);
  });
});

describe('isInsufficientCreditsFailure（补充空值分支）', () => {
  it('null / undefined 返回 false', () => {
    expect(isInsufficientCreditsFailure(null)).toBe(false);
    expect(isInsufficientCreditsFailure(undefined)).toBe(false);
  });
});

describe('formatRuntimeFailureMessage（补充分支与优先级）', () => {
  it('模型 5xx → 模型请求错误文案', () => {
    expect(formatRuntimeFailureMessage('Responses API HTTP 500')).toBe(MODEL_REQUEST_FAILURE_MESSAGE);
  });

  it('积分不足优先于模型 5xx（两者同时出现）', () => {
    const both = '组织积分余额不足; Responses API HTTP 500';
    expect(formatRuntimeFailureMessage(both)).toBe(INSUFFICIENT_CREDITS_FAILURE_MESSAGE);
  });

  it('其它错误 / null / undefined → 默认异常中断文案', () => {
    expect(formatRuntimeFailureMessage('unexpected crash')).toBe(DEFAULT_RUNTIME_FAILURE_MESSAGE);
    expect(formatRuntimeFailureMessage(null)).toBe(DEFAULT_RUNTIME_FAILURE_MESSAGE);
    expect(formatRuntimeFailureMessage(undefined)).toBe(DEFAULT_RUNTIME_FAILURE_MESSAGE);
  });
});
