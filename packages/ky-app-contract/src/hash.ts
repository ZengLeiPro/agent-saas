/** 附录 I：`aph`、manifest digest 与恒定时间比较。 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { canonicalize } from './jcs.js';

/** lowercase hex(sha256(utf8(input)))。 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

/**
 * `aph = lowercase hex(sha256(utf8(JCS({cap, input}))))`，64 字符。
 * `approval:required` 的能力必须以恒定时间比较 SAT claim `aph` 与本值（§4.3）。
 */
export function aph(params: { cap: string; input: unknown }): string {
  return sha256Hex(canonicalize({ cap: params.cap, input: params.input }));
}

/** manifest digest：对整个 manifest 对象同法计算，登记与 `dig` 比对都用它（§4.1、§6.1）。 */
export function manifestDigest(manifest: unknown): string {
  return sha256Hex(canonicalize(manifest));
}

const HEX_64 = /^[0-9a-f]{64}$/u;

/** 是否为合法的 64 字符小写 hex 摘要。 */
export function isDigestHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_64.test(value);
}

/**
 * 恒定时间比较两个 hex 字符串。长度不等直接 false（不进入 timingSafeEqual，
 * 因为它对长度不等会抛错）。非 hex 输入一律 false。
 */
export function timingSafeEqualHex(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length || left.length === 0) return false;
  if (left.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]+$/u.test(left) || !/^[0-9a-fA-F]+$/u.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
