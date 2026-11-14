/** Buffers model deltas and emits natural sentence-sized Discord messages. */

const STREAM_SOFT_LIMIT = 180;
const STREAM_HARD_LIMIT = 480;

export class StreamingDelivery {
  #buffer = '';
  #sent = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly flush: (text: string, first: boolean) => Promise<boolean>) {}

  push(delta: string): void {
    this.#buffer += delta;
    if (this.#shouldFlush()) this.#enqueue(false);
  }

  async finish(): Promise<boolean> {
    this.#enqueue(true);
    await this.#tail;
    return this.#sent > 0;
  }

  get sent(): number { return this.#sent; }
  get received(): boolean { return this.#buffer.length > 0 || this.#sent > 0; }

  #shouldFlush(): boolean {
    if (this.#buffer.length >= STREAM_HARD_LIMIT) return true;
    return this.#buffer.length >= STREAM_SOFT_LIMIT && /[。！？!?…]\s*$/.test(this.#buffer);
  }

  #enqueue(final: boolean): void {
    const text = this.#take(final);
    if (!text) return;
    this.#tail = this.#tail.then(async () => { if (await this.flush(text, this.#sent === 0)) this.#sent += 1; });
  }

  #take(final: boolean): string {
    const value = this.#buffer;
    if (!value.trim()) return '';
    let index = -1;
    if (!final) {
      for (const mark of ['。', '！', '？', '!', '?', '…', '\n']) index = Math.max(index, value.lastIndexOf(mark));
      if (index < 0 && value.length < STREAM_HARD_LIMIT) return '';
      if (index < 0) index = Math.min(STREAM_SOFT_LIMIT, value.length) - 1;
    } else index = value.length - 1;
    const text = value.slice(0, index + 1).trim();
    this.#buffer = value.slice(index + 1);
    return text;
  }
}
