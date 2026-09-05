import { createHash, createHmac } from 'node:crypto';

/**
 * 火山引擎 OpenAPI 请求签名（HMAC-SHA256，SigV4 变体）。
 *
 * 只实现管控面 POST + JSON body 这一种形态：Canonical Query 固定为 Action/Version，
 * SignedHeaders 固定为 content-type;host;x-content-sha256;x-date。
 * 与 Python 参考实现对拍过（真实 GetAFPUsage 200），测试向量见同名测试。
 */
export interface VolcengineOpenApiSignInput {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  host: string;
  action: string;
  version: string;
  body: string;
  /** 覆盖签名时间，仅测试用。 */
  date?: Date;
}

export interface VolcengineSignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** 火山 X-Date 格式：YYYYMMDDTHHMMSSZ。 */
export function formatVolcengineDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

export function signVolcengineOpenApiRequest(
  input: VolcengineOpenApiSignInput,
): VolcengineSignedRequest {
  const xDate = formatVolcengineDate(input.date ?? new Date());
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const query = `Action=${encodeURIComponent(input.action)}&Version=${encodeURIComponent(input.version)}`;
  const canonicalHeaderValues: Record<string, string> = {
    'content-type': 'application/json',
    host: input.host,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
  };
  const signedHeaderNames = Object.keys(canonicalHeaderValues).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${canonicalHeaderValues[name]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, payloadHash].join(
    '\n',
  );
  const credentialScope = `${shortDate}/${input.region}/${input.service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join(
    '\n',
  );
  const signingKey = [shortDate, input.region, input.service, 'request'].reduce<Buffer | string>(
    (key, part) => hmacSha256(key, part),
    input.secretAccessKey,
  );
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');
  return {
    url: `https://${input.host}/?${query}`,
    headers: {
      'Content-Type': 'application/json',
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      Authorization:
        `HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: input.body,
  };
}
