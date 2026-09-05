/**
 * §5.3「重复 `(type,id)` 不丢弃而是重放缓存的同一应答，副作用只执行一次」。
 *
 * 缓存的是**处理中的 Promise**而不是结果：壳在应答还没算出来时重发同一条消息，
 * 重复项会挂在同一个 Promise 上，等它落定后重放同一份应答，副作用仍然只跑一次。
 */
export class ReplyCache<TValue> {
  readonly #max: number;
  readonly #entries = new Map<string, TValue>();

  constructor(max = 100) {
    this.#max = max;
  }

  static key(type: string, id: string): string {
    return `${type}|${id}`;
  }

  get(key: string): TValue | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    // 命中即刷新 LRU 顺序。
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: TValue): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
