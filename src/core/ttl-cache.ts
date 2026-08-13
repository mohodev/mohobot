export class TtlCache<T> {
  #value?: T;
  #expiresAt = 0;
  constructor(readonly ttlMs: number) {}
  get(): T | undefined { return Date.now() < this.#expiresAt ? this.#value : undefined; }
  set(value: T): T { this.#value = value; this.#expiresAt = Date.now() + this.ttlMs; return value; }
  clear(): void { this.#value = undefined; this.#expiresAt = 0; }
}
