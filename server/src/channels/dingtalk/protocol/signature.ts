/**
 * 钉钉 Webhook 签名验证
 *
 * 验证钉钉 HTTP 回调请求的签名，防止伪造请求。
 * 签名算法：Base64(HmacSHA256(timestamp + "\n" + appSecret, appSecret))
 */

import crypto from 'crypto';

/**
 * 验证钉钉 Webhook 回调的签名
 *
 * @param timestamp - 请求头中的 timestamp
 * @param sign - 请求头中的 sign
 * @param appSecret - 机器人的 appSecret
 * @param maxAge - 签名最大有效期（毫秒），默认 1 小时
 */
export function verifyDingtalkSignature(
  timestamp: string | undefined,
  sign: string | undefined,
  appSecret: string,
  maxAge: number = 3600_000,
): { valid: boolean; reason?: string } {
  if (!timestamp || !sign) {
    return { valid: false, reason: 'Missing timestamp or sign header' };
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return { valid: false, reason: 'Invalid timestamp format' };
  }

  const now = Date.now();
  if (Math.abs(now - ts) > maxAge) {
    return { valid: false, reason: `Timestamp expired: ${Math.abs(now - ts)}ms old` };
  }

  // 计算预期签名
  const stringToSign = `${timestamp}\n${appSecret}`;
  const expectedSign = crypto
    .createHmac('sha256', appSecret)
    .update(stringToSign)
    .digest('base64');

  // 安全比较（防止时序攻击）
  const signBuffer = Buffer.from(sign);
  const expectedBuffer = Buffer.from(expectedSign);

  if (signBuffer.length !== expectedBuffer.length) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  if (!crypto.timingSafeEqual(signBuffer, expectedBuffer)) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  return { valid: true };
}
