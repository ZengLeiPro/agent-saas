/** 记忆控制命令共用的文本安全检查；与已删除的 digest 投影无关。 */

const SECRET_TEXT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b(?:sk|pk|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bLTAI[A-Za-z0-9]{12,}\b/g,
];

export const MEMORY_COMMAND_INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /忽略(上述|之前|以上|所有)?(的)?(规则|指令|系统提示)/,
  /(必须|请|立即)?(执行|运行|调用)[^。]{0,20}(命令|工具|shell|脚本)/i,
  /上传[^。]{0,30}(MEMORY|记忆|文件)[^。]{0,20}(到|至)/i,
  /\bignore (all |previous |above )?(instructions|rules)\b/i,
  /<\/?(?:system|developer|assistant)>/i,
];

export function checkMemoryTextSafety(text: string): string | null {
  if (redactSecrets(text) !== text) return '内容疑似包含密钥/凭据，不会写入记忆';
  for (const pattern of MEMORY_COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(text)) return '内容含命令性/注入性文本，不会写入记忆';
  }
  return null;
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_TEXT_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/** 归一化指纹：小写、去空白与标点，用于 tombstone 粗匹配。 */
export function normalizeFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 200);
}
