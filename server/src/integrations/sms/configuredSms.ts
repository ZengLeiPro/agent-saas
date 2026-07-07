import type { SelfSignupConfig } from "../../app/config.js";
import { AliyunSmsSender } from "./aliyunSms.js";
import {
  DevSmsSender,
  VerificationCodeService,
  type SmsSender,
} from "./verificationService.js";

export const DEFAULT_SMS_SEND_CODE_IP_LIMIT_PER_MINUTE = 5;
export const DEFAULT_SMS_VERIFY_IP_LIMIT_PER_MINUTE = 5;

interface RateBucket {
  startedAt: number;
  count: number;
}

export interface BuildSmsSenderResult {
  sender?: SmsSender;
  error?: string;
}

export function optionalConfigValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildSmsSender(
  cfg: SelfSignupConfig,
  accessKeySecret: string | undefined,
): BuildSmsSenderResult {
  const sms = cfg.sms;
  if (sms?.provider === "aliyun") {
    const accessKeyId = optionalConfigValue(sms.accessKeyId);
    const signName = optionalConfigValue(sms.signName);
    const templateCode = optionalConfigValue(sms.templateCode);
    const missing = [
      accessKeyId ? undefined : "sms.accessKeyId",
      signName ? undefined : "sms.signName",
      templateCode ? undefined : "sms.templateCode",
      accessKeySecret ? undefined : "SMS AccessKey Secret（vault 或 env）",
    ].filter((item): item is string => Boolean(item));
    if (missing.length > 0) {
      return {
        error: `阿里云短信配置缺失：${missing.join(", ")}`,
      };
    }

    return {
      sender: new AliyunSmsSender({
        accessKeyId: accessKeyId!,
        accessKeySecret: accessKeySecret!,
        signName: signName!,
        templateCode: templateCode!,
      }),
    };
  }
  return { sender: new DevSmsSender() };
}

export function buildVerificationCodeService(
  cfg: SelfSignupConfig,
  sender: SmsSender,
): VerificationCodeService {
  const sms = cfg.sms;
  return new VerificationCodeService({
    sender,
    codeTtlMs: (sms?.codeTtlSeconds ?? 300) * 1000,
    cooldownMs: (sms?.cooldownSeconds ?? 60) * 1000,
    dailyLimitPerPhone: sms?.dailyLimitPerPhone,
    maxVerifyAttempts: sms?.maxVerifyAttempts,
    universalCode: sender.providerName === "dev"
      ? process.env.AGENT_SMS_DEV_CODE
      : undefined,
  });
}

export function createIpLimiter(maxPerWindow: number, windowMs: number) {
  const buckets = new Map<string, RateBucket>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of buckets) {
      if (now - bucket.startedAt > windowMs) buckets.delete(ip);
    }
  }, windowMs * 2);
  timer.unref();
  return (ip: string): boolean => {
    const now = Date.now();
    const bucket = buckets.get(ip);
    if (!bucket || now - bucket.startedAt > windowMs) {
      buckets.set(ip, { startedAt: now, count: 1 });
      return true;
    }
    if (bucket.count >= maxPerWindow) return false;
    bucket.count += 1;
    return true;
  };
}
