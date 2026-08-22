/**
 * 工具执行的结构化事实（ToolResultMetadata）
 *
 * 与 `ToolPresentation`（给人看的中文摘要）并存，分工是硬的：
 * - presentation：文案，会随产品措辞调整，**不该被程序解析**。
 * - metadata：原值，程序据此判定（✓/✗ 徽标、失败统计），**不该被直接渲染成句子**。
 *
 * 服务端产出方是 `extractToolResultMetadata`（server/src/agent/toolPresentationBuilder.ts），
 * 已按工具做过白名单。但本模块仍必须独立校验一遍——数据经过 JSONL 落盘，
 * 文件可能被手改、可能来自旧版本、可能来自 fork，这里是不可信边界。
 *
 * 校验一律「丢弃不合格项」而不是抛错：徽标缺一个字段可以退回既有判定链，
 * 渲染层因为一段脏 metadata 崩掉是不可接受的。
 */

/** 值只收标量。嵌套对象一律丢弃——那等于又一段需要解析的文本。 */
export type ToolResultMetadataValue = number | boolean | string;

export type ToolResultMetadata = Record<string, ToolResultMetadataValue>;

/** 键数量上限：白名单最长的一项（Shell）是 8 个，留一倍余量 */
const METADATA_KEY_LIMIT = 16;
/** 普通执行枚举/标识保持短值；文件名允许覆盖主流文件系统的 255-byte 上限。 */
const METADATA_TEXT_LIMIT = 120;
const ARTIFACT_FILE_NAME_LIMIT = 512;
/** 键名上限：白名单里最长的是 `outputExceeded`(14) */
const METADATA_KEY_LENGTH_LIMIT = 40;

export function normalizeToolResultMetadata(raw: unknown): ToolResultMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result: ToolResultMetadata = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= METADATA_KEY_LIMIT) break;
    if (!key || key.length > METADATA_KEY_LENGTH_LIMIT) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      result[key] = value;
    } else if (typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      const textLimit = key === 'fileName' ? ARTIFACT_FILE_NAME_LIMIT : METADATA_TEXT_LIMIT;
      if (!trimmed || trimmed.length > textLimit) continue;
      result[key] = trimmed;
    } else {
      continue;
    }
    count += 1;
  }
  return count > 0 ? result : null;
}

/**
 * 退出码。仅在它是**整数**时返回——`null`（信号终止）与缺省都返回 undefined，
 * 让调用方回退到既有 isError 判定链，而不是把「没有退出码」当成 0。
 */
export function toolResultExitCode(metadata?: ToolResultMetadata): number | undefined {
  const value = metadata?.exitCode;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
