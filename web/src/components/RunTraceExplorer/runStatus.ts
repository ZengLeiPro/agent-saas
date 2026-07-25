export function isRunFailureStatus(status: string): boolean {
  return status === "failed" || status === "orphaned";
}

export function resolveRunFailureReason(
  status: string,
  statusReason: string | null | undefined,
  runFinishedError?: string,
): string | null {
  if (!isRunFailureStatus(status)) return null;
  return statusReason ?? runFinishedError ?? null;
}

/**
 * 失败原因 → 「查看同类失败」用的检索关键词。
 *
 * 后端是 `status_reason ILIKE '%关键词%'` 的子串匹配（`platformObservability.ts:954`），
 * 所以关键词必须是**其他同类失败里也会原样出现**的稳定片段，否则点进去只会看到自己一条。
 * 规则：
 *   1. 只取第一段（遇到 `: （ [ {` 或换行就停）——后半段通常是本次特有的上下文；
 *   2. 在第一个「4 位以上数字 / 8 位以上十六进制」处截断——超时毫秒数、端口、run/trace id
 *      每次都不同，带上它们等于自己跟自己比；3 位数字（HTTP 状态码）保留，它是有效特征；
 *   3. 压缩空白、去掉尾部标点，最长 60 字符（后端上限 200，这里更保守，宁窄不宽）；
 *   4. 结果短于 4 字符时退回原文前 60 字符——用 1-2 个字符去扫全库没有意义。
 */
export function failureQueryKeyword(reason: string | null | undefined): string | null {
  const raw = (reason ?? "").trim();
  if (!raw) return null;
  // 先按分段符切（换行必须在压缩空白之前处理，否则第一段就没了），再压缩空白
  const head = raw.split(/[\n\r:：(（[{]/)[0] ?? raw;
  const idAt = head.search(/\d{4,}|[0-9a-f]{8,}/i);
  const cut = idAt > 0 ? head.slice(0, idAt) : head;
  const cleaned = cut.replace(/\s+/g, " ").replace(/[\s,，.。;；、\-_/|]+$/, "").trim();
  const keyword = cleaned.length >= 4 ? cleaned : raw.replace(/\s+/g, " ").trim();
  const sliced = keyword.slice(0, 60).trim();
  return sliced.length > 0 ? sliced : null;
}

export function resolveRunCancellationReason(
  status: string,
  statusReason: string | null | undefined,
): string | null {
  return status === "cancelled" ? statusReason ?? null : null;
}
