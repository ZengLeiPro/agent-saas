/**
 * 阿里云短信服务（dysmsapi）SendSms 实现
 *
 * 不引官方 SDK（体积大、依赖多），直接按阿里云 RPC API 签名规范（v1.0，HMAC-SHA1）
 * 用 node 内置 crypto/fetch 实现。文档：help.aliyun.com「短信服务 > API > SendSms」。
 *
 * 凭据约定：AccessKey ID / 签名 / 模板 code 走 config（auth.selfSignup.sms），
 * AccessKey Secret 只走 env `AGENT_SMS_ACCESS_KEY_SECRET`，不进 config 文件。
 */

import { createHmac, randomUUID } from "node:crypto";
import type { SmsSender } from "./verificationService.js";

const SMS_ENDPOINT = "https://dysmsapi.aliyuncs.com/";
const REQUEST_TIMEOUT_MS = 10_000;

/** 阿里云 RPC 签名要求的 RFC3986 percent-encode（encodeURIComponent 补几个字符） */
function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

export interface AliyunSmsSenderOptions {
  accessKeyId: string;
  accessKeySecret: string;
  /** 短信签名名称（控制台审核通过的签名，如「开沿科技」） */
  signName: string;
  /** 模板 CODE（如 SMS_123456789，模板内容形如「您的验证码是${code}」） */
  templateCode: string;
}

interface SendSmsResponse {
  Code?: string;
  Message?: string;
  RequestId?: string;
  BizId?: string;
}

export class AliyunSmsSender implements SmsSender {
  readonly providerName = "aliyun";

  constructor(private readonly options: AliyunSmsSenderOptions) {}

  async sendCode(phone: string, code: string): Promise<void> {
    const params: Record<string, string> = {
      Action: "SendSms",
      Version: "2017-05-25",
      Format: "JSON",
      AccessKeyId: this.options.accessKeyId,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      SignatureNonce: randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      PhoneNumbers: phone,
      SignName: this.options.signName,
      TemplateCode: this.options.templateCode,
      TemplateParam: JSON.stringify({ code }),
    };

    const canonicalized = Object.keys(params)
      .sort()
      .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
      .join("&");
    const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonicalized)}`;
    const signature = createHmac("sha1", `${this.options.accessKeySecret}&`)
      .update(stringToSign)
      .digest("base64");

    const url = `${SMS_ENDPOINT}?Signature=${percentEncode(signature)}&${canonicalized}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let body: SendSmsResponse;
    try {
      const res = await fetch(url, { signal: controller.signal });
      body = (await res.json()) as SendSmsResponse;
    } finally {
      clearTimeout(timer);
    }

    if (body.Code !== "OK") {
      // 常见错误码：isv.BUSINESS_LIMIT_CONTROL（触发运营商频控）、
      // isv.SMS_SIGNATURE_ILLEGAL（签名未审核）、isv.AMOUNT_NOT_ENOUGH（欠费）
      throw new Error(
        `阿里云短信发送失败：${body.Code ?? "UNKNOWN"} ${body.Message ?? ""}`.trim(),
      );
    }
  }
}
