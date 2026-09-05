/**
 * §3.1 / §5.5 令牌存储：**只在内存**。
 *
 * 绝不写 `localStorage` / `sessionStorage` / cookie —— 子帧在跨源下拥有完整自身源
 * （§5.1 `allow-same-origin`），任何持久化都会把 5 分钟 TTL 的 SAT 变成长期凭据。
 *
 * `version` 用于「旧续期结果不覆盖新令牌」的原子替换：续期发起时抓一份 `version`，
 * 应答回来时若 `version` 已经前进，说明期间有更新的令牌落地，旧结果直接丢弃。
 */
export interface KyTokenSnapshot {
  token: string;
  /** SAT `exp`，秒级 epoch。 */
  tokenExp: number;
  version: number;
}

export class TokenStore {
  #token: string | null = null;
  #tokenExp: number | null = null;
  #version = 0;

  get version(): number {
    return this.#version;
  }

  get tokenExp(): number | null {
    return this.#tokenExp;
  }

  read(): KyTokenSnapshot | null {
    if (this.#token === null || this.#tokenExp === null) return null;
    return { token: this.#token, tokenExp: this.#tokenExp, version: this.#version };
  }

  /** 写入新令牌并推进版本号，返回新版本号。 */
  write(token: string, tokenExp: number): number {
    this.#token = token;
    this.#tokenExp = tokenExp;
    this.#version += 1;
    return this.#version;
  }

  /**
   * 版本号原子替换：只有当版本号仍停在发起续期时的快照上才写入。
   * 返回是否真的写入。
   */
  writeIfCurrent(token: string, tokenExp: number, expectedVersion: number): boolean {
    if (this.#version !== expectedVersion) return false;
    this.write(token, tokenExp);
    return true;
  }

  clear(): void {
    this.#token = null;
    this.#tokenExp = null;
    this.#version += 1;
  }

  /** 距离过期还剩多少毫秒；没有令牌时返回 `null`。 */
  remainingMs(nowMs: number): number | null {
    if (this.#tokenExp === null) return null;
    return this.#tokenExp * 1000 - nowMs;
  }
}
